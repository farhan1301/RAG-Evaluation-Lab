import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { buildDocumentationPayload } from '../backend/src/reporting/documentation';
import { formatRunExportMarkdown } from '../backend/src/reporting/export';
import { DocumentationPage } from '../frontend/src/components/DocumentationPage';
import { HistoryPage } from '../frontend/src/components/HistoryPage';
import { ReportsPage } from '../frontend/src/components/ReportsPage';

const { clicks } = vi.hoisted(() => ({ clicks: [] }));
vi.mock('../frontend/src/components/ui/button', () => ({
  Button: ({ children, onClick }) => {
    if (onClick) clicks.push(onClick);
    return children;
  },
}));

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const EXP_ID = '33333333-3333-4333-8333-333333333333';
const DATASET_ID = '44444444-4444-4444-8444-444444444444';
const PIPELINE_ID = '55555555-5555-4555-8555-555555555555';
const JOB_ID = '66666666-6666-4666-8666-666666666666';

const emptyBucket = {
  status: 'zero',
  totalUsd: 0,
  knownUsd: 0,
  pricedCalls: 0,
  totalCalls: 0,
  unpricedModels: [],
};
const unknownBucket = {
  status: 'unknown',
  totalUsd: null,
  knownUsd: 0,
  pricedCalls: 0,
  totalCalls: 1,
  unpricedModels: ['unpriced-judge'],
};
const emptyLatency = { sampleSize: 0, meanMs: null, p50Ms: null, p95Ms: null };

const fixtureRun = c.runDetail.parse({
  id: RUN_ID,
  experimentId: EXP_ID,
  name: 'Fixture',
  mode: 'full_rag',
  state: 'succeeded',
  stage: 'complete',
  datasetId: DATASET_ID,
  datasetRevision: 1,
  datasetName: 'Sample',
  baselinePipelineId: PIPELINE_ID,
  baselinePipelineRevision: 1,
  pipelineCount: 1,
  taskCount: 1,
  completedUnits: 1,
  failedUnits: 0,
  totalUnits: 1,
  jobId: JOB_ID,
  workerOnline: true,
  queuedAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:01.000Z',
  completedAt: '2026-01-01T00:00:02.000Z',
  queueWaitMs: 1000,
  wallClockMs: 1000,
  errorMessage: null,
  snapshot: {
    softwareVersion: '0.1.0',
    datasetId: DATASET_ID,
    datasetRevision: 1,
    datasetName: 'Sample',
    mode: 'full_rag',
    judgeEnabled: true,
    cutoffs: [5],
    contextBudgetChars: 12000,
    filters: null,
    promptVersion: 'grounded-answer-v1',
    retrievalMetricVersion: 'retrieval-v1',
    rubricVersions: { faithfulness: 'faithfulness-v1' },
    priceScheduleVersion: 'unconfigured-v1',
    budgets: { maxTokens: null, maxCostUsd: null },
  },
  pipelines: [
    {
      pipelineId: PIPELINE_ID,
      pipelineRevision: 1,
      ordinal: 0,
      pipelineName: 'Candidate',
      isBaseline: true,
      config: c.pipelineConfig.parse({}),
      configHash: 'a'.repeat(64),
      resolvedModels: {
        embedding: null,
        rerank: null,
        chat: null,
        judge: null,
      },
      indexGenerationId: null,
      indexReused: false,
      state: 'partial',
      errorMessage: null,
      completedTasks: 1,
      failedTasks: 0,
      totalTasks: 1,
      retrievalMetrics: [],
      judgeMetrics: [
        {
          metricId: 'faithfulness',
          metricVersion: 'faithfulness-v1',
          cutoff: 0,
          evaluationUnit: 'answer',
          displayLabel: 'Faithfulness / groundedness',
          mean: null,
          eligibleCount: 0,
          totalCount: 1,
          failedCount: 1,
          excludedCount: 0,
          exclusionBreakdown: { judge_malformed: 1 },
          completionRate: 0,
          hasPartialPool: false,
          meanJudgedCoverage: null,
          passRate: null,
          criticalContradictionCount: 0,
        },
        {
          metricId: 'context_precision',
          metricVersion: 'context-precision-v1',
          cutoff: 0,
          evaluationUnit: 'passage',
          displayLabel: 'Judged passage usefulness (Judged context precision)',
          mean: null,
          eligibleCount: 0,
          totalCount: 1,
          failedCount: 1,
          excludedCount: 0,
          exclusionBreakdown: { judge_failed: 1 },
          completionRate: 0,
          hasPartialPool: false,
          meanJudgedCoverage: null,
          passRate: null,
          criticalContradictionCount: 0,
        },
      ],
      abstentionMetrics: [],
      latency: {
        indexTimeMs: 10,
        retrieval: emptyLatency,
        rerank: emptyLatency,
        generation: emptyLatency,
        serving: { sampleSize: 1, meanMs: 42, p50Ms: 42, p95Ms: 42 },
        evaluation: emptyLatency,
        timeoutCount: 0,
        cancellationCount: 0,
      },
      cost: {
        priceVersion: 'unconfigured-v1',
        currency: 'USD',
        indexing: emptyBucket,
        serving: emptyBucket,
        perQueryServing: {
          status: 'zero',
          usdPerQuery: 0,
          knownUsdPerQuery: 0,
          queryCount: 1,
        },
        judging: unknownBucket,
        retry: emptyBucket,
        total: unknownBucket,
      },
      tokens: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 15,
        retryTokens: 0,
        callsWithUsage: 1,
        totalCalls: 1,
      },
    },
  ],
  cost: {
    priceVersion: 'unconfigured-v1',
    currency: 'USD',
    indexing: emptyBucket,
    serving: emptyBucket,
    perQueryServing: {
      status: 'zero',
      usdPerQuery: 0,
      knownUsdPerQuery: 0,
      queryCount: 1,
    },
    judging: unknownBucket,
    retry: emptyBucket,
    total: unknownBucket,
  },
  tokens: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 15,
    retryTokens: 0,
    callsWithUsage: 1,
    totalCalls: 1,
  },
  latency: {
    queueWaitMs: 1000,
    wallClockMs: 1000,
    serving: { sampleSize: 1, meanMs: 42, p50Ms: 42, p95Ms: 42 },
    evaluation: emptyLatency,
    timeoutCount: 0,
    cancellationCount: 0,
  },
});

