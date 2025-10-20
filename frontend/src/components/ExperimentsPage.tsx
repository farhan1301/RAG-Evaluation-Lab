import { useMemo, useState } from 'react';
import { Play, FileText } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { useDataset } from '../state/dataset';
import { usePipelines } from '../state/pipelines';
import { useExperimentResults } from '../state/experimentResults';
import {
  chunkDocumentsWithConfig,
  summarizeChunkGroups,
  type ParsedDocument,
  type DocumentChunkGroup,
  type DocumentChunk,
} from '../lib/chunking';
import { upsertChunks, answerQuestion, judgeAnswers } from '../lib/backend';
import type { DatasetTask } from '../types/dataset';
import type { Pipeline } from '../types/pipeline';
import type {
  AnswerDetail,
  ExperimentPipelineResult,
  ExperimentRun,
  PipelineMetrics,
  JudgingSummary,
  RetrievedChunk,
} from '../types/experiment';
import { METRIC_DEFINITIONS } from '../types/experiment';

interface ExperimentsPageProps {
  darkMode: boolean;
  onNext: () => void;
}

type Stage = 'idle' | 'chunking' | 'answering' | 'judging' | 'complete';

const EMBEDDING_COST_PER_1K_TOKENS: Record<string, number> = {
  'text-embedding-3-small': 0.00002,
  'text-embedding-3-large': 0.00013,
  'text-embedding-ada-002': 0.00010,
};

const CHAT_COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.00015, output: 0.00060 },
  'gpt-4o': { input: 0.00250, output: 0.01000 },
  'gpt-4o-mini-2024-07-18': { input: 0.00015, output: 0.00060 },
  'gpt-4-turbo': { input: 0.01000, output: 0.03000 },
  'gpt-3.5-turbo': { input: 0.00050, output: 0.00150 },
};

const DEFAULT_EMBEDDING_RATE = 0.0001;
const DEFAULT_CHAT_PRICING = { input: 0.0015, output: 0.0020 };

const normalizeModelKey = (model?: string) => model?.toLowerCase().trim() ?? '';

const estimateEmbeddingCost = (model: string, tokens: number) => {
  const rate =
    EMBEDDING_COST_PER_1K_TOKENS[normalizeModelKey(model)] ?? DEFAULT_EMBEDDING_RATE;
  return (tokens / 1000) * rate;
};

const estimateChatCost = (
  model: string,
  usage: { promptTokens: number; completionTokens: number }
) => {
  const pricing =
    CHAT_COST_PER_1K_TOKENS[normalizeModelKey(model)] ?? DEFAULT_CHAT_PRICING;
  return (
    (usage.promptTokens / 1000) * pricing.input +
    (usage.completionTokens / 1000) * pricing.output
  );
};

const computePercentile = (values: number[], percentile: number) => {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(percentile * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index];
};

