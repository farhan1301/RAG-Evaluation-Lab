import { useMemo } from 'react';
import { Download, FileText, FileJson } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { useExperimentResults } from '../state/experimentResults';
import { cn } from './ui/utils';
import {
  METRIC_DEFINITIONS,
  type MetricKey,
  type PipelineMetrics,
  type ExperimentPipelineResult,
} from '../types/experiment';

interface ReportsPageProps {
  darkMode: boolean;
}

const PIPELINE_COLORS: Record<string, string> = {
  A: '#3b82f6',
  B: '#22c55e',
  C: '#f97316',
};

const FALLBACK_COLORS = ['#a855f7', '#ec4899', '#14b8a6'];

const METRIC_LOOKUP = METRIC_DEFINITIONS.reduce(
  (acc, metric) => ({
    ...acc,
    [metric.key]: metric,
  }),
  {} as Record<MetricKey, (typeof METRIC_DEFINITIONS)[number]>
);


const formatMetricValue = (key: MetricKey, value: number) =>
  METRIC_LOOKUP[key]?.format ? METRIC_LOOKUP[key].format(value) : value.toString();

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const boolLabel = (value: boolean) => (value ? 'Enabled' : 'Disabled');
const dedupeLabel = (value: boolean) => (value ? 'On' : 'Off');

