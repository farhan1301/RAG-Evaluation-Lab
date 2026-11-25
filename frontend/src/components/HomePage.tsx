import {
  ArrowRight,
  Database,
  FileText,
  FlaskConical,
  Workflow,
} from 'lucide-react';
import { Link } from 'react-router';

const steps = [
  {
    to: '/datasets',
    title: 'Datasets & Tasks',
    detail:
      'Load sample data or add your own documents and evaluation questions.',
    icon: Database,
  },
  {
    to: '/pipelines',
    title: 'Pipelines',
    detail:
      'Configure a baseline and duplicate it to try another retrieval setup.',
    icon: Workflow,
  },
  {
    to: '/experiments',
    title: 'Experiments',
    detail:
      'Run the pipelines on the same questions and inspect the retrieved passages.',
    icon: FlaskConical,
  },
  {
    to: '/reports',
    title: 'Reports',
    detail: 'Compare quality, latency, and cost, then export your findings.',
    icon: FileText,
  },
];

export function HomePage() {
  return (
    <section className="page max-w-5xl">
      <h1>Compare retrieval pipelines</h1>
      <p className="mt-2 max-w-2xl text-muted-foreground">
        Evaluate how chunking, retrieval, and model choices affect answers on
        your dataset.
      </p>
      <ol className="mt-8 grid gap-4 sm:grid-cols-2">
        {steps.map(({ to, title, detail, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              className="group block h-full rounded-xl border bg-card p-6 hover:border-primary"
            >
              <Icon className="mb-4 text-primary" aria-hidden="true" />
              <h2 className="flex items-center gap-2 text-lg">
                {title}
                <ArrowRight size={16} aria-hidden="true" />
              </h2>
              <p className="mt-2 text-muted-foreground">{detail}</p>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
