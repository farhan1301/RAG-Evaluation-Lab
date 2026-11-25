import * as c from '@rag-eval/contracts';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Link, useParams } from 'react-router';
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
  return 'Unknown';
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

  if (!runQuery.data?.pipelines.length) {
    return (
      <section className="page max-w-4xl">
        <h1>{runId ? 'Report unavailable' : 'No experiment results yet'}</h1>
        <p className="my-3 text-muted-foreground">
          {runId
            ? 'This saved run could not be loaded.'
            : 'Complete an experiment to compare metrics and export its report.'}
        </p>
        {(runQuery.isPending && resolvedRunId) ||
        (!runId && latestList.isPending) ? (
          <p role="status" className="my-2 text-sm text-muted-foreground">
            Loading report…
          </p>
        ) : null}
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

function SavedRunReport({ run }: { run: c.RunDetail }) {
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
        .map((m) => [`${m.metricId}:${m.cutoff}`, m]),
    ).values(),
  );

  const buildMarkdown = () => {
    const lines: string[] = [
      `# ${run.name}`,
      '',
      `Generated on ${timestamp}`,
      `Dataset: ${run.datasetName} (revision ${run.datasetRevision}) · Mode: ${run.mode} · Price schedule: ${run.snapshot.priceScheduleVersion}`,
      '',
      '## Pipeline Comparison',
      '',
    ];
    const headers = [
      'Pipeline',
      ...metricKeys.map((m) => m.displayLabel),
      'Serving p95',
      'Total spend',
      'Retry spend',
    ];
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
    for (const pl of run.pipelines) {
      const lookup = new Map(
        [
          ...pl.retrievalMetrics,
          ...pl.judgeMetrics,
          ...pl.abstentionMetrics,
        ].map((m) => [`${m.metricId}:${m.cutoff}`, m]),
      );
      const cells = metricKeys.map((m) => {
        const entry = lookup.get(`${m.metricId}:${m.cutoff}`);
        if (!entry) return 'Unavailable';
        return `${formatMetric(entry.mean)} (${entry.eligibleCount}/${entry.totalCount})`;
      });
      lines.push(
        `| ${[
          pl.isBaseline ? `${pl.pipelineName} (Baseline)` : pl.pipelineName,
          ...cells,
          formatMs(pl.latency.serving.p95Ms),
          formatCost(pl.cost.total),
          formatCost(pl.cost.retry),
        ].join(' | ')} |`,
      );
    }
    return lines.join('\n');
  };

  return (
    <div className="px-4 py-6 sm:p-8 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1>{run.name}</h1>
            <p className="text-muted-foreground">
              {timestamp} · {run.datasetName} (r{run.datasetRevision}) ·{' '}
              {run.mode}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            onClick={() =>
              triggerDownload(
                buildMarkdown(),
                `run-${run.id.slice(0, 8)}-report.md`,
                'text/markdown',
              )
            }
          >
            <Download size={16} aria-hidden="true" />
            Export Markdown
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Pipeline Comparison Overview</CardTitle>
            <CardDescription>
              Baseline: {baseline?.pipelineName ?? 'None'} · Price schedule:{' '}
              {run.snapshot.priceScheduleVersion}
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pipeline</TableHead>
                  {metricKeys.map((m) => (
                    <TableHead
                      key={`${m.metricId}:${m.cutoff}`}
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
                    ].map((m) => [`${m.metricId}:${m.cutoff}`, m]),
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
                      </TableCell>
                      {metricKeys.map((m) => {
                        const entry = lookup.get(`${m.metricId}:${m.cutoff}`);
                        return (
                          <TableCell
                            key={`${m.metricId}:${m.cutoff}`}
                            className="text-right text-xs"
                          >
                            <div>{formatMetric(entry?.mean ?? null)}</div>
                            {entry && (
                              <div className="text-muted-foreground">
                                {entry.eligibleCount}/{entry.totalCount}
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
      </div>
    </div>
  );
}