interface TaskResult {
  taskId: string;
  question: string;
  expectedAnswer: string;
  answer: string;
  matches: Array<{
    id: string;
    score: number;
    text: string;
    documentName?: string;
  }>;
  latencyMs?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

const formatTimestamp = () =>
  new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const DEFAULT_PIPELINE: Pipeline = {
  id: 'default-pipeline',
  name: 'Default Pipeline',
  chunking: {
    strategy: 'recursive',
    chunkSize: 500,
    overlap: 50,
  },
  embedding: { model: 'text-embedding-3-small' },
  retriever: { topK: 5, deduplicate: true },
  reranker: { enabled: false, model: 'cohere-rerank' },
  llm: { model: 'gpt-4o-mini', temperature: 0.3, maxTokens: 512 },
  judge: { model: 'gpt-4o-mini' },
};

const getEmbeddingVectorDim = (model: string) => {
  const normalized = model.toLowerCase();
  if (normalized.includes('large')) {
    return 3072;
  }
  if (normalized.includes('small')) {
    return 1536;
  }
  return 1536;
};

export function ExperimentsPage({ darkMode, onNext }: ExperimentsPageProps) {
  const { documents, tasks } = useDataset();
  const { pipelines } = usePipelines();
  const { setLatestRun } = useExperimentResults();

  const [stage, setStage] = useState<Stage>('idle');
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [taskResults, setTaskResults] = useState<TaskResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const activePipeline = pipelines[0] ?? DEFAULT_PIPELINE;
  const chunkConfig = activePipeline.chunking ?? DEFAULT_PIPELINE.chunking;
  const retrieverK = activePipeline.retriever?.topK ?? DEFAULT_PIPELINE.retriever.topK;
  const pipelineId = activePipeline.id ?? DEFAULT_PIPELINE.id;

  const readyDocuments = useMemo(
    () =>
      documents.filter(
        (doc) => doc.status === 'complete' && typeof doc.content === 'string' && doc.content.trim()
      ),
    [documents]
  );

  const readyTasks = useMemo(
    () => tasks.filter((task) => task.question.trim()),
    [tasks]
  );

  const resetState = () => {
    setStatusLog([]);
    setTaskResults([]);
    setProgress(0);
    setError(null);
  };

  const runExperiment = async () => {
    if (isRunning) {
      return;
    }

    if (!readyDocuments.length) {
      setError('Upload at least one document with parsed content before running an experiment.');
      return;
    }

    if (!readyTasks.length) {
      setError('Add at least one evaluation question before running an experiment.');
      return;
    }

    resetState();
    setIsRunning(true);
    setStage('chunking');

    const localLog: string[] = [];
    const appendLog = (message: string) => {
      localLog.push(message);
      setStatusLog((prev) => [...prev, message]);
    };

    const startedAt = new Date().toISOString();

    appendLog(`Experiment started at ${formatTimestamp()}.`);
    appendLog(`Using pipeline: ${activePipeline.name}.`);
    appendLog(`Preparing ${readyDocuments.length} document${readyDocuments.length === 1 ? '' : 's'} for chunking.`);

    try {
      const taskById = new Map(readyTasks.map((task) => [task.id, task]));

      const parsedDocuments: ParsedDocument[] = readyDocuments.map((doc) => ({
        id: doc.id,
        name: doc.name,
        source: doc.source,
        content: doc.content ?? '',
      }));

      const chunkGroups: DocumentChunkGroup[] = chunkDocumentsWithConfig(parsedDocuments, chunkConfig);
      const chunkSummary = summarizeChunkGroups(chunkGroups);
      const chunks: DocumentChunk[] = chunkGroups.flatMap((group) => group.chunks);
      const chunkCount = chunks.length;

      if (!chunks.length) {
        throw new Error('No chunks were generated from the uploaded documents.');
      }

      appendLog(
        `Generated ${chunkSummary.totalChunks} chunk${chunkSummary.totalChunks === 1 ? '' : 's'} ` +
          `(avg ${chunkSummary.averageChars} chars). Uploading to Qdrant…`
      );

      const chunkLookup = new Map<string, DocumentChunk>();
      chunkGroups.forEach((group) => {
        group.chunks.forEach((chunk) => {
          chunkLookup.set(chunk.id, chunk);
        });
      });

      await upsertChunks({
        pipelineId,
        chunks: chunks.map((chunk) => ({
          id: chunk.id,
          text: chunk.content,
          metadata: {
            documentId: chunk.documentId,
            documentName: chunk.documentName,
            documentSource: chunk.documentSource,
            charCount: chunk.charCount,
            tokenEstimate: chunk.tokenEstimate,
            strategy: chunk.strategy,
            chunkIndex: chunk.index,
          },
        })),
      });

      appendLog('Chunks embedded and stored in Qdrant successfully.');
      setProgress(30);

      setStage('answering');
      appendLog(`Retrieving answers for ${readyTasks.length} task${readyTasks.length === 1 ? '' : 's'}…`);

      const results: TaskResult[] = [];
      const answerDetails: AnswerDetail[] = [];
      const aggregatedSources = new Map<string, RetrievedChunk>();
      const uniqueChunkIds = new Set<string>();
      const answerLatencyByTask = new Map<string, number>();
      let totalAnswerPromptTokens = 0;
      let totalAnswerCompletionTokens = 0;
      let totalAnswerTokens = 0;
      let completed = 0;

      for (const task of readyTasks) {
        appendLog(`→ Retrieving context for: "${task.question}"`);

        const response = await answerQuestion({
          pipelineId,
          question: task.question,
          topK: retrieverK,
          model: activePipeline.llm?.model,
        });

        const matches = response.matches.map((match) => {
          const chunk = chunkLookup.get(match.id);
          const text = chunk?.content ?? (typeof match.payload?.text === 'string' ? match.payload.text : '');
          const documentName =
            chunk?.documentName ??
            (typeof match.payload?.documentName === 'string' ? match.payload.documentName : undefined);

          const retrievedChunk: RetrievedChunk = {
            id: match.id,
            documentId: chunk?.documentId ?? String(match.payload?.documentId ?? ''),
            documentName,
            documentSource: chunk?.documentSource,
            content: text,
            charCount: chunk?.charCount ?? text.length,
            tokenEstimate: chunk?.tokenEstimate ?? Math.max(1, Math.round(text.length / 4)),
            score: match.score ?? 0,
          };

          aggregatedSources.set(retrievedChunk.id, retrievedChunk);
          uniqueChunkIds.add(retrievedChunk.id);

          return {
            id: retrievedChunk.id,
            score: retrievedChunk.score,
            text,
            documentName,
          };
        });

        answerDetails.push({
          taskId: task.id,
          question: task.question,
          expectedAnswer: task.expectedAnswer,
          acceptanceRule: task.acceptanceRule,
          response: response.answer,
          citedChunkIds: matches.map((match) => match.id),
          latencyMs: response.latencyMs ?? 0,
          usage: response.usage,
        });

        results.push({
          taskId: task.id,
          question: task.question,
          expectedAnswer: task.expectedAnswer,
          answer: response.answer,
          matches,
          latencyMs: response.latencyMs ?? 0,
          usage: response.usage,
        });

        if (response.usage) {
          totalAnswerPromptTokens += response.usage.promptTokens ?? 0;
          totalAnswerCompletionTokens += response.usage.completionTokens ?? 0;
          totalAnswerTokens += response.usage.totalTokens ?? 0;
        }

        answerLatencyByTask.set(task.id, response.latencyMs ?? 0);
        completed += 1;
        const taskProgress = 30 + Math.round((completed / readyTasks.length) * 50);
        setProgress(taskProgress);
        appendLog(`✓ Answer drafted for task "${task.question}"`);
      }

      setTaskResults(results);
      setStage('judging');
      appendLog('Scoring answers with judge model for quality and groundedness…');
      setProgress(85);

      const judgeResponse = await judgeAnswers({
        pipelineId,
        model: activePipeline.judge?.model,
        evaluations: results.map((result) => {
          const task = taskById.get(result.taskId);
          return {
            taskId: result.taskId,
            question: result.question,
            answer: result.answer,
            expectedAnswer: task?.expectedAnswer,
            acceptanceRule: task?.acceptanceRule,
            context: result.matches.map((match) => match.text),
          };
        }),
      });

      appendLog(
        `Judge verdict: ${(judgeResponse.passRate * 100).toFixed(0)}% pass rate, ` +
          `groundedness ${(judgeResponse.averageScores.groundedness * 100).toFixed(0)}%.`
      );

      const completedAt = new Date().toISOString();

      const totalQuestions = readyTasks.length;
      const embeddingModel = activePipeline.embedding?.model ?? 'text-embedding-3-small';
      const vectorDim = getEmbeddingVectorDim(embeddingModel);
      const totalEmbeddingTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0);
      const embeddingCost = estimateEmbeddingCost(embeddingModel, totalEmbeddingTokens);

      const judgePromptTokens = judgeResponse.details.reduce(
        (sum, detail) => sum + (detail.usage?.promptTokens ?? 0),
        0
      );
      const judgeCompletionTokens = judgeResponse.details.reduce(
        (sum, detail) => sum + (detail.usage?.completionTokens ?? 0),
        0
      );
      const judgeTotalTokens = judgeResponse.details.reduce(
        (sum, detail) => sum + (detail.usage?.totalTokens ?? 0),
        0
      );

      const answerLatencyP95Ms = computePercentile(Array.from(answerLatencyByTask.values()), 0.95);
      const perTaskTotalLatencies = judgeResponse.details.map((detail) => {
        const answerLatency = answerLatencyByTask.get(detail.taskId) ?? 0;
        return answerLatency + detail.latencyMs;
      });
      const latencyP95Ms = computePercentile(perTaskTotalLatencies, 0.95);

      const answerUsageTotals = {
        promptTokens: totalAnswerPromptTokens,
        completionTokens: totalAnswerCompletionTokens,
      };
      const judgeUsageTotals = {
        promptTokens: judgePromptTokens,
        completionTokens: judgeCompletionTokens,
      };

      const answerModel = activePipeline.llm?.model ?? 'gpt-4o-mini';
      const judgeModel = activePipeline.judge?.model ?? answerModel;

      const answerCost = estimateChatCost(answerModel, answerUsageTotals);
      const judgeCost = estimateChatCost(judgeModel, judgeUsageTotals);

      const tokensUsed = totalAnswerTokens + judgeTotalTokens;
      const latencyP95Seconds = latencyP95Ms / 1000;
      const costPerQuery = totalQuestions
        ? (embeddingCost + answerCost + judgeCost) / totalQuestions
        : 0;

      const pipelineMetrics: PipelineMetrics = {
        precisionAt5: Number(judgeResponse.passRate.toFixed(2)),
        recallAt5: Number(judgeResponse.averageScores.contextPrecision.toFixed(2)),
        latencyP95: Number(latencyP95Seconds.toFixed(2)),
        groundedness: Number(judgeResponse.averageScores.groundedness.toFixed(2)),
        costPerQuery: Number(costPerQuery.toFixed(3)),
        tokensUsed: Math.round(tokensUsed),
      };

      const judgingSummary: JudgingSummary = {
        verdict: judgeResponse.verdict,
        passRate: Number(judgeResponse.passRate.toFixed(2)),
        averageScores: {
          relevance: Number(judgeResponse.averageScores.relevance.toFixed(2)),
          contextPrecision: Number(judgeResponse.averageScores.contextPrecision.toFixed(2)),
          groundedness: Number(judgeResponse.averageScores.groundedness.toFixed(2)),
        },
        tokensUsed: Math.round(judgeTotalTokens),
        latencyMs: judgeResponse.latencyMs,
        costUsd: Number(judgeCost.toFixed(3)),
        details: judgeResponse.details.map((detail) => ({
          taskId: detail.taskId,
          verdict: detail.verdict,
          scores: {
            relevance: Number(detail.scores.relevance.toFixed(2)),
            contextPrecision: Number(detail.scores.contextPrecision.toFixed(2)),
            groundedness: Number(detail.scores.groundedness.toFixed(2)),
          },
          rationale: detail.rationale,
          missingCriteria: detail.missingCriteria,
          latencyMs: detail.latencyMs,
          usage: detail.usage,
        })),
      };

      const baselinePipelineId = pipelines.find((pipeline) => pipeline.isBaseline)?.id ?? pipelineId;

      const pipelineResult: ExperimentPipelineResult = {
        pipelineId,
        pipelineName: activePipeline.name,
        pipelineSnapshot: activePipeline,
        metrics: pipelineMetrics,
        chunkingSummary: chunkSummary,
        embeddingSummary: {
          model: activePipeline.embedding?.model ?? 'text-embedding-3-small',
          vectorDim,
          totalChunks: chunkSummary.totalChunks,
          totalTokens: totalEmbeddingTokens,
          estimatedCostUsd: Number(embeddingCost.toFixed(4)),
        },
        retrievalSummary: {
          topK: retrieverK,
          deduplicate: activePipeline.retriever?.deduplicate ?? true,
          candidatePool: chunkCount,
          uniqueResults: uniqueChunkIds.size,
        },
        answeringSummary: {
          answer: results
            .map((result, index) => `Q${index + 1}: ${result.answer}`)
            .join('\n\n'),
          sources: Array.from(aggregatedSources.values()),
          tokensUsed: Math.round(totalAnswerTokens),
          latencyMs: Math.round(answerLatencyP95Ms),
          costUsd: Number(answerCost.toFixed(3)),
          details: answerDetails,
        },
        judgingSummary,
      };

      setStage('complete');
      setProgress(100);
      appendLog('Experiment complete. Review the answers below.');

      const bestByMetric = METRIC_DEFINITIONS.reduce<ExperimentRun['bestByMetric']>((acc, metric) => {
        acc[metric.key] = pipelineId;
        return acc;
      }, {});

      const runSummary: ExperimentRun = {
        id: `run-${Date.now()}`,
        name: `Experiment ${formatTimestamp()}`,
        startedAt,
        completedAt,
        statusLog: [...localLog],
        pipelines: [pipelineResult],
        bestByMetric,
        baselinePipelineId,
        tasksUsed: readyTasks,
      };

      setLatestRun(runSummary);
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : 'Unexpected error during experiment.';
      setError(message);
      setStage('idle');
      appendLog(`Error: ${message}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Experiment Runner</h2>
            <p className={`${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Upload documents, embed them with Qdrant, and evaluate answers with the LLM.
            </p>
          </div>
          <Button onClick={runExperiment} size="lg" className="gap-2" disabled={isRunning}>
            <Play size={20} />
            {isRunning ? 'Running…' : 'Start Experiment'}
          </Button>
        </div>

        {error && (
          <Card
            className={
              darkMode
                ? 'bg-red-950/40 border-red-500/60 text-red-200'
                : 'border-red-300 bg-red-50 text-red-700'
            }
          >
            <CardContent className="py-4 text-sm">{error}</CardContent>
          </Card>
        )}

        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Experiment Progress</CardTitle>
              <Badge variant={stage === 'complete' ? 'default' : stage === 'idle' ? 'outline' : 'secondary'}>
                {stage === 'idle' ? 'Not Started' : stage === 'complete' ? 'Complete' : 'In Progress'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span>Overall Progress</span>
                <span className="text-sm opacity-60">{progress}%</span>
              </div>
              <Progress value={progress} />
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="opacity-60">Current Stage:</span>
              <span className="capitalize">{stage}</span>
            </div>

            <div className={`max-h-48 overflow-y-auto text-sm ${darkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>
              {statusLog.length === 0 ? (
                <p className="opacity-60">Status updates will appear here once the experiment starts.</p>
              ) : (
                statusLog.map((entry, index) => (
                  <div key={index} className="flex items-start gap-2 py-1">
                    <span className="opacity-40">•</span>
                    <span>{entry}</span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle>Question &amp; Answer Review</CardTitle>
          </CardHeader>
          <CardContent>
            {taskResults.length === 0 ? (
              <p className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                Run an experiment to generate answers for your evaluation tasks.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Question</TableHead>
                    <TableHead>Expected</TableHead>
                    <TableHead>Model Answer</TableHead>
                    <TableHead>Top Context</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {taskResults.map((result) => (
                    <TableRow key={result.taskId}>
                      <TableCell className="align-top w-[25%]">
                        <div className="space-y-1">
                          <div className="font-medium">{result.question}</div>
                        </div>
                      </TableCell>
                      <TableCell className="align-top w-[20%]">
                        {result.expectedAnswer || '—'}
                      </TableCell>
                      <TableCell className="align-top w-[30%] whitespace-pre-wrap">
                        {result.answer}
                      </TableCell>
                      <TableCell className="align-top w-[25%]">
                        {result.matches.length === 0 ? (
                          <span className="opacity-60">No context retrieved.</span>
                        ) : (
                          <div className="space-y-2">
                            {result.matches.slice(0, 2).map((match) => (
                              <div
                                key={match.id}
                                className={`p-2 rounded border ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`}
                              >
                                <div className="flex items-center gap-2 text-xs uppercase tracking-wide opacity-60 mb-1">
                                  <FileText size={12} />
                                  <span>{match.documentName ?? 'Document'}</span>
                                  <span>Score: {match.score.toFixed(3)}</span>
                                </div>
                                <div className="text-xs whitespace-pre-wrap">
                                  {match.text.slice(0, 280)}
                                  {match.text.length > 280 ? '…' : ''}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {stage === 'complete' && (
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onNext}>
              View Report
            </Button>
            <Button onClick={onNext}>Continue</Button>
          </div>
        )}
      </div>
    </div>
  );
}
