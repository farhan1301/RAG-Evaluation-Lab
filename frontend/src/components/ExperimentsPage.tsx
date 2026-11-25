import * as c from '@rag-eval/contracts';
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { FileText, Play, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  pipelineQuery,
  request,
  useCapabilities,
  useDatasetSelection,
  useList,
  useSelection,
} from '../data/workspace';
import { reportPath } from './HistoryPage';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';

const ACTIVE_STATES = new Set<c.JobState>([
  'queued',
  'running',
  'cancellation_requested',
]);

function formatMetric(value: number | null) {
  return value === null ? 'Unavailable' : value.toFixed(3);
}

function formatMs(value: number | null) {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function formatCostBucket(bucket: c.CostBucket) {
  if (bucket.status === 'zero') return '$0.0000';
  if (bucket.status === 'known' && bucket.totalUsd !== null) {
    return `$${bucket.totalUsd.toFixed(4)}`;
  }
  if (bucket.status === 'partial') {
    return `$${bucket.knownUsd.toFixed(4)} partial (${bucket.pricedCalls}/${bucket.totalCalls} priced)`;
  }
  return `Unknown (${bucket.totalCalls} unpriced)`;
}

function stateBadgeVariant(
  state: string,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (state === 'succeeded') return 'default';
  if (state === 'failed') return 'destructive';
  if (state === 'cancelled') return 'outline';
  return 'secondary';
}

export function ExperimentsPage() {
  const cache = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { detail: datasetDetail, list: datasetList } = useDatasetSelection();
  const pipelineList = useList('pipelines');
  const capabilities = useCapabilities();
  const [baselineId, setBaselineId] = useSelection(
    'rag-eval.baseline',
    pipelineList.data,
  );

  const pipelineDetails = useQueries({
    queries: (pipelineList.data ?? []).map((p) => pipelineQuery(p.id)),
  });
  const savedPipelines = useMemo(
    () => pipelineDetails.flatMap((q) => (q.data ? [q.data] : [])),
    [pipelineDetails],
  );

  const [selectedPipelineIds, setSelectedPipelineIds] = useState<string[]>([]);
  const [mode, setMode] = useState<c.RunMode>('retrieval_only');
  const [judgeEnabled, setJudgeEnabled] = useState(true);
  const [runName, setRunName] = useState('');
  const [inspectedPipelineId, setInspectedPipelineId] = useState('');

  useEffect(() => {
    const allIds = (pipelineList.data ?? []).map((p) => p.id);
    if (!allIds.length) return;
    setSelectedPipelineIds((prev) => {
      const kept = prev.filter((id) => allIds.includes(id));
      return kept.length ? kept : allIds;
    });
  }, [pipelineList.data]);

  const effectiveBaseline =
    baselineId && selectedPipelineIds.includes(baselineId)
      ? baselineId
      : (selectedPipelineIds[0] ?? '');

  const runsList = useQuery({
    queryKey: ['runs', 'list'],
    queryFn: () => request(c.page(c.runSummary), 'runs?limit=20'),
  });

  const requestedRunId = searchParams.get('run') ?? '';
  const activeRunId = requestedRunId || runsList.data?.items[0]?.id || '';

  const runDetailQuery = useQuery({
    queryKey: ['runs', activeRunId],
    queryFn: () => request(c.runDetail, `runs/${activeRunId}`),
    enabled: Boolean(activeRunId),
    refetchInterval: (q) =>
      q.state.data && ACTIVE_STATES.has(q.state.data.state) ? 1500 : false,
  });

  const activeRun = runDetailQuery.data;

  const jobQuery = useQuery({
    queryKey: ['jobs', activeRun?.jobId ?? ''],
    queryFn: () => request(c.job, `jobs/${activeRun?.jobId}`),
    enabled: Boolean(activeRun?.jobId),
    refetchInterval: (q) =>
      q.state.data && ACTIVE_STATES.has(q.state.data.state) ? 1500 : false,
  });

  useEffect(() => {
    if (!activeRun?.pipelines.length) return;
    setInspectedPipelineId((prev) =>
      activeRun.pipelines.some((p) => p.pipelineId === prev)
        ? prev
        : activeRun.pipelines[0].pipelineId,
    );
  }, [activeRun]);

  const tasksQuery = useQuery({
    queryKey: ['runs', activeRunId, 'tasks', inspectedPipelineId],
    queryFn: () =>
      request(
        c.page(c.runTaskDetail),
        `runs/${activeRunId}/tasks?limit=100${inspectedPipelineId ? `&pipelineId=${inspectedPipelineId}` : ''}`,
      ),
    enabled: Boolean(activeRunId && inspectedPipelineId),
    refetchInterval: () =>
      activeRun && ACTIVE_STATES.has(activeRun.state) ? 2000 : false,
  });

  // Polling stops when the run finishes, so fetch the task list once more to
  // pick up the final per-task states instead of the last in-flight snapshot.
  const activeRunState = activeRun?.state;
  useEffect(() => {
    if (!activeRunId || !activeRunState || ACTIVE_STATES.has(activeRunState))
      return;
    void cache.invalidateQueries({ queryKey: ['runs', activeRunId, 'tasks'] });
  }, [cache, activeRunId, activeRunState]);

  const startRun = useMutation({
    mutationFn: async () => {
      const ds = datasetDetail.data;
      if (!ds) throw new Error('Select a dataset before starting a run.');
      if (!selectedPipelineIds.length)
        throw new Error('Select at least one pipeline.');
      if (!effectiveBaseline) throw new Error('Choose a baseline pipeline.');

      const expName =
        runName.trim() ||
        `${ds.name} (${mode === 'retrieval_only' ? 'Retrieval' : 'Full RAG'})`;
      const createdExp = await request(c.experiment, 'experiments', 'POST', {
        name: expName,
        datasetId: ds.id,
        baselinePipelineId: effectiveBaseline,
        pipelineIds: selectedPipelineIds,
        mode,
        config: {
          judgeEnabled: mode === 'full_rag' ? judgeEnabled : false,
        },
      });
      return request(
        c.createRunResult,
        `experiments/${createdExp.id}/runs`,
        'POST',
        {
          name: runName.trim() || undefined,
          mode,
          judgeEnabled: mode === 'full_rag' ? judgeEnabled : false,
        },
        undefined,
        crypto.randomUUID(),
      );
    },
    onSuccess: async (res) => {
      setSearchParams({ run: res.run.id });
      cache.setQueryData(['runs', res.run.id], res.run);
      cache.setQueryData(['jobs', res.job.id], res.job);
      await cache.invalidateQueries({ queryKey: ['runs', 'list'] });
    },
  });

  const cancelRun = useMutation({
    mutationFn: async (jobId: string) =>
      request(c.job, `jobs/${jobId}/cancel`, 'POST', {}),
    onSuccess: async (updatedJob) => {
      cache.setQueryData(['jobs', updatedJob.id], updatedJob);
      await cache.invalidateQueries({ queryKey: ['runs', activeRunId] });
      await cache.invalidateQueries({ queryKey: ['runs', 'list'] });
    },
  });

  const retryRun = useMutation({
    mutationFn: async (jobId: string) =>
      request(c.job, `jobs/${jobId}/retry`, 'POST', {}),
    onSuccess: async (nextJob) => {
      cache.setQueryData(['jobs', nextJob.id], nextJob);
      await cache.invalidateQueries({ queryKey: ['runs', activeRunId] });
      await cache.invalidateQueries({ queryKey: ['runs', 'list'] });
    },
  });

  const profiles = capabilities.data?.profiles ?? [];
  const hasChat = profiles.some((p) => p.role === 'chat');
  const hasJudge = profiles.some((p) => p.role === 'judge');

  const isRunActive = Boolean(activeRun && ACTIVE_STATES.has(activeRun.state));
  const progressPct =
    activeRun && activeRun.totalUnits > 0
      ? Math.round(
          ((activeRun.completedUnits + activeRun.failedUnits) /
            activeRun.totalUnits) *
            100,
        )
      : 0;

  const submissionError =
    startRun.error?.message ??
    cancelRun.error?.message ??
    retryRun.error?.message ??
    runDetailQuery.error?.message ??
    null;

  const dataset = datasetDetail.data;
  const canStart =
    Boolean(dataset) &&
    (dataset?.documents.length ?? 0) > 0 &&
    (dataset?.tasks.length ?? 0) > 0 &&
    selectedPipelineIds.length > 0 &&
    !startRun.isPending;

  return (
    <div className="px-4 py-6 sm:p-8 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1>Experiment Runner</h1>
            <p className="text-muted-foreground">
              Freeze dataset and pipeline revisions into durable server-side
              runs with auditable retrieval, generation, judge, and spend
              tracking.
            </p>
          </div>
          <Button
            type="button"
            size="lg"
            className="gap-2"
            disabled={!canStart}
            onClick={() => startRun.mutate()}
          >
            <Play size={18} aria-hidden="true" />
            {startRun.isPending ? 'Submitting run…' : 'Start Run'}
          </Button>
        </div>

        {submissionError && (
          <Card
            role="alert"
            className="border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300"
          >
            <CardContent className="py-4 text-sm">
              {submissionError}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Run Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <p className="text-sm font-medium">Dataset</p>
                {datasetList.isPending ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    Loading datasets…
                  </p>
                ) : dataset ? (
                  <p className="text-sm text-muted-foreground">
                    {dataset.name} · r{dataset.revision} ·{' '}
                    {dataset.documents.length} docs · {dataset.tasks.length}{' '}
                    tasks
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No dataset selected.{' '}
                    <Link to="/datasets" className="text-primary underline">
                      Create or load sample dataset
                    </Link>
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="experiment-execution-mode"
                  className="block text-sm"
                >
                  Execution mode
                </label>
                <select
                  id="experiment-execution-mode"
                  className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                  value={mode}
                  onChange={(e) => setMode(c.runMode.parse(e.target.value))}
                >
                  <option value="retrieval_only">
                    Retrieval only (offline deterministic metrics)
                  </option>
                  <option value="full_rag" disabled={!hasChat}>
                    Full RAG (retrieve, answer, judge)
                    {!hasChat ? ' — configure chat profile' : ''}
                  </option>
                </select>
              </div>

              <div>
                <label htmlFor="experiment-run-name" className="block text-sm">
                  Run name (optional)
                </label>
                <Input
                  id="experiment-run-name"
                  className="mt-1"
                  value={runName}
                  onChange={(e) => setRunName(e.target.value)}
                  placeholder="e.g. Keyword vs Hybrid baseline"
                />
              </div>
            </div>

            {mode === 'full_rag' && (
              <div className="flex items-center gap-2 text-sm">
                <input
                  id="experiment-judge-enabled"
                  type="checkbox"
                  checked={judgeEnabled && hasJudge}
                  disabled={!hasJudge}
                  onChange={(e) => setJudgeEnabled(e.target.checked)}
                />
                <label htmlFor="experiment-judge-enabled">
                  Run structured LLM-judge rubrics
                  {!hasJudge && ' (configure a judge profile to enable)'}
                </label>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Pipelines to compare</p>
              {pipelineList.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading pipelines…
                </p>
              ) : savedPipelines.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No pipelines saved.{' '}
                  <Link to="/pipelines" className="text-primary underline">
                    Create a pipeline
                  </Link>
                </p>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {savedPipelines.map((pl) => {
                    const checked = selectedPipelineIds.includes(pl.id);
                    const isBase = effectiveBaseline === pl.id;
                    const checkboxId = `experiment-pipeline-${pl.id}`;
                    return (
                      <div
                        key={pl.id}
                        className="flex items-center justify-between gap-2 rounded border p-2.5 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            id={checkboxId}
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedPipelineIds((prev) =>
                                e.target.checked
                                  ? [...prev, pl.id]
                                  : prev.filter((id) => id !== pl.id),
                              );
                            }}
                          />
                          <label
                            htmlFor={checkboxId}
                            className="cursor-pointer"
                          >
                            <strong>{pl.name}</strong> (r{pl.revision} ·{' '}
                            {pl.config.retriever.mode} · topK{' '}
                            {pl.config.retriever.topK})
                          </label>
                        </div>
                        {checked && (
                          <Button
                            type="button"
                            size="sm"
                            variant={isBase ? 'default' : 'outline'}
                            onClick={() => setBaselineId(pl.id)}
                          >
                            {isBase ? 'Baseline' : 'Set baseline'}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Experiment Progress</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                {activeRun ? (
                  <>
                    <Badge variant={stateBadgeVariant(activeRun.state)}>
                      {activeRun.state}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void runDetailQuery.refetch();
                        void jobQuery.refetch();
                        void tasksQuery.refetch();
                      }}
                    >
                      <RefreshCw size={14} aria-hidden="true" /> Refresh status
                    </Button>
                    {isRunActive && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={cancelRun.isPending}
                        onClick={() => cancelRun.mutate(activeRun.jobId)}
                      >
                        <Square size={14} aria-hidden="true" /> Cancel run
                      </Button>
                    )}
                    {['failed', 'cancelled'].includes(activeRun.state) && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={retryRun.isPending}
                        onClick={() => retryRun.mutate(activeRun.jobId)}
                      >
                        <RotateCcw size={14} aria-hidden="true" /> Retry run
                      </Button>
                    )}
                    {['succeeded', 'failed', 'cancelled'].includes(
                      activeRun.state,
                    ) && (
                      <Button asChild size="sm" variant="outline">
                        <Link to={reportPath(activeRun.id)} className="gap-1.5">
                          <FileText size={14} aria-hidden="true" /> Open Report
                        </Link>
                      </Button>
                    )}
                  </>
                ) : (
                  <Badge variant="outline">Not Started</Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeRun ? (
              <>
                <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {activeRun.name}
                  </span>
                  <span>
                    Dataset {activeRun.datasetName} (r
                    {activeRun.datasetRevision})
                  </span>
                  <span>Mode: {activeRun.mode}</span>
                  <span>Stage: {activeRun.stage}</span>
                  <span>
                    Price table: {activeRun.snapshot.priceScheduleVersion}
                  </span>
                </div>

                {isRunActive && !activeRun.workerOnline && (
                  <p
                    role="status"
                    className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
                  >
                    No worker is running — start it with{' '}
                    <code>npm run dev:worker</code>. Reloading this page keeps
                    your queued run intact.
                  </p>
                )}

                <div>
                  <div className="flex items-center justify-between mb-2 text-sm">
                    <span>
                      Checkpointed units: {activeRun.completedUnits} completed,{' '}
                      {activeRun.failedUnits} failed / {activeRun.totalUnits}{' '}
                      total
                    </span>
                    <span className="text-muted-foreground">
                      {progressPct}%
                    </span>
                  </div>
                  <Progress
                    aria-label="Overall experiment progress"
                    value={progressPct}
                  />
                </div>

                <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
                  <div className="rounded border p-2.5">
                    <div className="text-muted-foreground">Indexing spend</div>
                    <div className="font-medium">
                      {formatCostBucket(activeRun.cost.indexing)}
                    </div>
                  </div>
                  <div className="rounded border p-2.5">
                    <div className="text-muted-foreground">Serving spend</div>
                    <div className="font-medium">
                      {formatCostBucket(activeRun.cost.serving)}
                    </div>
                  </div>
                  <div className="rounded border p-2.5">
                    <div className="text-muted-foreground">Judging spend</div>
                    <div className="font-medium">
                      {formatCostBucket(activeRun.cost.judging)}
                    </div>
                  </div>
                  <div className="rounded border p-2.5">
                    <div className="text-muted-foreground">Retry spend</div>
                    <div className="font-medium">
                      {formatCostBucket(activeRun.cost.retry)}
                    </div>
                    <div className="text-muted-foreground">
                      {activeRun.tokens.retryTokens.toLocaleString()} retry
                      tokens
                    </div>
                  </div>
                  <div className="rounded border p-2.5">
                    <div className="text-muted-foreground">Total spend</div>
                    <div className="font-medium">
                      {formatCostBucket(activeRun.cost.total)}
                    </div>
                    <div className="text-muted-foreground">
                      {activeRun.tokens.totalTokens.toLocaleString()} tokens
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>
                    Queue wait: {formatMs(activeRun.latency.queueWaitMs)}
                  </span>
                  <span>
                    Wall clock: {formatMs(activeRun.latency.wallClockMs)}
                  </span>
                  <span>
                    Serving p50/p95: {formatMs(activeRun.latency.serving.p50Ms)}{' '}
                    / {formatMs(activeRun.latency.serving.p95Ms)} (n=
                    {activeRun.latency.serving.sampleSize})
                  </span>
                  <span>
                    Evaluation p50/p95:{' '}
                    {formatMs(activeRun.latency.evaluation.p50Ms)} /{' '}
                    {formatMs(activeRun.latency.evaluation.p95Ms)} (n=
                    {activeRun.latency.evaluation.sampleSize})
                  </span>
                </div>

                {activeRun.errorMessage && (
                  <p role="alert" className="text-sm text-red-600">
                    {activeRun.errorMessage}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No server run has been submitted yet. Configure your dataset and
                pipelines above, then click <strong>Start Run</strong>.
              </p>
            )}
          </CardContent>
        </Card>

        {activeRun && activeRun.pipelines.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Pipeline Results</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pipeline</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Retrieval metrics</TableHead>
                    {activeRun.mode === 'full_rag' && (
                      <TableHead>Judge &amp; abstention</TableHead>
                    )}
                    <TableHead>Latency</TableHead>
                    <TableHead>Spend</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeRun.pipelines.map((pl) => (
                    <TableRow key={pl.pipelineId}>
                      <TableCell>
                        <div className="font-medium">
                          {pl.pipelineName}{' '}
                          {pl.isBaseline && (
                            <Badge variant="outline">Baseline</Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          r{pl.pipelineRevision} · {pl.config.retriever.mode} ·
                          topK {pl.config.retriever.topK} ·{' '}
                          {pl.indexReused ? 'Index reused' : 'Index built'}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={stateBadgeVariant(pl.state)}>
                          {pl.state}
                        </Badge>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {pl.completedTasks}/{pl.totalTasks} done
                          {pl.failedTasks > 0
                            ? ` (${pl.failedTasks} failed)`
                            : ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs space-y-0.5">
                        {pl.retrievalMetrics
                          .filter(
                            (m) =>
                              m.cutoff === pl.config.retriever.topK ||
                              m.metricId === 'mrr',
                          )
                          .map((m) => (
                            <div key={`${m.metricId}-${m.cutoff}`}>
                              <strong>{m.displayLabel}:</strong>{' '}
                              {formatMetric(m.mean)} ({m.eligibleCount}/
                              {m.totalCount}
                              {m.hasPartialPool && m.meanJudgedCoverage !== null
                                ? ` · pooled ${(m.meanJudgedCoverage * 100).toFixed(0)}% judged`
                                : ''}
                              )
                            </div>
                          ))}
                      </TableCell>
                      {activeRun.mode === 'full_rag' && (
                        <TableCell className="text-xs space-y-0.5">
                          {[...pl.judgeMetrics, ...pl.abstentionMetrics].map(
                            (m) => (
                              <div key={`${m.metricId}-${m.metricVersion}`}>
                                <strong>{m.displayLabel}:</strong>{' '}
                                {formatMetric(m.mean)} ({m.eligibleCount}/
                                {m.totalCount}
                                {m.failedCount > 0
                                  ? ` · ${m.failedCount} failed`
                                  : ''}
                                )
                              </div>
                            ),
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-xs space-y-0.5 whitespace-nowrap">
                        <div>
                          Serving p50/p95: {formatMs(pl.latency.serving.p50Ms)}{' '}
                          / {formatMs(pl.latency.serving.p95Ms)}
                        </div>
                        {activeRun.mode === 'full_rag' && (
                          <div>
                            Judge p50/p95:{' '}
                            {formatMs(pl.latency.evaluation.p50Ms)} /{' '}
                            {formatMs(pl.latency.evaluation.p95Ms)}
                          </div>
                        )}
                        <div>Index: {formatMs(pl.latency.indexTimeMs)}</div>
                      </TableCell>
                      <TableCell className="text-xs space-y-0.5 whitespace-nowrap">
                        <div>Total: {formatCostBucket(pl.cost.total)}</div>
                        <div>Retry: {formatCostBucket(pl.cost.retry)}</div>
                        <div>
                          Tokens: {pl.tokens.totalTokens.toLocaleString()}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {activeRun && (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Per-Task Evidence &amp; Observations</CardTitle>
                <div className="flex items-center gap-2 text-sm">
                  <label htmlFor="experiment-inspect-pipeline">Pipeline</label>
                  <select
                    id="experiment-inspect-pipeline"
                    className="rounded border bg-background p-1.5 text-sm"
                    value={inspectedPipelineId}
                    onChange={(e) => setInspectedPipelineId(e.target.value)}
                  >
                    {activeRun.pipelines.map((p) => (
                      <option key={p.pipelineId} value={p.pipelineId}>
                        {p.pipelineName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {tasksQuery.isPending && (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading task evidence…
                </p>
              )}
              {tasksQuery.data?.items.map((task) => (
                <div key={task.id} className="rounded-lg border p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium text-sm">
                      Q{task.ordinal + 1}: {task.question}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={stateBadgeVariant(task.state)}>
                        {task.state}
                      </Badge>
                      <Badge variant="outline">
                        {task.answerable ? 'Answerable' : 'Unanswerable'}
                      </Badge>
                      <Badge variant="outline">Pool: {task.pool}</Badge>
                    </div>
                  </div>

                  {task.answer && (
                    <div className="rounded bg-muted/40 p-3 text-sm space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <strong>Answer</strong>
                        <span>
                          ({task.answer.provider} / {task.answer.model})
                        </span>
                        {task.answer.abstained && (
                          <Badge variant="secondary">Abstained</Badge>
                        )}
                        <span>
                          Validated citations: {task.answer.citations.length}
                        </span>
                        {task.answer.reusedFromRunTaskId && (
                          <Badge variant="outline">Reused</Badge>
                        )}
                      </div>
                      <p>{task.answer.answerText}</p>
                    </div>
                  )}

                  {task.retrievedItems.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        Retrieved evidence ({task.retrievedItems.length} chunks,
                        depth {task.retrievedDepth})
                      </p>
                      <ul className="space-y-1 text-xs">
                        {task.retrievedItems.map((item) => (
                          <li
                            key={item.chunkId}
                            className="rounded border p-2 text-muted-foreground"
                          >
                            <span className="font-medium text-foreground">
                              #{item.finalRank} {item.documentName} (p.
                              {item.page})
                            </span>{' '}
                            · score {item.finalScore.toFixed(4)}
                            {item.keywordRank !== null &&
                              ` · kw #${item.keywordRank}`}
                            {item.denseRank !== null &&
                              ` · dense #${item.denseRank}`}
                            {item.fusedRank !== null &&
                              ` · fused #${item.fusedRank}`}
                            {item.rerankRank !== null &&
                              ` · rerank #${item.rerankRank}`}
                            <p className="mt-1 line-clamp-2">{item.content}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {task.observations.length > 0 && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      {task.observations.map((obs) => (
                        <span
                          key={obs.id}
                          className="rounded border px-2 py-1 bg-background"
                          title={obs.reason ?? undefined}
                        >
                          <strong>
                            {obs.metricId}
                            {obs.cutoff > 0 ? `@${obs.cutoff}` : ''}:
                          </strong>{' '}
                          {obs.value === null
                            ? `Unavailable (${obs.status})`
                            : obs.value.toFixed(3)}
                        </span>
                      ))}
                    </div>
                  )}

                  {task.judgeAttempts.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        Judge audit trail ({task.judgeAttempts.length} attempts)
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {task.judgeAttempts.map((a) => (
                          <li key={a.id} className="rounded border p-2">
                            <strong>{a.metricId}</strong> ({a.rubricVersion}) ·
                            attempt #{a.attemptNumber}
                            {a.isRepair ? ' (repair)' : ''} · {a.model} ·{' '}
                            {a.status}
                            {a.score !== null
                              ? ` · score ${a.score.toFixed(3)}`
                              : ''}
                            {a.reason ? ` · ${a.reason}` : ''}
                            {a.rawResponseHash && (
                              <span className="ml-2 text-muted-foreground">
                                hash: {a.rawResponseHash.slice(0, 12)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {runsList.data && runsList.data.items.length > 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Recent Runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {runsList.data.items.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border p-2.5"
                >
                  <div>
                    <button
                      type="button"
                      className="font-medium text-primary underline"
                      onClick={() => setSearchParams({ run: r.id })}
                    >
                      {r.name}
                    </button>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.mode} · {r.completedUnits}/{r.totalUnits} units ·{' '}
                      {new Date(r.queuedAt).toLocaleString()}
                    </span>
                  </div>
                  <Badge variant={stateBadgeVariant(r.state)}>{r.state}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
