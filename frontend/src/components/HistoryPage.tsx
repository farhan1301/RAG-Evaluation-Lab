import * as c from '@rag-eval/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { request } from '../data/workspace';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

export const reportPath = (id: string) => `/reports/${encodeURIComponent(id)}`;

function stateBadgeVariant(
  state: string,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (state === 'succeeded') return 'default';
  if (state === 'failed') return 'destructive';
  if (state === 'cancelled') return 'outline';
  return 'secondary';
}

export function HistoryPage() {
  const navigate = useNavigate();
  const [stateFilter, setStateFilter] = useState('');
  const [datasetFilter, setDatasetFilter] = useState('');
  const [compareBaseline, setCompareBaseline] = useState('');
  const [compareCandidate, setCompareCandidate] = useState('');

  const runs = useQuery({
    queryKey: ['runs', 'list'],
    queryFn: () => request(c.page(c.runSummary), 'runs?limit=50'),
  });

  const allItems = runs.data?.items ?? [];

  const datasets = useMemo(
    () =>
      Array.from(
        new Map(allItems.map((r) => [r.datasetId, r.datasetName])).entries(),
      ),
    [allItems],
  );

  const items = useMemo(
    () =>
      allItems.filter(
        (run) =>
          (!stateFilter || run.state === stateFilter) &&
          (!datasetFilter || run.datasetId === datasetFilter),
      ),
    [allItems, stateFilter, datasetFilter],
  );

  const effectiveBaseline =
    allItems.find((r) => r.id === compareBaseline)?.id ?? allItems[1]?.id ?? '';
  const effectiveCandidate =
    allItems.find((r) => r.id === compareCandidate)?.id ??
    allItems[0]?.id ??
    '';

  return (
    <section className="page max-w-5xl space-y-5">
      <div>
        <h1>Experiment history</h1>
        <p className="mt-2 text-muted-foreground">
          Persisted server-side evaluation runs survive reloads and worker
          restarts. Open any saved run report or compare two runs side by side.
        </p>
      </div>

      {runs.error && (
        <p role="alert" className="text-sm text-destructive">
          {runs.error.message}
        </p>
      )}

      {allItems.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Compare two saved runs</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3 sm:items-end">
            <div>
              <label
                htmlFor="history-compare-baseline"
                className="block text-sm font-medium"
              >
                Baseline run
              </label>
              <select
                id="history-compare-baseline"
                className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                value={effectiveBaseline}
                onChange={(e) => setCompareBaseline(e.target.value)}
              >
                {allItems.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.datasetName} r{r.datasetRevision} · {r.state})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="history-compare-candidate"
                className="block text-sm font-medium"
              >
                Candidate run
              </label>
              <select
                id="history-compare-candidate"
                className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                value={effectiveCandidate}
                onChange={(e) => setCompareCandidate(e.target.value)}
              >
                {allItems.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.datasetName} r{r.datasetRevision} · {r.state})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={
                  !effectiveBaseline ||
                  !effectiveCandidate ||
                  effectiveBaseline === effectiveCandidate
                }
                onClick={() =>
                  navigate(
                    `${reportPath(effectiveBaseline)}?compareRun=${encodeURIComponent(effectiveCandidate)}`,
                  )
                }
              >
                Compare selected runs
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {allItems.length > 0 && (
        <div className="flex flex-wrap gap-4">
          <div>
            <label
              htmlFor="history-filter-dataset"
              className="block text-xs font-medium text-muted-foreground"
            >
              Filter by dataset
            </label>
            <select
              id="history-filter-dataset"
              className="mt-1 rounded border bg-background p-2 text-sm"
              value={datasetFilter}
              onChange={(e) => setDatasetFilter(e.target.value)}
            >
              <option value="">All datasets</option>
              {datasets.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="history-filter-state"
              className="block text-xs font-medium text-muted-foreground"
            >
              Filter by status
            </label>
            <select
              id="history-filter-state"
              className="mt-1 rounded border bg-background p-2 text-sm"
              value={stateFilter}
              onChange={(e) => setStateFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="succeeded">Succeeded</option>
              <option value="running">Running</option>
              <option value="queued">Queued</option>
              <option value="cancelled">Cancelled</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {items.length > 0 ? (
          items.map((run) => (
            <div
              key={run.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-5"
            >
              <div>
                <h2 className="text-base font-semibold">
                  <Link
                    className="text-primary underline"
                    to={reportPath(run.id)}
                  >
                    {run.name}
                  </Link>
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {new Date(run.queuedAt).toLocaleString()} · {run.datasetName}{' '}
                  (r{run.datasetRevision}) · {run.pipelineCount} pipelines ·{' '}
                  {run.mode} · {run.completedUnits}/{run.totalUnits} units
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={stateBadgeVariant(run.state)}>
                  {run.state}
                </Badge>
                <Link
                  className="text-sm text-primary underline"
                  to={reportPath(run.id)}
                >
                  Open report
                </Link>
                <Link
                  className="text-sm text-primary underline"
                  to={`/experiments?run=${encodeURIComponent(run.id)}`}
                >
                  Inspect
                </Link>
              </div>
            </div>
          ))
        ) : allItems.length > 0 ? (
          <div className="rounded-xl border bg-card p-6 space-y-2">
            <h2>No runs match the active filters</h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDatasetFilter('');
                setStateFilter('');
              }}
            >
              Reset filters
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border bg-card p-6 space-y-2">
            <h2>No experiments yet</h2>
            {runs.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading saved runs…
              </p>
            )}
            <Link to="/experiments" className="text-primary underline">
              Open experiments
            </Link>
          </div>
        )}
      </div>
    </section>
  );
}
