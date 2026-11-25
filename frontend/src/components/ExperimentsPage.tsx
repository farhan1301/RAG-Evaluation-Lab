import { Link } from 'react-router';
import { reportPath } from './HistoryPage';
import { useEffect, useMemo, useState } from 'react';
import { Play, FileText } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { useRunnerInputs } from '../data/legacyRunner';
import { type TaskResult, useExperimentResults } from '../state/experimentResults';
import {
  chunkDocumentsWithConfig,
  summarizeChunkGroups,
  type ParsedDocument,
  type DocumentChunkGroup,
  type DocumentChunk,
} from '../lib/chunking';
import { upsertChunks, answerQuestion, judgeAnswers, parseDocument } from '../lib/backend';
import type { DatasetDocument } from '../types/dataset';
import type {
  AnswerDetail,
  ExperimentPipelineResult,
  ExperimentRun,
  PipelineMetrics,
  JudgingSummary,
  RetrievedChunk,
} from '../types/experiment';
import { METRIC_DEFINITIONS } from '../types/experiment';

const CHAT_COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  // Rates reflect the Standard tier prices (per 1M tokens) normalized to a 1K token basis.
  'gpt-5': { input: 0.00125, output: 0.0100 },
  'gpt-5-chat-latest': { input: 0.00125, output: 0.0100 },
  'gpt-5-codex': { input: 0.00125, output: 0.0100 },
  'gpt-5-mini': { input: 0.00025, output: 0.0020 },
  'gpt-5-nano': { input: 0.00005, output: 0.0004 },
  'gpt-5-pro': { input: 0.0150, output: 0.1200 },
  'gpt-4.1': { input: 0.0020, output: 0.0080 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
  'gpt-4o': { input: 0.0025, output: 0.0100 },
  'gpt-4o-2024-05-13': { input: 0.0050, output: 0.0150 },
  'gpt-4o-mini': { input: 0.00015, output: 0.00060 },
  'gpt-4o-mini-2024-07-18': { input: 0.00015, output: 0.00060 },
  'gpt-4-turbo': { input: 0.0100, output: 0.0300 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
};

const DEFAULT_CHAT_PRICING = { input: 0.0025, output: 0.0100 };

const normalizeModelKey = (model?: string) => model?.toLowerCase().trim() ?? '';

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

const formatTimestamp = () =>
  new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

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

export function ExperimentsPage() {
  const { documents, tasks, pipelines, unavailable } = useRunnerInputs();
  const {
    latestRun, setLatestRun, stage, setStage, statusLog, setStatusLog,
    taskResultsByPipeline, setTaskResultsByPipeline, progress, setProgress,
    error, setError, isRunning, setIsRunning,
  } = useExperimentResults();

  const experimentPipelines = pipelines;
  const baselinePipelineId =
    pipelines.find((pipeline) => pipeline.isBaseline)?.id ?? experimentPipelines[0]?.id ?? '';
  const baselinePipeline =
    pipelines.find((pipeline) => pipeline.id === baselinePipelineId) ?? experimentPipelines[0];

  const [selectedPipelineId, setSelectedPipelineId] = useState(baselinePipelineId);

  useEffect(() => {
    setSelectedPipelineId((prev) => {
      if (pipelines.some((pipeline) => pipeline.id === prev)) {
        return prev;
      }
      return baselinePipelineId;
    });
  }, [baselinePipelineId, pipelines]);

  const readyDocuments = useMemo(
    () =>
      documents.filter((doc) => {
        if (doc.status !== 'complete') {
          return false;
        }
        const hasContent = typeof doc.content === 'string' && doc.content.trim().length > 0;
        const hasFile =
          typeof doc.fileBase64 === 'string' && doc.fileBase64.trim().length > 0;
        return hasContent || hasFile;
      }),
    [documents]
  );

  const readyTasks = useMemo(
    () => tasks.filter((task) => task.question.trim()),
    [tasks]
  );

  const pipelineOptions = useMemo(
    () =>
      experimentPipelines.map((pipeline, index) => ({
        id: pipeline.id ?? `pipeline-${index}`,
        name: pipeline.name ?? `Pipeline ${index + 1}`,
      })),
    [experimentPipelines]
  );

  const pipelineNameLookup = useMemo(
    () =>
      pipelineOptions.reduce<Record<string, string>>((acc, option) => {
        acc[option.id] = option.name;
        return acc;
      }, {}),
    [pipelineOptions]
  );

  const previousRunTaskResults = useMemo(() => {
    if (!latestRun) {
      return {};
    }

    return latestRun.pipelines.reduce<Record<string, TaskResult[]>>((acc, pipeline) => {
      const answeringSummary = pipeline.answeringSummary;
      if (!answeringSummary) {
        return acc;
      }

      const chunkLookup = new Map(
        (answeringSummary.sources ?? []).map((chunk) => [chunk.id, chunk])
      );

      const convertedResults = (answeringSummary.details ?? []).map((detail) => {
        const matches = detail.retrievedChunkIds
          .map((chunkId) => {
            const chunk = chunkLookup.get(chunkId);
            if (!chunk) {
              return null;
            }
            return {
              id: chunk.id,
              score: chunk.score,
              text: chunk.content,
              documentName: chunk.documentName,
            };
          })
          .filter((match) => match !== null);

        return {
          taskId: detail.taskId,
          question: detail.question,
          expectedAnswer: detail.expectedAnswer ?? '',
          answer: detail.response,
          matches,
          latencyMs: detail.latencyMs,
          usage: detail.usage,
        };
      });

      acc[pipeline.pipelineId] = convertedResults;
      return acc;
    }, {});
  }, [latestRun]);

  const activePipelineId =
    selectedPipelineId && pipelineNameLookup[selectedPipelineId]
      ? selectedPipelineId
      : pipelineOptions[0]?.id ?? '';

  const localTaskResults = taskResultsByPipeline[activePipelineId];

  const displayedTaskResults =
    localTaskResults && localTaskResults.length > 0
      ? localTaskResults
      : previousRunTaskResults[activePipelineId] ?? [];

  const canViewReport =
    !isRunning && latestRun && latestRun.pipelines.length > 0;

  const buildSnippet = (text: string) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return 'Parsed document is empty.';
    }
    return normalized.length > 200 ? `${normalized.slice(0, 200)}…` : normalized;
  };

  const resetState = () => {
    setStatusLog([]);
    setTaskResultsByPipeline({});
    setProgress(0);
    setError(null);
    setSelectedPipelineId(baselinePipelineId);
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
      setStatusLog((prev) => [...prev, { id: prev.length + 1, message }]);
    };

    const startedAt = new Date().toISOString();

    const pipelineOverview = experimentPipelines.map((pipeline, index) => ({
      pipeline,
      id: pipeline.id ?? `pipeline-${index}`,
      name: pipeline.name ?? `Pipeline ${index + 1}`,
    }));

    const pipelineNames = pipelineOverview.map((entry) => entry.name);

    let latestDocuments: DatasetDocument[] = documents;
    const applyDocuments = (updater: (prev: DatasetDocument[]) => DatasetDocument[]) => {
      latestDocuments = updater(latestDocuments);
    };

    appendLog(`Experiment started at ${formatTimestamp()}.`);
    if (pipelineNames.length === 1) {
      appendLog(`Running pipeline: ${pipelineNames[0]}.`);
    } else {
      appendLog(`Running ${pipelineNames.length} pipelines: ${pipelineNames.join(', ')}.`);
    }
    appendLog(
      `Preparing ${readyDocuments.length} document${readyDocuments.length === 1 ? '' : 's'} for chunking.`
    );

    try {
      const taskById = new Map(readyTasks.map((task) => [task.id, task]));

      const documentsNeedingParse = latestDocuments.filter(
        (doc) =>
          doc.status === 'complete' &&
          !doc.content?.trim() &&
          typeof doc.fileBase64 === 'string' &&
          doc.fileBase64.trim()
      );

      if (documentsNeedingParse.length > 0) {
        setStage('parsing');
        appendLog(
          `Parsing ${documentsNeedingParse.length} document${documentsNeedingParse.length === 1 ? '' : 's'} using ${baselinePipeline.parsing.strategy}…`
        );

        let parsedCount = 0;
        for (const doc of documentsNeedingParse) {
          appendLog(`→ Parsing "${doc.name}"`);
          applyDocuments((prev) =>
            prev.map((item) =>
              item.id === doc.id
                ? {
                    ...item,
                    status: 'processing',
                    statusMessage: 'Parsing document…',
                    error: undefined,
                  }
                : item
            )
          );

          try {
            const response = await parseDocument({
              filename: doc.name ?? 'Document',
              mimeType: doc.mimeType,
              contentBase64: doc.fileBase64 ?? '',
            });

            const trimmedText = (response.text ?? '').trim();
            if (!trimmedText) {
              const message = 'Parsing completed, but no text could be extracted.';
              applyDocuments((prev) =>
                prev.map((item) =>
                  item.id === doc.id
                    ? {
                        ...item,
                        status: 'error',
                        statusMessage: message,
                        snippet: 'No text available from this document.',
                        error: message,
                      }
                    : item
                )
              );
              appendLog(`✗ Failed to extract text from "${doc.name}".`);
            } else {
              const snippet = buildSnippet(trimmedText);
              applyDocuments((prev) =>
                prev.map((item) =>
                  item.id === doc.id
                    ? {
                        ...item,
                        status: 'complete',
                        statusMessage: 'Parsed for experiment run.',
                        content: trimmedText,
                        snippet,
                        pageCount: response.pageCount,
                        parserJobId: response.jobId,
                      }
                    : item
                )
              );
              appendLog(
                `✓ Parsed "${doc.name}"${
                  response.pageCount
                    ? ` (${response.pageCount} page${response.pageCount === 1 ? '' : 's'})`
                    : ''
                }`
              );
            }
          } catch (error) {
            let message =
              error instanceof Error ? error.message : 'Unknown error while parsing document.';
            if (
              typeof message === 'string' &&
              (message.includes('LlamaParse API key is not configured') ||
                message.includes('Document parsing is not configured'))
            ) {
              message =
                'LlamaParse requires an API key. Set LLAMA_CLOUD_API_KEY in your backend environment before running experiments.';
            }
            applyDocuments((prev) =>
              prev.map((item) =>
                item.id === doc.id
                  ? {
                      ...item,
                      status: 'error',
                      statusMessage: message,
                      error: message,
                    }
                  : item
              )
            );
            appendLog(`✗ Failed to parse "${doc.name}": ${message}`);
            setError(`Failed to parse document "${doc.name}". ${message}`);
            setIsRunning(false);
            setStage('idle');
            return;
          }

          parsedCount += 1;
          const parseProgress =
            10 + Math.round((parsedCount / documentsNeedingParse.length) * 20);
          setProgress(Math.min(30, parseProgress));
        }
      }

      const readyDocs = latestDocuments.filter(
        (doc) =>
          doc.status === 'complete' &&
          typeof doc.content === 'string' &&
          doc.content.trim().length > 0
      );

      if (!readyDocs.length) {
        const message =
          'Document parsing produced no usable text. Try re-uploading the file or selecting a different parser.';
        appendLog(`✗ ${message}`);
        setError(message);
        setIsRunning(false);
        setStage('idle');
        return;
      }

      const parsedDocuments: ParsedDocument[] = readyDocs.map((doc) => ({
        id: doc.id,
        name: doc.name,
        source: doc.source,
        content: doc.content ?? '',
      }));

      const pipelineCount = pipelineOverview.length || 1;
      const computePipelineProgress = (index: number, fraction: number) => {
        const clamped = Math.min(1, Math.max(0, fraction));
        const value = Math.round(30 + ((index + clamped) / pipelineCount) * 70);
        setProgress(Math.min(99, value));
      };
      const updatePipelineProgress = (
        index: number,
        startFraction: number,
        endFraction: number,
        portion: number
      ) => {
        const clampedPortion = Math.min(1, Math.max(0, portion));
        const fraction = startFraction + (endFraction - startFraction) * clampedPortion;
        computePipelineProgress(index, fraction);
      };

      const pipelineResults: ExperimentPipelineResult[] = [];
      let completedAt: string | undefined;

      for (const [index, entry] of pipelineOverview.entries()) {
        const { pipeline: currentPipeline, id: pipelineId, name: pipelineName } = entry;
        const chunkConfig = currentPipeline.chunking;
        const retrieverK = currentPipeline.retriever?.topK;
        const pipelineEmbeddingModel = currentPipeline.embedding?.model;

        setStage('chunking');
        computePipelineProgress(index, 0);
        appendLog(
          `[${pipelineName}] Chunking documents with strategy "${chunkConfig.strategy}".`
        );

        const chunkGroups: DocumentChunkGroup[] = chunkDocumentsWithConfig(parsedDocuments, chunkConfig);
        const chunkSummary = summarizeChunkGroups(chunkGroups);
        const chunks: DocumentChunk[] = chunkGroups.flatMap((group) => group.chunks);
        const chunkCount = chunks.length;

        if (!chunkCount) {
          throw new Error(`No chunks were generated for pipeline "${pipelineName}".`);
        }

        appendLog(
          `[${pipelineName}] Generated ${chunkSummary.totalChunks} chunk${chunkSummary.totalChunks === 1 ? '' : 's'} (avg ${chunkSummary.averageChars} chars). Uploading to Qdrant…`
        );

        const chunkLookup = new Map<string, DocumentChunk>();
        chunkGroups.forEach((group) => {
          group.chunks.forEach((chunk) => {
            chunkLookup.set(chunk.id, chunk);
          });
        });

        const upsertResponse = await upsertChunks({
          pipelineId,
          embeddingModel: pipelineEmbeddingModel,
          chunks: chunks.map((chunk) => ({
            id: chunk.id,
            text: chunk.content,
            documentId: chunk.documentId,
            metadata: {
              documentName: chunk.documentName,
              documentSource: chunk.documentSource,
              charCount: chunk.charCount,
              tokenEstimate: chunk.tokenEstimate,
              strategy: chunk.strategy,
              chunkIndex: chunk.index,
            },
          })),
        });

        const targetCollectionName = upsertResponse.collection;
        const vectorSize = upsertResponse.vectorSize;
        appendLog(
          `[${pipelineName}] Chunks embedded and stored in Qdrant${
            targetCollectionName ? ` collection "${targetCollectionName}"` : ''
          }${
            vectorSize ? ` (vector size ${vectorSize})` : ''
          } successfully.`
        );
        computePipelineProgress(index, 0.25);

        setStage('answering');
        appendLog(
          `[${pipelineName}] Retrieving answers for ${readyTasks.length} task${readyTasks.length === 1 ? '' : 's'}…`
        );

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
          appendLog(`[${pipelineName}] → Retrieving context for: "${task.question}"`);

          const response = await answerQuestion({
            pipelineId,
            question: task.question,
            topK: retrieverK,
            model: currentPipeline.llm.model,
            temperature: currentPipeline.llm.temperature,
            maxTokens: currentPipeline.llm.maxTokens,
            embeddingModel: pipelineEmbeddingModel,
          });

          const matches = (response.matches ?? []).map((match) => {
            const chunk = chunkLookup.get(match.id);
            const payload = match.payload ?? {};
            const payloadText = typeof payload.text === 'string' ? payload.text : '';
            const payloadDocumentName =
              typeof payload.documentName === 'string' ? payload.documentName : undefined;
            const payloadDocumentId = payload.documentId;
            const text = chunk?.content ?? payloadText;
            const documentName = chunk?.documentName ?? payloadDocumentName;

            const retrieved: RetrievedChunk = {
              id: match.id,
              documentId:
                chunk?.documentId ??
                (typeof payloadDocumentId === 'string'
                  ? payloadDocumentId
                  : payloadDocumentId !== undefined && payloadDocumentId !== null
                  ? String(payloadDocumentId)
                  : ''),
              documentName,
              documentSource: chunk?.documentSource,
              content: text,
              charCount: chunk?.charCount ?? text.length,
              tokenEstimate: chunk?.tokenEstimate ?? Math.max(1, Math.round(text.length / 4)),
              score: typeof match.score === 'number' ? match.score : 0,
            };

            aggregatedSources.set(retrieved.id, retrieved);
            uniqueChunkIds.add(retrieved.id);

            return {
              id: retrieved.id,
              score: retrieved.score,
              text: retrieved.content,
              documentName: retrieved.documentName,
            };
          });

          answerDetails.push({
            taskId: task.id,
            question: task.question,
            expectedAnswer: task.expectedAnswer,
            acceptanceRule: task.acceptanceRule,
            response: response.answer,
            retrievedChunkIds: matches.map((match) => match.id),
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
          updatePipelineProgress(index, 0.25, 0.85, completed / readyTasks.length);
          appendLog(`[${pipelineName}] ✓ Answer drafted for task "${task.question}"`);
        }

        setTaskResultsByPipeline((prev) => ({
          ...prev,
          [pipelineId]: results,
        }));

        setStage('judging');
        appendLog(
          `[${pipelineName}] Scoring answers with judge model for quality and groundedness…`
        );
        computePipelineProgress(index, 0.9);

        const judgeResponse = await judgeAnswers({
          pipelineId,
          model: currentPipeline.judge?.model ?? currentPipeline.llm?.model,
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
        }).catch(() => ({
          verdict: 'unavailable' as const,
          judgePassRate: null,
          averageScores: { relevance: null, judgedContextPrecision: null, groundedness: null },
          coverage: { completed: 0, total: results.length },
          details: results.map(({ taskId }): JudgingSummary['details'][number] => ({
            taskId,
            verdict: 'unavailable',
            scores: null,
            missingCriteria: [],
            rationale: 'Judge request failed.',
            latencyMs: 0,
          })),
          latencyMs: 0,
          tokensUsed: 0,
        }));

        const totalQuestions = readyTasks.length;
        const embeddingModelName = pipelineEmbeddingModel ?? '';
        const vectorDim = getEmbeddingVectorDim(embeddingModelName);
        const totalEmbeddingTokens = chunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0);

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

        const answerModel = currentPipeline.llm?.model ?? '';
        const judgeModel = currentPipeline.judge?.model ?? answerModel;

        const answerCost = estimateChatCost(answerModel, answerUsageTotals);
        const judgeCost = estimateChatCost(judgeModel, judgeUsageTotals);

        const tokensUsed = totalAnswerTokens + judgeTotalTokens;
        const latencyP95Seconds = latencyP95Ms / 1000;
        const costPerQuery = totalQuestions ? answerCost / totalQuestions : 0;

        const pipelineMetrics: PipelineMetrics = {
          judgePassRate: judgeResponse.judgePassRate,
          judgedContextPrecision: judgeResponse.averageScores.judgedContextPrecision,
          latencyP95: Number(latencyP95Seconds.toFixed(2)),
          groundedness: judgeResponse.averageScores.groundedness,
          costPerQuery: Number(costPerQuery.toFixed(4)),
          tokensUsed: Math.round(tokensUsed),
        };

        const judgingSummary: JudgingSummary = {
          verdict: judgeResponse.verdict,
          judgePassRate: judgeResponse.judgePassRate,
          averageScores: judgeResponse.averageScores,
          coverage: judgeResponse.coverage,
          tokensUsed: Math.round(judgeTotalTokens),
          latencyMs: judgeResponse.latencyMs,
          costUsd: Number(judgeCost.toFixed(3)),
          details: judgeResponse.details,
        };

        const pipelineResult: ExperimentPipelineResult = {
          pipelineId,
          pipelineName,
          pipelineSnapshot: currentPipeline,
          metrics: pipelineMetrics,
          chunkingSummary: chunkSummary,
          embeddingSummary: {
            model: embeddingModelName,
            vectorDim,
            totalChunks: chunkSummary.totalChunks,
            totalTokens: totalEmbeddingTokens,
          },
          retrievalSummary: {
            topK: retrieverK,
            deduplicate: currentPipeline.retriever?.deduplicate ?? false,
            candidatePool: chunkCount,
            uniqueResults: uniqueChunkIds.size,
          },
          answeringSummary: {
            answer: results
              .map((result, answerIndex) => `Q${answerIndex + 1}: ${result.answer}`)
              .join('\n\n'),
            sources: Array.from(aggregatedSources.values()),
            tokensUsed: Math.round(totalAnswerTokens),
            latencyMs: Math.round(answerLatencyP95Ms),
            costUsd: Number(answerCost.toFixed(3)),
            details: answerDetails,
          },
          judgingSummary,
        };

        pipelineResults.push(pipelineResult);
        completedAt = new Date().toISOString();

        const { completed: scored, total } = judgeResponse.coverage;
        const passRateLabel = judgeResponse.judgePassRate === null
          ? 'unavailable'
          : `${(judgeResponse.judgePassRate * 100).toFixed(0)}%`;
        appendLog(
          `[${pipelineName}] Evaluation complete. Judge coverage ${scored}/${total}. Judge pass rate ${passRateLabel}.`
        );
        computePipelineProgress(index, 1);
      }

      setStage('complete');
      setProgress(100);
      appendLog('Experiment complete. Review the answers below.');

      const bestByMetric: ExperimentRun['bestByMetric'] = {};
      for (const metric of METRIC_DEFINITIONS) {
        let best: number | null = null;
        for (const result of pipelineResults) {
          const value = result.metrics[metric.key];
          if (value !== null && (best === null || (metric.better === 'higher' ? value > best : value < best))) {
            best = value;
            bestByMetric[metric.key] = result.pipelineId;
          }
        }
      }

      const baselinePipelineIdForRun =
        pipelineResults.find((result) => result.pipelineId === baselinePipelineId)?.pipelineId ??
        pipelineResults[0]?.pipelineId;

      const runSummary: ExperimentRun = {
        id: `run-${Date.now()}`,
        name: `Experiment ${formatTimestamp()}`,
        startedAt,
        completedAt,
        statusLog: [...localLog],
        pipelines: pipelineResults,
        bestByMetric,
        baselinePipelineId: baselinePipelineIdForRun,
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
    <div className="px-4 py-6 sm:p-8 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1>Experiment Runner</h1>
            <p className="text-muted-foreground">
              Upload documents, embed them with Qdrant, and evaluate answers with the LLM.
            </p>
          </div>
          <Button onClick={runExperiment} size="lg" className="gap-2" disabled={isRunning || !!unavailable}>
            <Play size={20} />
            {isRunning ? 'Running…' : 'Start Experiment'}
          </Button>
        </div>

        {unavailable && <p role="status">{unavailable}</p>}
        {error && (
          <Card role="alert" className="border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300">
            <CardContent className="py-4 text-sm">{error}</CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
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
              <Progress aria-label="Overall experiment progress" value={progress} />
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="opacity-60">Current Stage:</span>
              <span className="capitalize">{stage}</span>
            </div>

            <div className="max-h-48 overflow-y-auto overflow-x-hidden text-sm pr-2 text-foreground">
              {statusLog.length === 0 ? (
                <p className="opacity-60">Status updates will appear here once the experiment starts.</p>
              ) : (
                statusLog.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2 py-1">
                    <span className="opacity-40 flex-none">•</span>
                    <span className="flex-1 min-w-0 break-words">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <CardTitle>Question &amp; Answer Review</CardTitle>
              {pipelineOptions.length > 1 ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className="opacity-70">Pipeline</span>
                  <Select
                    value={activePipelineId}
                    onValueChange={(value) => {
                      setSelectedPipelineId(value);
                    }}
                  >
                    <SelectTrigger aria-label="Review pipeline" className="max-w-full sm:w-48">
                      <SelectValue placeholder="Choose pipeline">
                        {pipelineNameLookup[activePipelineId] ?? 'Choose pipeline'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {pipelineOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {displayedTaskResults.length === 0 ? (
              <p className="text-muted-foreground">
                Run an experiment to generate answers for your evaluation tasks.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[22%]">Question</TableHead>
                    <TableHead className="w-[15%]">Expected</TableHead>
                    <TableHead className="w-[38%]">Model Answer</TableHead>
                    <TableHead className="w-[25%]">Top Context</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {displayedTaskResults.map((result) => (
                    <TableRow key={result.taskId}>
                      <TableCell className="align-top w-[22%]">
                        <div className="space-y-1">
                          <div className="font-medium">{result.question}</div>
                        </div>
                      </TableCell>
                      <TableCell className="align-top w-[15%]">
                        {result.expectedAnswer || '—'}
                      </TableCell>
                      <TableCell className="align-top w-[38%] whitespace-pre-wrap">
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
                                className="p-2 rounded border border-border"
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

        {canViewReport && (
          <div className="flex justify-end">
            <Button asChild><Link to={reportPath(latestRun.id)}>View report</Link></Button>
          </div>
        )}
      </div>
    </div>
  );
}
