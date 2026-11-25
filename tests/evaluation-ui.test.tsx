import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Indexes } from '../backend/src/db/indexes';
import { Jobs } from '../backend/src/db/jobs';
import { Pipelines } from '../backend/src/db/pipelines';
import { Runs } from '../backend/src/db/runs';
import { EvaluationRunner } from '../backend/src/evaluation/runner';
import { createApp } from '../backend/src/http/app';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { runOne } from '../backend/src/jobs/run';
import { createLogger } from '../backend/src/lib/logger';
import { ProviderRegistry } from '../backend/src/providers/registry';
import { IndexBuilder } from '../backend/src/retrieval/indexer';
import { RetrievalService } from '../backend/src/retrieval/service';
import { ExperimentsPage } from '../frontend/src/components/ExperimentsPage';
import { RetrievalPreviewPanel } from '../frontend/src/components/RetrievalPreviewPanel';
import {
  listKey,
  pipelineQuery,
  request,
} from '../frontend/src/data/workspace';
import { send } from './inProcess';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('removes frontend/src/lib/chunking.ts and frontend/src/state/experimentResults.tsx', () => {
  expect(
    existsSync(new URL('../frontend/src/lib/chunking.ts', import.meta.url)),
  ).toBe(false);
  expect(
    existsSync(
      new URL('../frontend/src/state/experimentResults.tsx', import.meta.url),
    ),
  ).toBe(false);
});

