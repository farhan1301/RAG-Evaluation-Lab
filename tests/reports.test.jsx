import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { HistoryPage } from '../frontend/src/components/HistoryPage';
import { ReportsPage } from '../frontend/src/components/ReportsPage';

const { downloads } = vi.hoisted(() => ({ downloads: [] }));
vi.mock('../frontend/src/components/ui/button', () => ({
  Button: ({ children, onClick }) => {
    downloads.push(onClick);
    return children;
  },
}));
vi.mock('../frontend/src/state/experimentResults', () => ({
  useExperimentResults: () => ({
    latestRun: {
      id: 'run-42',
      name: 'Fixture',
      startedAt: '2026-01-01T00:00:00Z',
      bestByMetric: {},
      pipelines: [
        {
          pipelineId: 'p',
          pipelineName: 'Candidate',
          metrics: {},
          judgingSummary: {
            judgePassRate: null,
            averageScores: { judgedContextPrecision: null, groundedness: null },
            details: [{ scores: null }],
            coverage: { completed: 0, total: 1 },
          },
        },
      ],
    },
  }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  downloads.length = 0;
});

it('retains unavailable judge metrics and coverage in the report and both downloads', async () => {
  const markup = renderToStaticMarkup(createElement(ReportsPage));
  expect(markup).toContain('could not identify a leading configuration');
  const blobs = [];
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', {
    createElement: () => ({ click: vi.fn() }),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob);
    return 'blob:fixture';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  for (const download of downloads) download();
  expect(blobs.map((blob) => blob.type).sort()).toEqual([
    'application/pdf',
    'text/markdown',
  ]);
  for (const report of [
    markup,
    ...(await Promise.all(blobs.map((blob) => blob.text()))),
  ]) {
    expect(report).toContain('Judge pass rate');
    expect(report).toContain('Judged context precision');
    expect(report).toContain('0/1');
    expect(report.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(3);
  }
});

it('opens the run linked from History and rejects another run ID', () => {
  const history = renderToStaticMarkup(
    <MemoryRouter>
      <HistoryPage />
    </MemoryRouter>,
  );
  expect(history).toContain('href="/reports/run-42"');
  const renderReport = (path) =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reports/:runId" element={<ReportsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  expect(renderReport('/reports/run-42')).toContain(
    'Pipeline Comparison Overview',
  );
  const missing = renderReport('/reports/run-41');
  expect(missing).toContain('Report unavailable');
  expect(missing).not.toContain('Pipeline Comparison Overview');
});
