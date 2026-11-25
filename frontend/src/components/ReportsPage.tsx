import * as c from '@rag-eval/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  FileJson,
  Printer,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { request } from '../data/workspace';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';

const triggerDownload = (
  content: BlobPart,
  filename: string,
  mimeType: string,
) => {
  if (typeof window === 'undefined') return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

function formatMetric(value: number | null) {
  return value === null ? 'Unavailable' : value.toFixed(3);
}

function formatDelta(value: number | null) {
  if (value === null) return 'Not comparable';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(3)}`;
}

function formatMs(value: number | null) {
  return value === null ? 'Unavailable' : `${Math.round(value)} ms`;
}

function formatCost(bucket: c.CostBucket) {
  if (bucket.status === 'zero') return '$0.0000';
  if (bucket.status === 'known' && bucket.totalUsd !== null) {
    return `$${bucket.totalUsd.toFixed(4)}`;
  }
  if (bucket.status === 'partial') {
    return `$${bucket.knownUsd.toFixed(4)} (${bucket.pricedCalls}/${bucket.totalCalls} priced)`;
  }
  return `Unknown (${bucket.totalCalls} unpriced)`;
}

function directionBadgeVariant(
  direction: c.MetricDirection,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  if (direction === 'improved') return 'default';
  if (direction === 'regressed') return 'destructive';
  if (direction === 'unchanged') return 'secondary';
  return 'outline';
}

function stateBadgeVariant(
  state: string,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (state === 'succeeded') return 'default';
  if (state === 'failed') return 'destructive';
  if (state === 'cancelled') return 'outline';
  return 'secondary';
}

export function ReportsPage() {
  const { runId } = useParams();
  const validParam = Boolean(runId && c.id.safeParse(runId).success);

  const latestList = useQuery({
    queryKey: ['runs', 'latest'],
    queryFn: () => request(c.page(c.runSummary), 'runs?limit=1'),
    enabled: !runId,
  });

  const resolvedRunId = runId
    ? validParam
      ? runId
      : ''
    : (latestList.data?.items[0]?.id ?? '');

  const runQuery = useQuery({
    queryKey: ['runs', resolvedRunId],
    queryFn: () => request(c.runDetail, `runs/${resolvedRunId}`),
    enabled: Boolean(resolvedRunId),
  });

  const isLoading =
    (!runId && latestList.isPending) ||
    (Boolean(resolvedRunId) && runQuery.isPending);
  const loadError =
    (!runId && latestList.error?.message) || runQuery.error?.message || null;

  if (!runQuery.data?.pipelines.length) {
    return (
      <section className="page max-w-4xl space-y-3">
        <h1>{runId ? 'Report unavailable' : 'No experiment results yet'}</h1>
        <p className="text-muted-foreground">
          {runId
            ? 'This saved run could not be loaded.'
            : 'Complete an experiment to compare metrics and export its report.'}
        </p>
        {isLoading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading report…
          </p>
        )}
        {loadError && (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        )}
        <Link
          className="text-primary underline"
          to={runId ? '/history' : '/experiments'}
        >
          {runId ? 'Open experiment history' : 'Open experiments'}
        </Link>
      </section>
    );
  }

  return <SavedRunReport run={runQuery.data} />;
}

function TaskEvidenceColumn({
  title,
  task,
  qrelGrades,
}: {
  title: string;
  task: c.RunTaskDetail | null;
  qrelGrades: Map<string, number>;
}) {
  if (!task) {
    return (
      <div className="rounded-lg border p-3 text-sm text-muted-foreground">
        <h4 className="font-medium text-foreground">{title}</h4>
        <p className="mt-2">Task was not evaluated on this side.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3 space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        <div className="flex flex-wrap gap-1">
          <Badge variant={stateBadgeVariant(task.state)}>{task.state}</Badge>
          {task.servingLatencyMs !== null && (
            <Badge variant="outline">
              Serving {Math.round(task.servingLatencyMs)} ms
            </Badge>
          )}
        </div>
      </div>

      {task.errorMessage && (
        <p role="alert" className="text-destructive">
          {task.errorMessage}
        </p>
      )}

      {task.answer && (
        <div className="rounded bg-muted/40 p-2.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <strong className="text-foreground">Answer</strong>
            <span>
              ({task.answer.provider} / {task.answer.model})
            </span>
            {task.answer.abstained && (
              <Badge variant="secondary">Abstained</Badge>
            )}
            <Badge variant="outline">
              {task.answer.citations.length} validated citation
              {task.answer.citations.length === 1 ? '' : 's'}
            </Badge>
            {task.answer.invalidCitations.length > 0 && (
              <Badge variant="destructive">
                {task.answer.invalidCitations.length} rejected
              </Badge>
            )}
          </div>
          <p className="text-sm text-foreground">{task.answer.answerText}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="font-medium text-muted-foreground">
          Retrieved evidence ({task.retrievedItems.length} chunk
          {task.retrievedItems.length === 1 ? '' : 's'}
          {task.retrievedDepth !== null ? `, depth ${task.retrievedDepth}` : ''}
          )
        </div>
        {task.retrievedItems.length === 0 ? (
          <p className="text-muted-foreground">No passages retrieved.</p>
        ) : (
          <ul className="space-y-1.5">
            {task.retrievedItems.map((item) => {
              const grade = qrelGrades.get(item.documentId);
              const cited = task.answer?.citations.includes(item.chunkId);
              return (
                <li key={item.chunkId} className="rounded border p-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-foreground">
                      #{item.finalRank} {item.documentName} (p.{item.page})
                    </span>
                    <span className="text-muted-foreground">
                      score {item.finalScore.toFixed(4)}
                    </span>
                    {item.keywordRank !== null && (
                      <span className="text-muted-foreground">
                        · kw #{item.keywordRank}
                      </span>
                    )}
                    {item.denseRank !== null && (
                      <span className="text-muted-foreground">
                        · dense #{item.denseRank}
                      </span>
                    )}
                    {item.fusedRank !== null && (
                      <span className="text-muted-foreground">
                        · fused #{item.fusedRank}
                      </span>
                    )}
                    {item.rerankRank !== null && (
                      <span className="text-muted-foreground">
                        · rerank #{item.rerankRank}
                      </span>
                    )}
                    {grade !== undefined && grade > 0 && (
                      <Badge variant="default">Gold grade {grade}</Badge>
                    )}
                    {cited && <Badge variant="secondary">Cited</Badge>}
                  </div>
                  <p className="text-muted-foreground">{item.content}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {task.judgeAttempts.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-medium text-muted-foreground">
            Judge evidence &amp; audit trail ({task.judgeAttempts.length})
          </div>
          <ul className="space-y-1">
            {task.judgeAttempts.map((attempt) => {
              const parsed =
                attempt.parsedOutput && typeof attempt.parsedOutput === 'object'
                  ? (attempt.parsedOutput as Record<string, unknown>)
                  : null;
              const rationale =
                typeof parsed?.rationale === 'string'
                  ? parsed.rationale
                  : typeof parsed?.reason === 'string' && parsed.reason.trim()
                    ? parsed.reason
                    : null;
              return (
                <li key={attempt.id} className="rounded border p-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <strong className="text-foreground">
                      {attempt.metricId}
                    </strong>
                    <span className="text-muted-foreground">
                      ({attempt.rubricVersion} · #{attempt.attemptNumber}
                      {attempt.isRepair ? ' repair' : ''} · {attempt.model})
                    </span>
                    <Badge
                      variant={
                        attempt.status === 'succeeded'
                          ? 'secondary'
                          : 'destructive'
                      }
                    >
                      {attempt.status}
                    </Badge>
                    {attempt.score !== null && (
                      <span className="font-medium">
                        {attempt.score.toFixed(3)}
                      </span>
                    )}
                  </div>
                  {rationale && (
                    <p className="text-muted-foreground">{rationale}</p>
                  )}
                  {attempt.reason && attempt.reason !== rationale && (
                    <p className="text-muted-foreground">{attempt.reason}</p>
                  )}
                  {attempt.rawResponseHash && (
                    <p className="text-[11px] text-muted-foreground">
                      Hash: {attempt.rawResponseHash.slice(0, 12)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function SavedRunReport({ run }: { run: c.RunDetail }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'markdown' | 'json' | null>(null);
  const [onlyDiffering, setOnlyDiffering] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Record<string, boolean>>(
    {},
  );

  const runsList = useQuery({
    queryKey: ['runs', 'list'],
    queryFn: () => request(c.page(c.runSummary), 'runs?limit=50'),
  });

  const baselineDefault =
    run.pipelines.find((p) => p.isBaseline)?.pipelineId ??
    run.pipelines[0]?.pipelineId ??
    '';
  const paramBasePipeline = searchParams.get('baselinePipeline') ?? '';
  const baselinePipelineId = run.pipelines.some(
    (p) => p.pipelineId === paramBasePipeline,
  )
    ? paramBasePipeline
    : baselineDefault;

  const paramCompareRun = searchParams.get('compareRun') ?? '';
  const candidateRunId =
    paramCompareRun && c.id.safeParse(paramCompareRun).success
      ? paramCompareRun
      : run.id;

  const candidateRunQuery = useQuery({
    queryKey: ['runs', candidateRunId],
    queryFn: () => request(c.runDetail, `runs/${candidateRunId}`),
    enabled: candidateRunId !== run.id,
  });

  const candidateRun =
    candidateRunId === run.id ? run : (candidateRunQuery.data ?? null);

  const defaultCandidatePipelineId = useMemo(() => {
    if (!candidateRun) return '';
    if (candidateRun.id === run.id) {
      return (
        candidateRun.pipelines.find((p) => p.pipelineId !== baselinePipelineId)
          ?.pipelineId ??
        candidateRun.pipelines[0]?.pipelineId ??
        ''
      );
    }
    return (
      candidateRun.pipelines.find((p) => p.isBaseline)?.pipelineId ??
      candidateRun.pipelines[0]?.pipelineId ??
      ''
    );
  }, [candidateRun, run.id, baselinePipelineId]);

  const paramCandidatePipeline = searchParams.get('candidatePipeline') ?? '';
  const candidatePipelineId = candidateRun?.pipelines.some(
    (p) => p.pipelineId === paramCandidatePipeline,
  )
    ? paramCandidatePipeline
    : defaultCandidatePipelineId;

  const canCompare =
    Boolean(baselinePipelineId && candidateRunId && candidatePipelineId) &&
    !(candidateRunId === run.id && candidatePipelineId === baselinePipelineId);

  const comparisonQuery = useQuery({
    queryKey: [
      'comparisons',
      run.id,
      baselinePipelineId,
      candidateRunId,
      candidatePipelineId,
    ],
    queryFn: () => {
      const params = new URLSearchParams({
        baselineRunId: run.id,
        baselinePipelineId,
        candidateRunId,
        candidatePipelineId,
      });
      return request(c.comparisonResult, `comparisons?${params}`);
    },
    enabled: canCompare,
  });

  const singleTasksQuery = useQuery({
    queryKey: ['runs', run.id, 'tasks', baselinePipelineId],
    queryFn: () =>
      request(
        c.page(c.runTaskDetail),
        `runs/${run.id}/tasks?limit=100&pipelineId=${baselinePipelineId}`,
      ),
    enabled: !canCompare && Boolean(baselinePipelineId),
  });

  const comparison = comparisonQuery.data;

  // Auto-expand the first differing task so reviewers immediately see concrete evidence.
  useEffect(() => {
    if (!comparison?.tasks.length) return;
    const firstDiff = comparison.tasks.find((t) => t.differs);
    if (!firstDiff) return;
    setExpandedTasks((prev) =>
      Object.keys(prev).length > 0 ? prev : { [firstDiff.taskVersionId]: true },
    );
  }, [comparison]);

  const updateCompareParams = (next: {
    baselinePipeline?: string;
    compareRun?: string;
    candidatePipeline?: string;
  }) => {
    const params = new URLSearchParams(searchParams);
    if (next.baselinePipeline !== undefined) {
      params.set('baselinePipeline', next.baselinePipeline);
    }
    if (next.compareRun !== undefined) {
      if (next.compareRun === run.id) params.delete('compareRun');
      else params.set('compareRun', next.compareRun);
    }
    if (next.candidatePipeline !== undefined) {
      if (!next.candidatePipeline) params.delete('candidatePipeline');
      else params.set('candidatePipeline', next.candidatePipeline);
    }
    setSearchParams(params);
  };

  const baseline = run.pipelines.find((p) => p.isBaseline) ?? run.pipelines[0];
  const timestamp = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(run.completedAt ?? run.queuedAt));

  const metricKeys = Array.from(
    new Map(
      run.pipelines
        .flatMap((p) => [
          ...p.retrievalMetrics,
          ...p.judgeMetrics,
          ...p.abstentionMetrics,
        ])
        .map((m) => [`${m.metricId}:${m.cutoff}:${m.evaluationUnit}`, m]),
    ).values(),
  );

  const exportReport = async (format: 'markdown' | 'json') => {
    setExportError(null);
    setExporting(format);
    try {
      const params = new URLSearchParams({ format });
      if (baselinePipelineId) {
        params.set('baselinePipelineId', baselinePipelineId);
      }
      if (canCompare) {
        if (candidateRunId !== run.id) {
          params.set('compareRunId', candidateRunId);
          params.set('comparePipelineId', candidatePipelineId);
        } else {
          params.set('candidatePipelineId', candidatePipelineId);
        }
      }
      const response = await fetch(`/api/v1/runs/${run.id}/export?${params}`);
      if (!response.ok) {
        const detail = c.errorEnvelope.safeParse(
          await response.json().catch(() => null),
        );
        throw new Error(
          detail.success
            ? detail.data.error.message
            : `Export failed (${response.status}).`,
        );
      }
      const ext = format === 'json' ? 'json' : 'md';
      const mime =
        format === 'json'
          ? 'application/json;charset=utf-8'
          : 'text/markdown;charset=utf-8';
      const content = await response.text();
      triggerDownload(content, `run-${run.id.slice(0, 8)}-report.${ext}`, mime);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'Could not export report.',
      );
    } finally {
      setExporting(null);
    }
  };

  const visibleComparisonTasks = useMemo(() => {
    if (!comparison) return [];
    return onlyDiffering
      ? comparison.tasks.filter((t) => t.differs)
      : comparison.tasks;
  }, [comparison, onlyDiffering]);

  const differingCount = useMemo(
    () => (comparison ? comparison.tasks.filter((t) => t.differs).length : 0),
    [comparison],
  );

  const availableRuns = runsList.data?.items ?? [];

  return (
    <div className="print-report px-4 py-6 sm:p-8 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1>{run.name}</h1>
              <Badge variant={stateBadgeVariant(run.state)}>{run.state}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {timestamp} · {run.datasetName} (r{run.datasetRevision}) ·{' '}
              {run.mode} · {run.completedUnits}/{run.totalUnits} units completed
            </p>
            <p className="text-xs text-muted-foreground">
              Frozen snapshot: retrieval {run.snapshot.retrievalMetricVersion} ·
              prompt {run.snapshot.promptVersion} · price table{' '}
              {run.snapshot.priceScheduleVersion} · cutoffs{' '}
              {run.snapshot.cutoffs.join(', ')}
            </p>
          </div>
          <div className="no-print flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={exporting !== null}
              onClick={() => void exportReport('markdown')}
            >
              <Download size={16} aria-hidden="true" />
              {exporting === 'markdown' ? 'Exporting…' : 'Export Markdown'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={exporting !== null}
              onClick={() => void exportReport('json')}
            >
              <FileJson size={16} aria-hidden="true" />
              {exporting === 'json' ? 'Exporting…' : 'Export JSON'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => window.print()}
            >
              <Printer size={16} aria-hidden="true" />
              Print / Save PDF
            </Button>
          </div>
        </div>

        {exportError && (
          <p role="alert" className="text-sm text-destructive">
            {exportError}
          </p>
        )}

        {run.state !== 'succeeded' && (
          <Card className="print-card border-amber-300 dark:border-amber-700">
            <CardContent className="py-3 text-sm">
              <strong>Run status: {run.state}.</strong>{' '}
              {run.errorMessage ??
                'Metrics and evidence below reflect the persisted checkpointed observations recorded before completion stopped.'}
            </CardContent>
          </Card>
        )}

        <Card className="print-card">
          <CardHeader>
            <CardTitle>Pipeline Comparison Overview</CardTitle>
            <CardDescription>
              Baseline: {baseline?.pipelineName ?? 'None'} · Price schedule:{' '}
              {run.snapshot.priceScheduleVersion} · Serving p50/p95:{' '}
              {formatMs(run.latency.serving.p50Ms)} /{' '}
              {formatMs(run.latency.serving.p95Ms)} (n=
              {run.latency.serving.sampleSize})
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pipeline</TableHead>
                  {metricKeys.map((m) => (
                    <TableHead
                      key={`${m.metricId}:${m.cutoff}:${m.evaluationUnit}`}
                      className="text-right"
                    >
                      {m.displayLabel}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Serving p95</TableHead>
                  <TableHead className="text-right">Total spend</TableHead>
                  <TableHead className="text-right">Retry spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.pipelines.map((pl) => {
                  const lookup = new Map(
                    [
                      ...pl.retrievalMetrics,
                      ...pl.judgeMetrics,
                      ...pl.abstentionMetrics,
                    ].map((m) => [
                      `${m.metricId}:${m.cutoff}:${m.evaluationUnit}`,
                      m,
                    ]),
                  );
                  return (
                    <TableRow key={pl.pipelineId}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <span>{pl.pipelineName}</span>
                          {pl.isBaseline && (
                            <Badge variant="outline">Baseline</Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          r{pl.pipelineRevision} · {pl.config.retriever.mode} ·
                          topK {pl.config.retriever.topK}
                        </div>
                      </TableCell>
                      {metricKeys.map((m) => {
                        const entry = lookup.get(
                          `${m.metricId}:${m.cutoff}:${m.evaluationUnit}`,
                        );
                        return (
                          <TableCell
                            key={`${m.metricId}:${m.cutoff}:${m.evaluationUnit}`}
                            className="text-right text-xs"
                          >
                            <div>{formatMetric(entry?.mean ?? null)}</div>
                            {entry && (
                              <div className="text-muted-foreground">
                                {entry.eligibleCount}/{entry.totalCount}
                                {entry.hasPartialPool &&
                                entry.meanJudgedCoverage !== null
                                  ? ` · ${Math.round(entry.meanJudgedCoverage * 100)}% judged`
                                  : ''}
                              </div>
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right text-xs">
                        {formatMs(pl.latency.serving.p95Ms)}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatCost(pl.cost.total)}
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {formatCost(pl.cost.retry)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="print-card">
          <CardHeader>
            <CardTitle>Paired Comparison &amp; Historical Diff</CardTitle>
            <CardDescription>
              Compare two pipelines in this run or against another saved run on
              identical task versions.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="no-print grid gap-3 md:grid-cols-3">
              <div>
                <label
                  htmlFor="report-baseline-pipeline"
                  className="block text-sm font-medium"
                >
                  Baseline pipeline
                </label>
                <select
                  id="report-baseline-pipeline"
                  className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                  value={baselinePipelineId}
                  onChange={(e) =>
                    updateCompareParams({ baselinePipeline: e.target.value })
                  }
                >
                  {run.pipelines.map((p) => (
                    <option key={p.pipelineId} value={p.pipelineId}>
                      {p.pipelineName} (r{p.pipelineRevision})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="report-candidate-run"
                  className="block text-sm font-medium"
                >
                  Candidate run
                </label>
                <select
                  id="report-candidate-run"
                  className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                  value={candidateRunId}
                  onChange={(e) =>
                    updateCompareParams({
                      compareRun: e.target.value,
                      candidatePipeline: '',
                    })
                  }
                >
                  <option value={run.id}>
                    This run: {run.name} ({run.datasetName} r
                    {run.datasetRevision})
                  </option>
                  {availableRuns
                    .filter((item) => item.id !== run.id)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.datasetName} r{item.datasetRevision}{' '}
                        · {item.state})
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="report-candidate-pipeline"
                  className="block text-sm font-medium"
                >
                  Candidate pipeline
                </label>
                <select
                  id="report-candidate-pipeline"
                  className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                  value={candidatePipelineId}
                  disabled={!candidateRun}
                  onChange={(e) =>
                    updateCompareParams({ candidatePipeline: e.target.value })
                  }
                >
                  {(candidateRun?.pipelines ?? []).map((p) => (
                    <option key={p.pipelineId} value={p.pipelineId}>
                      {p.pipelineName} (r{p.pipelineRevision})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {!canCompare && (
              <p className="text-sm text-muted-foreground">
                Select a second pipeline or another saved run to compute paired
                metric deltas and side-by-side task evidence.
              </p>
            )}

            {canCompare &&
              (comparisonQuery.isPending || candidateRunQuery.isPending) && (
                <p role="status" className="text-sm text-muted-foreground">
                  Computing paired comparison…
                </p>
              )}

            {(comparisonQuery.error || candidateRunQuery.error) && (
              <p role="alert" className="text-sm text-destructive">
                {(comparisonQuery.error ?? candidateRunQuery.error)?.message}
              </p>
            )}

            {comparison && (
              <div className="space-y-6">
                {comparison.incompatibilities.length > 0 && (
                  <div
                    role="alert"
                    className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 space-y-2"
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      <AlertTriangle size={16} aria-hidden="true" />
                      Incompatible comparison fields detected
                    </div>
                    <p>
                      Both runs remain inspectable side by side below, but
                      deltas are suppressed wherever definitions or dataset
                      revisions do not match.
                    </p>
                    <ul className="list-disc pl-5 space-y-1 text-xs">
                      {comparison.incompatibilities.map((item) => (
                        <li key={`${item.scope}-${item.field}`}>
                          <strong>{item.field}</strong>: baseline{' '}
                          <code>{item.baselineValue}</code> vs candidate{' '}
                          <code>{item.candidateValue}</code> — {item.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {comparison.configDiff.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-base font-semibold">
                      Configuration Diff
                    </h3>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Setting</TableHead>
                            <TableHead>
                              Baseline ({comparison.baseline.pipelineName})
                            </TableHead>
                            <TableHead>
                              Candidate ({comparison.candidate.pipelineName})
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {comparison.configDiff.map((diff) => (
                            <TableRow key={diff.path}>
                              <TableCell className="font-mono text-xs">
                                {diff.path}
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {JSON.stringify(diff.baseline)}
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {JSON.stringify(diff.candidate)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <h3 className="text-base font-semibold">
                    Paired Metric Deltas
                  </h3>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Metric</TableHead>
                          <TableHead className="text-right">
                            Baseline (paired)
                          </TableHead>
                          <TableHead className="text-right">
                            Candidate (paired)
                          </TableHead>
                          <TableHead className="text-right">Delta</TableHead>
                          <TableHead>Direction</TableHead>
                          <TableHead className="text-right">
                            Paired / Missing
                          </TableHead>
                          <TableHead className="text-right">
                            95% Bootstrap CI
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {comparison.metrics.map((metric) => (
                          <TableRow
                            key={`${metric.metricId}:${metric.cutoff}:${metric.evaluationUnit}`}
                          >
                            <TableCell className="font-medium text-xs">
                              <div>{metric.displayLabel}</div>
                              <div className="text-muted-foreground">
                                {metric.metricVersion} · {metric.evaluationUnit}
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              {formatMetric(metric.baselineMean)}
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              {formatMetric(metric.candidateMean)}
                            </TableCell>
                            <TableCell className="text-right text-xs font-medium">
                              {formatDelta(metric.absoluteDelta)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={directionBadgeVariant(
                                  metric.direction,
                                )}
                              >
                                {metric.direction.replaceAll('_', ' ')}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              {metric.pairedCount} / {metric.missingPairs}
                            </TableCell>
                            <TableCell className="text-right text-xs">
                              {metric.bootstrapCi ? (
                                <span>
                                  [{formatDelta(metric.bootstrapCi.lower)},{' '}
                                  {formatDelta(metric.bootstrapCi.upper)}]
                                </span>
                              ) : (
                                <span className="text-muted-foreground">
                                  {metric.bootstrapNote ?? 'Unavailable'}
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <strong>Resampling rule:</strong>{' '}
                    {comparison.resamplingRule.description}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {comparison && (
          <Card className="print-card print-page-break">
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle>
                    Per-Task Side-by-Side Evidence ({comparison.tasks.length}{' '}
                    tasks, {differingCount} differing)
                  </CardTitle>
                  <CardDescription>
                    Inspect retrieved passages, generated answers, validated
                    citations, and judge rationales side by side.
                  </CardDescription>
                </div>
                <div className="no-print flex items-center gap-2">
                  <input
                    id="report-only-differing"
                    type="checkbox"
                    checked={onlyDiffering}
                    onChange={(e) => setOnlyDiffering(e.target.checked)}
                  />
                  <label htmlFor="report-only-differing" className="text-sm">
                    Show differing tasks only ({differingCount})
                  </label>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {visibleComparisonTasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No tasks match the current filter.
                </p>
              ) : (
                visibleComparisonTasks.map((task) => {
                  const isOpen = Boolean(expandedTasks[task.taskVersionId]);
                  const qrelGrades = new Map(
                    task.qrels.map((q) => [q.documentId, q.grade]),
                  );
                  return (
                    <article
                      key={task.taskVersionId}
                      className="print-avoid-break rounded-lg border p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="space-y-1">
                          <h3 className="text-sm font-semibold">
                            Q{task.ordinal + 1}: {task.question}
                          </h3>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <Badge variant="outline">
                              {task.answerable ? 'Answerable' : 'Unanswerable'}
                            </Badge>
                            <Badge variant="outline">Pool: {task.pool}</Badge>
                            {task.differs ? (
                              <Badge variant="default">Differs</Badge>
                            ) : (
                              <Badge variant="secondary">Identical</Badge>
                            )}
                            {task.differenceSummary.length > 0 && (
                              <span className="text-muted-foreground">
                                {task.differenceSummary.slice(0, 3).join(' · ')}
                              </span>
                            )}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="no-print gap-1"
                          aria-expanded={isOpen}
                          onClick={() =>
                            setExpandedTasks((prev) => ({
                              ...prev,
                              [task.taskVersionId]: !isOpen,
                            }))
                          }
                        >
                          {isOpen ? (
                            <ChevronDown size={14} aria-hidden="true" />
                          ) : (
                            <ChevronRight size={14} aria-hidden="true" />
                          )}
                          {isOpen ? 'Hide evidence' : 'Inspect evidence'}
                        </Button>
                      </div>

                      <div
                        className={
                          isOpen
                            ? 'space-y-3'
                            : 'hidden print-only-block space-y-3'
                        }
                      >
                        {(task.expectedAnswer ||
                          task.acceptanceRule ||
                          task.referenceFacts.length > 0) && (
                          <div className="rounded bg-muted/30 p-2.5 text-xs space-y-1">
                            {task.expectedAnswer && (
                              <div>
                                <strong>Reference answer:</strong>{' '}
                                {task.expectedAnswer}
                              </div>
                            )}
                            {task.acceptanceRule && (
                              <div>
                                <strong>Acceptance criteria:</strong>{' '}
                                {task.acceptanceRule}
                              </div>
                            )}
                            {task.referenceFacts.length > 0 && (
                              <div>
                                <strong>Reference facts:</strong>{' '}
                                {task.referenceFacts.join(' · ')}
                              </div>
                            )}
                          </div>
                        )}

                        {task.metricDeltas.length > 0 && (
                          <div className="flex flex-wrap gap-2 text-xs">
                            {task.metricDeltas.map((md) => (
                              <span
                                key={`${md.metricId}:${md.cutoff}:${md.evaluationUnit}`}
                                className="rounded border px-2 py-1 bg-background"
                              >
                                <strong>{md.displayLabel}:</strong>{' '}
                                {md.baselineValue !== null
                                  ? md.baselineValue.toFixed(3)
                                  : (md.baselineStatus ?? '—')}{' '}
                                →{' '}
                                {md.candidateValue !== null
                                  ? md.candidateValue.toFixed(3)
                                  : (md.candidateStatus ?? '—')}
                                {md.delta !== null
                                  ? ` (${formatDelta(md.delta)})`
                                  : ''}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="grid gap-3 lg:grid-cols-2">
                          <TaskEvidenceColumn
                            title={`Baseline: ${comparison.baseline.pipelineName}`}
                            task={task.baseline}
                            qrelGrades={qrelGrades}
                          />
                          <TaskEvidenceColumn
                            title={`Candidate: ${comparison.candidate.pipelineName}`}
                            task={task.candidate}
                            qrelGrades={qrelGrades}
                          />
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </CardContent>
          </Card>
        )}

        {!comparison && singleTasksQuery.data && (
          <Card className="print-card print-page-break">
            <CardHeader>
              <CardTitle>
                Per-Task Evidence ({singleTasksQuery.data.items.length} tasks)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {singleTasksQuery.data.items.map((task) => {
                const qrelGrades = new Map(
                  task.qrels.map((q) => [q.documentId, q.grade]),
                );
                return (
                  <article
                    key={task.id}
                    className="print-avoid-break rounded-lg border p-4 space-y-3"
                  >
                    <h3 className="text-sm font-semibold">
                      Q{task.ordinal + 1}: {task.question}
                    </h3>
                    <TaskEvidenceColumn
                      title={task.pipelineName}
                      task={task}
                      qrelGrades={qrelGrades}
                    />
                  </article>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
