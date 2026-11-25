import * as c from '@rag-eval/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { request } from '../data/workspace';
import { Badge } from './ui/badge';

export const reportPath = (id: string) => `/reports/${encodeURIComponent(id)}`;

export function HistoryPage() {
  const runs = useQuery({
    queryKey: ['runs', 'list'],
    queryFn: () => request(c.page(c.runSummary), 'runs?limit=50'),
  });

  const items = runs.data?.items ?? [];

  return (
    <section className="page max-w-4xl space-y-4">
      <div>
        <h1>Experiment history</h1>
        <p className="mt-2 text-muted-foreground">
          Persisted server-side evaluation runs survive reloads and worker
          restarts.
        </p>
      </div>

      {runs.error && (
        <p role="alert" className="text-sm text-red-600">
          {runs.error.message}
        </p>
      )}

      <div className="mt-4 space-y-3">
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
              <div className="flex items-center gap-2">
                <Badge
                  variant={run.state === 'succeeded' ? 'default' : 'secondary'}
                >
                  {run.state}
                </Badge>
                <Link
                  className="text-sm text-primary underline"
                  to={`/experiments?run=${encodeURIComponent(run.id)}`}
                >
                  Inspect
                </Link>
              </div>
            </div>
          ))
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