it('preserves durable run status across a fresh QueryClient reload and renders retrieval preview states', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-eval-ui-'));
  const db = openDatabase(join(dir, 'workspace.db'));
  try {
    const config = readConfig({ BLOB_DIRECTORY: join(dir, 'blobs') });
    const jobs = new Jobs(db, Date.now, 5000);
    const datasets = new Datasets(db, jobs);
    const pipelines = new Pipelines(db);
    const indexes = new Indexes(db, jobs);
    const runs = new Runs(db, datasets, pipelines, indexes, jobs);
    const providers = new ProviderRegistry(config);
    const indexBuilder = new IndexBuilder({ indexes, providers });
    const retrieval = new RetrievalService({ indexes, providers });
    const evaluationRunner = new EvaluationRunner({
      runs,
      indexes,
      indexBuilder,
      retrieval,
      providers,
    });
    const api = createApp({
      config,
      datasets,
      pipelines,
      indexes,
      runs,
      providers,
      retrieval,
      logger: createLogger({ write: () => {} }),
      ready: () => true,
    });

    vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
      const headers = Object.fromEntries(
        new Headers(options.headers).entries(),
      );
      const result = await send(
        api,
        options.method ?? 'GET',
        url,
        options.body ? JSON.parse(String(options.body)) : undefined,
        headers,
      );
      return Response.json(result.body, { status: result.status });
    });

    const sample = datasets.sample().value;
    const p1 = pipelines.create({
      name: 'Offline Baseline',
      config: { retriever: { mode: 'keyword', topK: 3, deduplicate: false } },
    });
    const exp = runs.createExperiment({
      name: 'Durable Reload Run',
      datasetId: sample.id,
      baselinePipelineId: p1.id,
      pipelineIds: [p1.id],
      mode: 'retrieval_only',
    });
    const submitted = runs.createRun(
      exp.id,
      { name: 'Durable Reload Run' },
      {
        capabilities: config.capabilities,
        pricing: config.pricing,
        budgets: config.budgets,
      },
    );

    const storage = new Map([
      ['rag-eval.dataset', sample.id],
      ['rag-eval.baseline', p1.id],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
    });

    // 1. Before worker runs: queued run shows offline worker notice.
    const queuedCache = new QueryClient();
    queuedCache.setQueryData(
      listKey('datasets'),
      (await request(c.page(c.summary), 'datasets')).items,
    );
    queuedCache.setQueryData(
      ['datasets', sample.id],
      await request(c.dataset, `datasets/${sample.id}`),
    );
    queuedCache.setQueryData(
      listKey('pipelines'),
      (await request(c.page(c.summary), 'pipelines')).items,
    );
    await queuedCache.fetchQuery(pipelineQuery(p1.id));
    queuedCache.setQueryData(
      ['capabilities'],
      await request(c.capabilities, 'capabilities'),
    );
    queuedCache.setQueryData(
      ['runs', 'list'],
      await request(c.page(c.runSummary), 'runs?limit=20'),
    );
    queuedCache.setQueryData(
      ['runs', submitted.run.id],
      await request(c.runDetail, `runs/${submitted.run.id}`),
    );

    const queuedHtml = renderToStaticMarkup(
      <QueryClientProvider client={queuedCache}>
        <MemoryRouter initialEntries={[`/experiments?run=${submitted.run.id}`]}>
          <ExperimentsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(queuedHtml).toContain('Durable Reload Run');
    expect(queuedHtml).toContain('No worker is running');
    expect(queuedHtml).toContain('Cancel run');
    expect(queuedHtml).toContain('Refresh status');
    queuedCache.clear();

    // 2. Execute run in worker, then simulate a full browser reload with a brand-new QueryClient!
    while (
      await runOne(jobs, {
        directory: join(dir, 'blobs'),
        cloud: new CloudParser('', undefined),
        indexes,
        indexBuilder,
        runs,
        evaluationRunner,
      })
    ) {
      /* drain */
    }

    const reloadedCache = new QueryClient();
    reloadedCache.setQueryData(
      listKey('datasets'),
      (await request(c.page(c.summary), 'datasets')).items,
    );
    reloadedCache.setQueryData(
      ['datasets', sample.id],
      await request(c.dataset, `datasets/${sample.id}`),
    );
    reloadedCache.setQueryData(
      listKey('pipelines'),
      (await request(c.page(c.summary), 'pipelines')).items,
    );
    await reloadedCache.fetchQuery(pipelineQuery(p1.id));
    reloadedCache.setQueryData(
      ['capabilities'],
      await request(c.capabilities, 'capabilities'),
    );
    reloadedCache.setQueryData(
      ['runs', 'list'],
      await request(c.page(c.runSummary), 'runs?limit=20'),
    );
    const completedRun = await request(c.runDetail, `runs/${submitted.run.id}`);
    reloadedCache.setQueryData(['runs', submitted.run.id], completedRun);
    const completedTasks = await request(
      c.page(c.runTaskDetail),
      `runs/${submitted.run.id}/tasks?limit=100&pipelineId=${p1.id}`,
    );
    reloadedCache.setQueryData(
      ['runs', submitted.run.id, 'tasks', p1.id],
      completedTasks,
    );

    const reloadedHtml = renderToStaticMarkup(
      <QueryClientProvider client={reloadedCache}>
        <MemoryRouter initialEntries={[`/experiments?run=${submitted.run.id}`]}>
          <ExperimentsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(reloadedHtml).toContain('Durable Reload Run');
    expect(reloadedHtml).toContain('succeeded');
    expect(reloadedHtml).toContain('Hit@3');
    expect(reloadedHtml).toContain('nDCG@3');
    expect(reloadedHtml).toContain('Retry spend');
    expect(reloadedHtml).toContain('Open Report');

    // 3. RetrievalPreviewPanel renders ready index generation & empty-index state cleanly.
    const indexList = await request(
      c.page(c.indexGeneration),
      `indexes?limit=50&datasetId=${sample.id}`,
    );
    expect(indexList.items.some((i) => i.state === 'ready')).toBe(true);
    reloadedCache.setQueryData(['indexes', sample.id], indexList);

    const previewWithIndex = renderToStaticMarkup(
      <QueryClientProvider client={reloadedCache}>
        <MemoryRouter>
          <RetrievalPreviewPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(previewWithIndex).toContain('Retrieval Preview');
    expect(previewWithIndex).toContain('Preview search');
    expect(previewWithIndex).toContain('character-window');

    // Exercise the actual POST /api/v1/indexes/:id/search endpoint used by RetrievalPreviewPanel
    const readyGen = indexList.items.find((i) => i.state === 'ready');
    expect(readyGen).toBeDefined();
    const searchRes = await request(
      c.indexSearchResult,
      `indexes/${readyGen?.id}/search`,
      'POST',
      { query: 'embedding cost performance', mode: 'keyword', topK: 3 },
    );
    expect(searchRes.items.length).toBeGreaterThan(0);
    expect(searchRes.items[0]?.keywordRank).toBe(1);
    expect(searchRes.items[0]?.finalRank).toBe(1);

    // Empty-index state
    reloadedCache.setQueryData(['indexes', sample.id], {
      items: [],
      nextCursor: null,
    });
    const emptyPreview = renderToStaticMarkup(
      <QueryClientProvider client={reloadedCache}>
        <MemoryRouter>
          <RetrievalPreviewPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(emptyPreview).toContain('No ready index for this dataset yet');

    // Loading state
    const loadingCache = new QueryClient();
    loadingCache.setQueryData(
      listKey('datasets'),
      (await request(c.page(c.summary), 'datasets')).items,
    );
    const loadingPreview = renderToStaticMarkup(
      <QueryClientProvider client={loadingCache}>
        <MemoryRouter>
          <RetrievalPreviewPanel />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(loadingPreview).toContain('Loading index generations');
    loadingCache.clear();
    reloadedCache.clear();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