const roundValue = (value: number | undefined, decimals: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const VALUE_EPSILON = 1e-6;

const deriveMetricValue = (pipeline: ExperimentPipelineResult, key: MetricKey): number => {
  const baseValue = pipeline.metrics?.[key];
  if (typeof baseValue === 'number' && Number.isFinite(baseValue)) {
    return baseValue;
  }

  switch (key) {
    case 'precisionAt5':
      return roundValue(pipeline.judgingSummary?.passRate, 2);
    case 'recallAt5':
      return roundValue(pipeline.judgingSummary?.averageScores.contextPrecision, 2);
    case 'groundedness':
      return roundValue(pipeline.judgingSummary?.averageScores.groundedness, 2);
    case 'latencyP95': {
      const answerLatencyMs = pipeline.answeringSummary?.latencyMs;
      if (typeof answerLatencyMs === 'number' && Number.isFinite(answerLatencyMs)) {
        return roundValue(answerLatencyMs / 1000, 2);
      }
      const averageJudgeLatencyMs =
        typeof pipeline.judgingSummary?.latencyMs === 'number' &&
        pipeline.judgingSummary?.details.length
          ? pipeline.judgingSummary.latencyMs / pipeline.judgingSummary.details.length
          : 0;
      return roundValue(averageJudgeLatencyMs / 1000, 2);
    }
    case 'costPerQuery': {
      const questionCount =
        pipeline.judgingSummary?.details.length ??
        pipeline.answeringSummary?.details.length ??
        0;
      if (!questionCount) {
        return 0;
      }
      const embeddingCost = pipeline.embeddingSummary?.estimatedCostUsd ?? 0;
      const answerCost = pipeline.answeringSummary?.costUsd ?? 0;
      const judgeCost = pipeline.judgingSummary?.costUsd ?? 0;
      return roundValue((embeddingCost + answerCost + judgeCost) / questionCount, 3);
    }
    case 'tokensUsed': {
      const answerTokens = pipeline.answeringSummary?.tokensUsed ?? 0;
      const judgeTokens = pipeline.judgingSummary?.tokensUsed ?? 0;
      const totalTokens = answerTokens + judgeTokens;
      return Number.isFinite(totalTokens) ? Math.round(totalTokens) : 0;
    }
    default:
      return 0;
  }
};

const buildPipelineMetrics = (pipeline: ExperimentPipelineResult): PipelineMetrics =>
  (['precisionAt5', 'recallAt5', 'latencyP95', 'groundedness', 'costPerQuery', 'tokensUsed'] as MetricKey[]).reduce(
    (acc, key) => {
      acc[key] = deriveMetricValue(pipeline, key);
      return acc;
    },
    {} as PipelineMetrics,
  );

export function ReportsPage({ darkMode }: ReportsPageProps) {
  const { latestRun } = useExperimentResults();

  const pipelineMap = useMemo(() => {
    if (!latestRun) {
      return {};
    }
    return latestRun.pipelines.reduce((acc, pipeline) => {
      acc[pipeline.pipelineId] = pipeline;
      return acc;
    }, {} as Record<string, (typeof latestRun.pipelines)[number]>);
  }, [latestRun]);

  const pipelineOrder = useMemo(
    () => (latestRun ? latestRun.pipelines.map((pipeline) => pipeline.pipelineId) : []),
    [latestRun]
  );

  const hasRun = Boolean(latestRun && pipelineOrder.length > 0);

  if (!hasRun) {
    return (
      <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
        <div className="max-w-4xl mx-auto">
          <Card className={darkMode ? 'bg-zinc-900 border-zinc-800 text-zinc-200' : ''}>
            <CardHeader>
              <CardTitle>No experiment results yet</CardTitle>
              <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                Run an experiment to generate comparative metrics and a downloadable report.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                Once your first experiment completes, this page will populate with pass rate, context precision, latency, and cost
                comparisons for every pipeline you tested. You will also unlock export options for sharing the findings
                with stakeholders.
              </p>
              <p className={darkMode ? 'text-zinc-500' : 'text-zinc-500'}>
                Head to the <strong>Experiments</strong> tab to launch a run.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const baselineId =
    (latestRun?.baselinePipelineId && pipelineMap[latestRun.baselinePipelineId]
      ? latestRun.baselinePipelineId
      : undefined) ?? pipelineOrder[0];

  const baselinePipeline = baselineId ? pipelineMap[baselineId] : undefined;

  const recommendedId =
    (latestRun?.bestByMetric.precisionAt5 &&
    pipelineMap[latestRun.bestByMetric.precisionAt5]
      ? latestRun.bestByMetric.precisionAt5
      : undefined) ?? baselineId;

  const recommendedPipeline = recommendedId ? pipelineMap[recommendedId] : undefined;
  const recommendedSnapshot = recommendedPipeline?.pipelineSnapshot;

  const generatedAt = latestRun?.completedAt ?? latestRun?.startedAt ?? new Date().toISOString();
  const formattedTimestamp = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(generatedAt));

  const pipelineEntries = pipelineOrder
    .map((id, index) => ({
      id,
      pipeline: pipelineMap[id],
      color: PIPELINE_COLORS[id] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length],
    }))
    .filter((entry) => entry.pipeline);

  const pipelineMetrics = pipelineEntries.reduce(
    (acc, entry) => {
      const { id, pipeline } = entry;
      if (!pipeline) {
        return acc;
      }

      acc[id] = {
        name: pipeline.pipelineName,
        metrics: buildPipelineMetrics(pipeline),
      };

      return acc;
    },
    {} as Record<
      string,
      {
        name: string;
        metrics: PipelineMetrics;
      }
    >
  );

  const baselineMetrics = baselineId ? pipelineMetrics[baselineId]?.metrics : undefined;
  const recommendedMetrics = recommendedPipeline
    ? pipelineMetrics[recommendedPipeline.pipelineId]?.metrics
    : undefined;

  const highlightMetrics =
    recommendedMetrics && baselineMetrics
      ? METRIC_DEFINITIONS.filter((definition) => {
          const recommendedValue = recommendedMetrics[definition.key];
          const baselineValue = baselineMetrics[definition.key];
          if (recommendedValue === undefined || baselineValue === undefined) {
            return false;
          }
          if (definition.better === 'higher') {
            return recommendedValue > baselineValue;
          }
          return recommendedValue < baselineValue;
        })
      : [];

  const highlightSummary = highlightMetrics.slice(0, 3).map((metric) => metric.label).join(', ');
  const recommendationSummary =
    highlightMetrics.length > 0 && baselinePipeline
      ? `It outperforms your baseline (${baselinePipeline.pipelineName}) on ${highlightSummary}${
          highlightMetrics.length > 3 ? ' and additional metrics' : ''
        }.`
      : 'It maintains parity with your baseline configuration while ensuring consistent quality.';

  const COMPARISON_METRICS: MetricKey[] = [
    'precisionAt5',
    'recallAt5',
    'groundedness',
    'latencyP95',
    'costPerQuery',
    'tokensUsed',
  ];

  const pipelineComparisonRows = pipelineEntries.map(({ id, pipeline, color }) => {
    const metrics = pipelineMetrics[id]?.metrics;
    return {
      id,
      name: pipeline?.pipelineName ?? `Pipeline ${id}`,
      color,
      metrics,
      isBaseline: id === baselineId,
      isRecommended: id === recommendedId,
    };
  });

  const metricExtremes = COMPARISON_METRICS.reduce(
    (acc, metric) => {
      const values = pipelineComparisonRows
        .map((row) => row.metrics?.[metric])
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

      if (!values.length) {
        return acc;
      }

      const betterDirection = METRIC_LOOKUP[metric]?.better ?? 'higher';
      const best = betterDirection === 'higher' ? Math.max(...values) : Math.min(...values);
      const worst = betterDirection === 'higher' ? Math.min(...values) : Math.max(...values);

      acc[metric] = { best, worst };
      return acc;
    },
    {} as Record<MetricKey, { best: number; worst: number }>
  );

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
              {latestRun?.name ?? 'Experiment Report'}
            </h2>
            <p className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>Generated on {formattedTimestamp}</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" className="gap-2">
              <FileText size={16} />
              Export PDF
            </Button>
            <Button variant="outline" className="gap-2">
              <Download size={16} />
              Export Markdown
            </Button>
            <Button variant="outline" className="gap-2">
              <FileJson size={16} />
              Export JSON
            </Button>
          </div>
        </div>

        {/* Recommendation */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
              AI-Generated Recommendation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
              {recommendedPipeline ? (
                <>
                  Based on the most recent experiment,{' '}
                  <strong>{recommendedPipeline.pipelineName}</strong> provides the strongest balance
                  across the tracked metrics. {recommendationSummary}
                </>
              ) : (
                'Run details were recorded, but we could not identify a leading configuration.'
              )}
            </p>

            {recommendedSnapshot && (
              <div
                className={`p-4 rounded-lg border ${
                  darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'
                }`}
              >
                <p className={`mb-2 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Recommended configuration snapshot:
                </p>
                <ul className={`space-y-1 text-sm ${darkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  <li>
                    • <strong>Chunking:</strong>{' '}
                    {capitalize(recommendedSnapshot.chunking.strategy)} chunks (
                    {recommendedSnapshot.chunking.chunkSize} tokens,{' '}
                    {recommendedSnapshot.chunking.overlap}% overlap)
                  </li>
                  <li>
                    • <strong>Embedding:</strong> {recommendedSnapshot.embedding.model}
                  </li>
                  <li>
                    • <strong>Retrieval:</strong> Top-K {recommendedSnapshot.retriever.topK},{' '}
                    deduplication {dedupeLabel(recommendedSnapshot.retriever.deduplicate)}
                  </li>
                  <li>
                    • <strong>Reranker:</strong> {boolLabel(recommendedSnapshot.reranker.enabled)} (
                    {recommendedSnapshot.reranker.model})
                  </li>
                  <li>
                    • <strong>LLM:</strong> {recommendedSnapshot.llm.model} (temperature{' '}
                    {recommendedSnapshot.llm.temperature.toFixed(1)}, max{' '}
                    {recommendedSnapshot.llm.maxTokens} tokens)
                  </li>
                  <li>
                    • <strong>Judge:</strong> {recommendedSnapshot.judge.model}
                  </li>
                </ul>
              </div>
            )}

            <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Keep iterating on the recommended pipeline to validate that these improvements hold up
              across new evaluation datasets before promoting the configuration to production.
            </p>
          </CardContent>
        </Card>

        {/* Pipeline Comparison */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
              Pipeline Comparison Overview
            </CardTitle>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              All metrics compared against {baselinePipeline?.pipelineName ?? 'the first pipeline'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {pipelineComparisonRows.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pipeline</TableHead>
                      {COMPARISON_METRICS.map((metric) => (
                        <TableHead key={metric} className="text-right">
                          {METRIC_LOOKUP[metric]?.label ?? capitalize(metric)}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pipelineComparisonRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: row.color }} />
                            <span>{row.name}</span>
                            {row.isBaseline && <Badge variant="outline">Baseline</Badge>}
                            {row.isRecommended && !row.isBaseline && (
                              <Badge variant="outline">Recommended</Badge>
                            )}
                      </div>
                    </TableCell>
                    {COMPARISON_METRICS.map((metric) => (
                      <TableCell key={metric} className="text-right">
                        {row.metrics && typeof row.metrics[metric] === 'number' ? (
                          <div className="flex flex-col items-end gap-1">
                            {(() => {
                              const value = row.metrics?.[metric];
                              if (typeof value !== 'number') {
                                return null;
                              }
                              const extremes = metricExtremes[metric];
                              const baselineValue = baselineMetrics?.[metric];
                              const betterDirection = METRIC_LOOKUP[metric]?.better ?? 'higher';

                              const difference =
                                typeof baselineValue === 'number' ? value - baselineValue : undefined;

                              const percentChange =
                                typeof difference === 'number' &&
                                typeof baselineValue === 'number' &&
                                Math.abs(baselineValue) > VALUE_EPSILON
                                  ? (difference / baselineValue) * 100
                                  : undefined;

                              const isBest =
                                extremes &&
                                Math.abs(value - extremes.best) < VALUE_EPSILON &&
                                !(extremes && Math.abs(extremes.best - extremes.worst) < VALUE_EPSILON);

                              const isWorst =
                                extremes &&
                                Math.abs(value - extremes.worst) < VALUE_EPSILON &&
                                !(extremes && Math.abs(extremes.best - extremes.worst) < VALUE_EPSILON);

                              const highlightState: 'best' | 'worst' | 'neutral' = (() => {
                                if (isBest && isWorst) {
                                  return 'neutral';
                                }
                                if (isBest) {
                                  return 'best';
                                }
                                if (isWorst) {
                                  return 'worst';
                                }
                                return 'neutral';
                              })();

                              const valueColorClass =
                                highlightState === 'neutral'
                                  ? darkMode
                                    ? 'text-zinc-100'
                                    : 'text-zinc-700'
                                  : '';

                              const valueStyle =
                                highlightState === 'best'
                                  ? { color: darkMode ? '#4ade80' : '#16a34a' }
                                  : highlightState === 'worst'
                                  ? { color: darkMode ? '#f87171' : '#dc2626' }
                                  : undefined;

                              const valueClasses = cn('font-semibold', valueColorClass);

                              const arrowSymbol =
                                typeof percentChange === 'number'
                                  ? percentChange > 0
                                    ? '↑'
                                    : percentChange < 0
                                    ? '↓'
                                    : '→'
                                  : typeof difference === 'number'
                                  ? difference > 0
                                    ? '↑'
                                    : difference < 0
                                    ? '↓'
                                    : '→'
                                  : null;

                              const percentMagnitude =
                                typeof percentChange === 'number'
                                  ? Math.abs(percentChange) >= 10
                                    ? Math.abs(percentChange).toFixed(0)
                                    : Math.abs(percentChange).toFixed(1)
                                  : null;

                              const improvement =
                                typeof difference === 'number'
                                  ? betterDirection === 'higher'
                                    ? difference > 0
                                    : difference < 0
                                  : false;

                              const regression =
                                typeof difference === 'number'
                                  ? betterDirection === 'higher'
                                    ? difference < 0
                                    : difference > 0
                                  : false;

                              let deltaText: string | null = null;
                              let deltaClass = 'text-xs font-medium text-muted-foreground';

                              if (row.isBaseline) {
                                deltaText = 'Baseline';
                              } else if (typeof percentChange === 'number') {
                                deltaText = `${arrowSymbol} ${percentMagnitude ?? '0'}%`;
                                if (percentChange === 0) {
                                  deltaClass = 'text-xs font-medium text-muted-foreground';
                                } else if (improvement) {
                                  deltaClass = darkMode
                                    ? 'text-xs font-medium text-green-400'
                                    : 'text-xs font-medium text-green-600';
                                } else if (regression) {
                                  deltaClass = darkMode
                                    ? 'text-xs font-medium text-red-400'
                                    : 'text-xs font-medium text-red-600';
                                }
                              } else if (
                                typeof difference === 'number' &&
                                typeof baselineValue === 'number'
                              ) {
                                const formattedDiff = formatMetricValue(metric, Math.abs(difference));
                                deltaText =
                                  arrowSymbol && formattedDiff
                                    ? `${arrowSymbol} ${formattedDiff}`
                                    : null;
                                if (difference === 0) {
                                  deltaClass = 'text-xs font-medium text-muted-foreground';
                                } else if (improvement) {
                                  deltaClass = darkMode
                                    ? 'text-xs font-medium text-green-400'
                                    : 'text-xs font-medium text-green-600';
                                } else if (regression) {
                                  deltaClass = darkMode
                                    ? 'text-xs font-medium text-red-400'
                                    : 'text-xs font-medium text-red-600';
                                }
                              }

                              return (
                                <>
                                  <span className={valueClasses} style={valueStyle}>
                                    {formatMetricValue(metric, value)}
                                  </span>
                                  {deltaText ? <span className={deltaClass}>{deltaText}</span> : null}
                                </>
                              );
                            })()}
                          </div>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
              </div>
            ) : (
              <p className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                No pipeline results detected in the latest experiment.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Next Steps */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
              Suggested Next Steps
            </CardTitle>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              Iterate on your strongest pipeline and validate improvements with fresh data.
            </CardDescription>
          </CardHeader>
          <CardContent className={`space-y-3 text-sm ${darkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>
            <ul className="list-disc list-inside space-y-2">
              <li>
                Tune chunking or retriever settings on the recommended configuration and rerun experiments to
                confirm the performance lift.
              </li>
              <li>
                Export this report for stakeholders to review quality, latency, and cost trade-offs before
                promoting changes.
              </li>
              <li>
                Capture qualitative feedback from subject-matter experts to complement the quantitative metrics
                shown here.
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
