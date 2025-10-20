import { useMemo } from 'react';
import { Download, FileText, FileJson } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from 'recharts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { useExperimentResults } from '../state/experimentResults';
import { METRIC_DEFINITIONS, type MetricKey } from '../types/experiment';

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

const LOWER_IS_BETTER: MetricKey[] = ['latencyP95', 'costPerQuery', 'tokensUsed'];

const formatMetricValue = (key: MetricKey, value: number) =>
  METRIC_LOOKUP[key]?.format ? METRIC_LOOKUP[key].format(value) : value.toString();

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const boolLabel = (value: boolean) => (value ? 'Enabled' : 'Disabled');
const dedupeLabel = (value: boolean) => (value ? 'On' : 'Off');

const computeDiff = (value: number, baseline: number, metric: MetricKey) => {
  if (!baseline) {
    return null;
  }
  const diff = ((value - baseline) / baseline) * 100;
  const lowerIsBetter = LOWER_IS_BETTER.includes(metric);
  const isPositive = lowerIsBetter ? diff < 0 : diff > 0;
  return { diff: Math.abs(diff), isPositive };
};

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
        metrics: pipeline.metrics,
      };

      return acc;
    },
    {} as Record<
      string,
      {
        name: string;
        metrics: (typeof recommendedPipeline)['metrics'];
      }
    >
  );

  const baselineMetrics = baselineId ? pipelineMetrics[baselineId]?.metrics : undefined;

  const highlightMetrics =
    recommendedPipeline && baselineMetrics
      ? METRIC_DEFINITIONS.filter((definition) => {
          const recommendedValue = recommendedPipeline.metrics[definition.key];
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

  const barMetrics: MetricKey[] = ['precisionAt5', 'recallAt5', 'groundedness'];
  const barChartData = barMetrics.map((key) => {
    const row: Record<string, number | string> = {
      name: METRIC_LOOKUP[key]?.label ?? key,
    };

    pipelineEntries.forEach(({ id, pipeline }) => {
      row[id] = pipeline?.metrics[key] ?? 0;
    });

    return row;
  });

  const costLatencyData = [
    {
      name: 'Latency (s)',
      ...pipelineEntries.reduce(
        (acc, { id, pipeline }) => ({
          ...acc,
          [id]: pipeline?.metrics.latencyP95 ?? 0,
        }),
        {},
      ),
    },
    {
      name: 'Cost (USD)',
      ...pipelineEntries.reduce(
        (acc, { id, pipeline }) => ({
          ...acc,
          [id]: pipeline?.metrics.costPerQuery ?? 0,
        }),
        {},
      ),
    },
  ];

  const radarMetrics: Array<{ key: MetricKey; label: string; lowerIsBetter?: boolean }> = [
    { key: 'precisionAt5', label: 'Pass Rate' },
    { key: 'recallAt5', label: 'Context Precision' },
    { key: 'groundedness', label: 'Groundedness' },
    { key: 'latencyP95', label: 'Speed', lowerIsBetter: true },
    { key: 'costPerQuery', label: 'Cost Efficiency', lowerIsBetter: true },
  ];

  const radarData = radarMetrics.map(({ key, label, lowerIsBetter }) => {
    const values = pipelineEntries.map(({ pipeline }) => pipeline?.metrics[key] ?? 0);
    const filteredValues = values.filter((value) => value > 0);
    const bestValue =
      filteredValues.length === 0
        ? 0
        : lowerIsBetter
        ? Math.min(...filteredValues)
        : Math.max(...filteredValues);

    const row: Record<string, number | string> = { metric: label };
    pipelineEntries.forEach(({ id, pipeline }) => {
      const value = pipeline?.metrics[key] ?? 0;
      let normalized = 0;

      if (lowerIsBetter) {
        normalized = value > 0 && bestValue > 0 ? (bestValue / value) * 100 : 0;
      } else {
        normalized = bestValue > 0 ? (value / bestValue) * 100 : 0;
      }

      row[id] = Math.round(Math.min(normalized, 100));
    });
    return row;
  });

  const passRateValues = pipelineEntries.map(({ pipeline }) => pipeline?.metrics.precisionAt5 ?? 0);
  const contextPrecisionValues = pipelineEntries.map(({ pipeline }) => pipeline?.metrics.recallAt5 ?? 0);
  const groundedValues = pipelineEntries.map(
    ({ pipeline }) => pipeline?.metrics.groundedness ?? 0
  );
  const latencyValues = pipelineEntries
    .map(({ pipeline }) => pipeline?.metrics.latencyP95 ?? Infinity)
    .filter((value) => Number.isFinite(value));
  const costValues = pipelineEntries
    .map(({ pipeline }) => pipeline?.metrics.costPerQuery ?? Infinity)
    .filter((value) => Number.isFinite(value));

  const bestPassRate = passRateValues.length ? Math.max(...passRateValues) : 0;
  const bestContextPrecision = contextPrecisionValues.length
    ? Math.max(...contextPrecisionValues)
    : 0;
  const bestGroundedness = groundedValues.length ? Math.max(...groundedValues) : 0;
  const bestLatency = latencyValues.length ? Math.min(...latencyValues) : 0;
  const bestCost = costValues.length ? Math.min(...costValues) : 0;

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
            <div className="space-y-4">
              {pipelineEntries.map(({ id, pipeline }) => {
                if (!pipeline) {
                  return null;
                }

                const isBaseline = id === baselineId;
                const entry = pipelineMetrics[id];
                const baselineEntry = baselineId ? pipelineMetrics[baselineId] : undefined;

                const metrics = entry?.metrics;
                const baselineMetricValues = baselineEntry?.metrics;

                return (
                  <div
                    key={id}
                    className={`p-4 rounded-lg border ${
                      darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-white'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
                          {pipeline.pipelineName}
                        </h4>
                        <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          {pipeline.pipelineSnapshot.description ?? 'No description provided.'}
                        </p>
                      </div>
                      {isBaseline && <Badge variant="outline">Baseline</Badge>}
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Pass Rate
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              metrics?.precisionAt5 === bestPassRate
                                ? darkMode
                                  ? 'text-green-400'
                                  : 'text-green-600'
                                : darkMode
                                ? 'text-zinc-300'
                                : 'text-zinc-900'
                            }
                          >
                            {formatMetricValue('precisionAt5', metrics?.precisionAt5 ?? 0)}
                          </span>
                          {!isBaseline && baselineMetricValues && metrics && (
                            <span
                              className={`text-xs flex items-center ${
                                computeDiff(metrics.precisionAt5, baselineMetricValues.precisionAt5, 'precisionAt5')
                                  ?.isPositive
                                  ? darkMode
                                    ? 'text-green-400'
                                    : 'text-green-600'
                                  : darkMode
                                  ? 'text-red-400'
                                  : 'text-red-600'
                              }`}
                            >
                              {computeDiff(metrics.precisionAt5, baselineMetricValues.precisionAt5, 'precisionAt5')
                                ?.isPositive
                                ? '↑'
                                : '↓'}
                              {computeDiff(metrics.precisionAt5, baselineMetricValues.precisionAt5, 'precisionAt5')
                                ?.diff.toFixed(0)}
                              %
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Context Precision
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              metrics?.recallAt5 === bestContextPrecision
                                ? darkMode
                                  ? 'text-green-400'
                                  : 'text-green-600'
                                : darkMode
                                ? 'text-zinc-300'
                                : 'text-zinc-900'
                            }
                          >
                            {formatMetricValue('recallAt5', metrics?.recallAt5 ?? 0)}
                          </span>
                          {!isBaseline && baselineMetricValues && metrics && (
                            <span
                              className={`text-xs flex items-center ${
                                computeDiff(metrics.recallAt5, baselineMetricValues.recallAt5, 'recallAt5')?.isPositive
                                  ? darkMode
                                    ? 'text-green-400'
                                    : 'text-green-600'
                                  : darkMode
                                  ? 'text-red-400'
                                  : 'text-red-600'
                              }`}
                            >
                              {computeDiff(metrics.recallAt5, baselineMetricValues.recallAt5, 'recallAt5')?.isPositive
                                ? '↑'
                                : '↓'}
                              {computeDiff(metrics.recallAt5, baselineMetricValues.recallAt5, 'recallAt5')?.diff.toFixed(0)}
                              %
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Groundedness
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              metrics?.groundedness === bestGroundedness
                                ? darkMode
                                  ? 'text-green-400'
                                  : 'text-green-600'
                                : darkMode
                                ? 'text-zinc-300'
                                : 'text-zinc-900'
                            }
                          >
                            {formatMetricValue('groundedness', metrics?.groundedness ?? 0)}
                          </span>
                          {!isBaseline && baselineMetricValues && metrics && (
                            <span
                              className={`text-xs flex items-center ${
                                computeDiff(
                                  metrics.groundedness,
                                  baselineMetricValues.groundedness,
                                  'groundedness'
                                )?.isPositive
                                  ? darkMode
                                    ? 'text-green-400'
                                    : 'text-green-600'
                                  : darkMode
                                  ? 'text-red-400'
                                  : 'text-red-600'
                              }`}
                            >
                              {computeDiff(
                                metrics.groundedness,
                                baselineMetricValues.groundedness,
                                'groundedness'
                              )?.isPositive
                                ? '↑'
                                : '↓'}
                              {computeDiff(
                                metrics.groundedness,
                                baselineMetricValues.groundedness,
                                'groundedness'
                              )?.diff.toFixed(0)}
                              %
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Latency p95
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              metrics?.latencyP95 === bestLatency
                                ? darkMode
                                  ? 'text-green-400'
                                  : 'text-green-600'
                                : darkMode
                                ? 'text-zinc-300'
                                : 'text-zinc-900'
                            }
                          >
                            {formatMetricValue('latencyP95', metrics?.latencyP95 ?? 0)}
                          </span>
                          {!isBaseline && baselineMetricValues && metrics && (
                            <span
                              className={`text-xs flex items-center ${
                                computeDiff(metrics.latencyP95, baselineMetricValues.latencyP95, 'latencyP95')
                                  ?.isPositive
                                  ? darkMode
                                    ? 'text-green-400'
                                    : 'text-green-600'
                                  : darkMode
                                  ? 'text-red-400'
                                  : 'text-red-600'
                              }`}
                            >
                              {computeDiff(metrics.latencyP95, baselineMetricValues.latencyP95, 'latencyP95')
                                ?.isPositive
                                ? '↓'
                                : '↑'}
                              {computeDiff(metrics.latencyP95, baselineMetricValues.latencyP95, 'latencyP95')
                                ?.diff.toFixed(0)}
                              %
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Cost / Query
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              metrics?.costPerQuery === bestCost
                                ? darkMode
                                  ? 'text-green-400'
                                  : 'text-green-600'
                                : darkMode
                                ? 'text-zinc-300'
                                : 'text-zinc-900'
                            }
                          >
                            {formatMetricValue('costPerQuery', metrics?.costPerQuery ?? 0)}
                          </span>
                          {!isBaseline && baselineMetricValues && metrics && (
                            <span
                              className={`text-xs flex items-center ${
                                computeDiff(metrics.costPerQuery, baselineMetricValues.costPerQuery, 'costPerQuery')
                                  ?.isPositive
                                  ? darkMode
                                    ? 'text-green-400'
                                    : 'text-green-600'
                                  : darkMode
                                  ? 'text-red-400'
                                  : 'text-red-600'
                              }`}
                            >
                              {computeDiff(metrics.costPerQuery, baselineMetricValues.costPerQuery, 'costPerQuery')
                                ?.isPositive
                                ? '↓'
                                : '↑'}
                              {computeDiff(metrics.costPerQuery, baselineMetricValues.costPerQuery, 'costPerQuery')
                                ?.diff.toFixed(0)}
                              %
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Charts */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
            <CardHeader>
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
                Quality Metrics
              </CardTitle>
              <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                Pass rate, context precision, and groundedness across pipelines
              </CardDescription>
            </CardHeader>
            <CardContent className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barChartData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className={darkMode ? 'stroke-zinc-700' : 'stroke-zinc-200'}
                  />
                  <XAxis
                    dataKey="name"
                    tick={{ fill: darkMode ? '#a1a1aa' : '#71717a' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: darkMode ? '#a1a1aa' : '#71717a' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: darkMode ? '#18181b' : '#fff',
                      borderColor: darkMode ? '#3f3f46' : '#e4e4e7',
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  {pipelineEntries.map(({ id, pipeline, color }) => (
                    <Bar
                      key={id}
                      dataKey={id}
                      name={pipeline?.pipelineName ?? `Pipeline ${id}`}
                      fill={color}
                      radius={4}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
            <CardHeader>
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
                Latency & Cost
              </CardTitle>
              <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                Comparing latency and cost per query across pipelines
              </CardDescription>
            </CardHeader>
            <CardContent className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={costLatencyData}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    className={darkMode ? 'stroke-zinc-700' : 'stroke-zinc-200'}
                  />
                  <XAxis
                    dataKey="name"
                    tick={{ fill: darkMode ? '#a1a1aa' : '#71717a' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: darkMode ? '#a1a1aa' : '#71717a' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: darkMode ? '#18181b' : '#fff',
                      borderColor: darkMode ? '#3f3f46' : '#e4e4e7',
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  {pipelineEntries.map(({ id, pipeline, color }) => (
                    <Bar
                      key={id}
                      dataKey={id}
                      name={pipeline?.pipelineName ?? `Pipeline ${id}`}
                      fill={color}
                      radius={4}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
              Overall Performance Radar
            </CardTitle>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              Normalized score across quality, speed, and cost dimensions
            </CardDescription>
          </CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={radarData}>
                <PolarGrid stroke={darkMode ? '#3f3f46' : '#e4e4e7'} />
                <PolarAngleAxis dataKey="metric" tick={{ fill: darkMode ? '#a1a1aa' : '#71717a' }} />
                <PolarRadiusAxis tick={{ fill: darkMode ? '#a1a1aa' : '#71717a' }} angle={30} domain={[0, 100]} />
                {pipelineEntries.map(({ id, pipeline, color }) => (
                  <Radar
                    key={id}
                    name={pipeline?.pipelineName ?? `Pipeline ${id}`}
                    dataKey={id}
                    stroke={color}
                    fill={color}
                    fillOpacity={0.2}
                  />
                ))}
                <Legend />
              </RadarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Summary Table */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
              Metric Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  {pipelineEntries.map(({ id, pipeline }) => (
                    <TableHead key={id}>{pipeline?.pipelineName ?? `Pipeline ${id}`}</TableHead>
                  ))}
                  <TableHead>Best Pipeline</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {METRIC_DEFINITIONS.map((definition) => (
                  <TableRow key={definition.key}>
                    <TableCell>{definition.label}</TableCell>
                    {pipelineEntries.map(({ id, pipeline }) => (
                      <TableCell key={id}>
                        {pipeline ? formatMetricValue(definition.key, pipeline.metrics[definition.key]) : '—'}
                      </TableCell>
                    ))}
                    <TableCell>
                      {latestRun?.bestByMetric[definition.key]
                        ? pipelineMap[latestRun.bestByMetric[definition.key]]?.pipelineName ??
                          latestRun.bestByMetric[definition.key]
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