const fixtureSummary = c.runSummary.parse({
  id: fixtureRun.id,
  experimentId: fixtureRun.experimentId,
  name: fixtureRun.name,
  mode: fixtureRun.mode,
  state: fixtureRun.state,
  stage: fixtureRun.stage,
  datasetId: fixtureRun.datasetId,
  datasetRevision: fixtureRun.datasetRevision,
  datasetName: fixtureRun.datasetName,
  baselinePipelineId: fixtureRun.baselinePipelineId,
  pipelineCount: fixtureRun.pipelineCount,
  taskCount: fixtureRun.taskCount,
  completedUnits: fixtureRun.completedUnits,
  failedUnits: fixtureRun.failedUnits,
  totalUnits: fixtureRun.totalUnits,
  jobId: fixtureRun.jobId,
  workerOnline: fixtureRun.workerOnline,
  queuedAt: fixtureRun.queuedAt,
  startedAt: fixtureRun.startedAt,
  completedAt: fixtureRun.completedAt,
  queueWaitMs: fixtureRun.queueWaitMs,
  wallClockMs: fixtureRun.wallClockMs,
  errorMessage: fixtureRun.errorMessage,
});

function createHydratedClient() {
  const cache = new QueryClient();
  cache.setQueryData(['runs', 'list'], {
    items: [fixtureSummary],
    nextCursor: null,
  });
  cache.setQueryData(['runs', 'latest'], {
    items: [fixtureSummary],
    nextCursor: null,
  });
  cache.setQueryData(['runs', RUN_ID], fixtureRun);
  return cache;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clicks.length = 0;
});

it('retains unavailable judge metrics, coverage and unknown pricing in the report and server-backed markdown/json export', async () => {
  const cache = createHydratedClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={['/reports']}>
        <Routes>
          <Route path="/reports" element={<ReportsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(markup).toContain('Pipeline Comparison Overview');
  expect(markup).toContain('Faithfulness / groundedness');
  expect(markup).toContain('Judged passage usefulness');
  expect(markup).toContain('0/1');
  expect(markup).toContain('Unavailable');
  expect(markup).toContain('Unknown');

  const exportPayload = c.runExportJson.parse({
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:05.000Z',
    run: fixtureRun,
    comparisons: [],
    tasks: [],
  });
  const serverMarkdown = formatRunExportMarkdown(exportPayload);

  const blobs = [];
  const printSpy = vi.fn();
  const fetchSpy = vi.fn(async (url) => {
    if (String(url).includes('format=json')) {
      return new Response(JSON.stringify(exportPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(serverMarkdown, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    });
  });

  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('window', { print: printSpy });
  vi.stubGlobal('document', {
    createElement: () => ({ click: vi.fn() }),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    blobs.push(blob);
    return 'blob:fixture';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  // Trigger Export Markdown, Export JSON, and Print
  for (const handler of clicks) {
    await handler();
  }
  await vi.waitFor(() => {
    expect(blobs).toHaveLength(2);
  });
  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining(`/api/v1/runs/${RUN_ID}/export?format=markdown`),
  );
  expect(fetchSpy).toHaveBeenCalledWith(
    expect.stringContaining(`/api/v1/runs/${RUN_ID}/export?format=json`),
  );
  expect(printSpy).toHaveBeenCalledTimes(1);
  expect(blobs.map((blob) => blob.type)).toEqual([
    'text/markdown;charset=utf-8',
    'application/json;charset=utf-8',
  ]);
  const md = await blobs[0].text();
  expect(md).toContain('Faithfulness / groundedness');
  expect(md).toContain('Unavailable (0/1)');
  expect(md).toContain('Unknown');
  const json = JSON.parse(await blobs[1].text());
  expect(json.schemaVersion).toBe(1);
  expect(json.run.id).toBe(RUN_ID);
  cache.clear();
});

it('opens the run linked from History and rejects another run ID', () => {
  const cache = createHydratedClient();
  const history = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <HistoryPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(history).toContain(`href="/reports/${RUN_ID}"`);
  const renderReport = (path) =>
    renderToStaticMarkup(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/reports/:runId" element={<ReportsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  expect(renderReport(`/reports/${RUN_ID}`)).toContain(
    'Pipeline Comparison Overview',
  );
  const missing = renderReport(`/reports/${OTHER_RUN_ID}`);
  expect(missing).toContain('Report unavailable');
  expect(missing).not.toContain('Pipeline Comparison Overview');
  cache.clear();
});

it('renders DocumentationPage from derived server configuration and rubrics without hard-coded legacy models', () => {
  const cache = new QueryClient();
  cache.setQueryData(
    ['documentation'],
    buildDocumentationPayload(readConfig({}), true),
  );
  const html = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <DocumentationPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(html).toContain('Documentation sections');
  expect(html).toContain('Reproducible RAG Evaluation Workflow');
  expect(html).not.toContain('Cohere API Key');
  expect(html).not.toContain('GPT-4o');
  cache.clear();
});
