import { Link } from 'react-router';
import { useExperimentResults } from '../state/experimentResults';

export const reportPath = (id: string) => `/reports/${encodeURIComponent(id)}`;

export function HistoryPage() {
  const { latestRun } = useExperimentResults();
  return (
    <section className="page max-w-4xl">
      <h1>Experiment history</h1>
      <p className="mt-2 text-muted-foreground">
        The latest completed run is available until you reload this tab.
      </p>
      <div className="mt-6 rounded-xl border bg-card p-6">
        {latestRun ? (
          <>
            <h2>
              <Link
                className="text-primary underline"
                to={reportPath(latestRun.id)}
              >
                {latestRun.name}
              </Link>
            </h2>
            <p className="mt-2 text-muted-foreground">
              {new Date(latestRun.startedAt).toLocaleString()} ·{' '}
              {latestRun.pipelines.length} pipelines
            </p>
          </>
        ) : (
          <>
            <h2>No experiments yet</h2>
            <Link to="/experiments" className="text-primary underline">
              Open experiments
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
