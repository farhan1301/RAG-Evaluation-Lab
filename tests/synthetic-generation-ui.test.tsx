import { mkdtempSync, rmSync } from 'node:fs';
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
import { Generations } from '../backend/src/db/generations';
import { Indexes } from '../backend/src/db/indexes';
import { Jobs } from '../backend/src/db/jobs';
import { Pipelines } from '../backend/src/db/pipelines';
import { SyntheticGenerator } from '../backend/src/generation/generator';
import { createApp } from '../backend/src/http/app';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { runOne } from '../backend/src/jobs/run';
import { createLogger } from '../backend/src/lib/logger';
import { ProviderRegistry } from '../backend/src/providers/registry';
import { DatasetsPage } from '../frontend/src/components/DatasetsPage';
import { listKey, request } from '../frontend/src/data/workspace';
import { send } from './inProcess';

afterEach(() => vi.unstubAllGlobals());

function renderDatasets(cache: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <DatasetsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('renders chat-profile requirement, external data-transfer notice, loading/empty/progress/error states, and review table with leakage badge on DatasetsPage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-gen-ui-'));
  const db = openDatabase(join(dir, 'workspace.db'));
  try {
    const jobs = new Jobs(db, Date.now, 5000);
    const datasets = new Datasets(db, jobs);
    const pipelines = new Pipelines(db);
    const indexes = new Indexes(db, jobs);
    const generations = new Generations(db, datasets, indexes, jobs);
    const sample = datasets.sample().value;
    const chunkingDoc = sample.documents.find(
      (d) => d.name === 'RAG_Best_Practices.txt',
    );
    if (!chunkingDoc) throw new Error('Expected sample document.');

    const storage = new Map([['rag-eval.dataset', sample.id]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
    });

    // 1. Zero chat profiles -> explains chat profile requirement + empty proposals state
    const offlineConfig = readConfig({ BLOB_DIRECTORY: join(dir, 'blobs') });
    const offlineApp = createApp({
      config: offlineConfig,
      datasets,
      pipelines,
      indexes,
      generations,
      logger: createLogger({ write: () => {} }),
      ready: () => true,
    });
    vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
      const headers = Object.fromEntries(
        new Headers(options.headers).entries(),
      );
      const result = await send(
        offlineApp,
        options.method ?? 'GET',
        url,
        options.body ? JSON.parse(String(options.body)) : undefined,
        headers,
      );
      return Response.json(result.body, { status: result.status });
    });

    const emptyCache = new QueryClient();
    emptyCache.setQueryData(
      listKey('datasets'),
      (await request(c.page(c.summary), 'datasets')).items,
    );
    emptyCache.setQueryData(
      ['datasets', sample.id],
      await request(c.dataset, `datasets/${sample.id}`),
    );
    emptyCache.setQueryData(
      ['capabilities'],
      await request(c.capabilities, 'capabilities'),
    );
    emptyCache.setQueryData(['generations', sample.id], {
      items: [],
      nextCursor: null,
    });
    emptyCache.setQueryData(['proposals', sample.id], {
      items: [],
      nextCursor: null,
    });

    const noChatHtml = renderDatasets(emptyCache);
    expect(noChatHtml).toContain('Generate questions');
    expect(noChatHtml).toContain(
      'A configured chat profile is required to generate synthetic questions',
    );
    expect(noChatHtml).toContain('No draft proposals yet.');
    expect(noChatHtml).toContain('Generator chat profile');
    expect(noChatHtml).toContain('Target question count');
    expect(noChatHtml).toContain('Generation seed');
    emptyCache.clear();

    // 2. Loading state when generation/proposal queries have not settled
    const loadingCache = new QueryClient();
    loadingCache.setQueryData(
      listKey('datasets'),
      (await request(c.page(c.summary), 'datasets')).items,
    );
    loadingCache.setQueryData(
      ['datasets', sample.id],
      await request(c.dataset, `datasets/${sample.id}`),
    );
    loadingCache.setQueryData(
      ['capabilities'],
      await request(c.capabilities, 'capabilities'),
    );
    const loadingHtml = renderDatasets(loadingCache);
    expect(loadingHtml).toContain('Loading generation status');
    expect(loadingHtml).toContain('Loading draft proposals');
    loadingCache.clear();

    // 3. Configured cloud chat profile -> external data-transfer notice, active cancel/progress, then populated review table with leakage badge
    const cloudConfig = readConfig({
      BLOB_DIRECTORY: join(dir, 'blobs'),
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_CHAT_MODEL: 'fixture-cloud-chat',
    });
    const fakeOpenAI: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string;
        messages: Array<{ role: string; content: string }>;
      };
      const userText = body.messages[1]?.content ?? '';
      const text =
        userText.match(/Frozen Document Text:\n"""\n([\s\S]*?)\n"""/)?.[1] ??
        '';
      const s1 = 'proper chunking thresholds, overlap configuration';
      const i1 = text.indexOf(s1);
      const s2 = 'maintaining up-to-date embeddings.';
      const i2 = text.indexOf(s2);
      return Response.json({
        id: 'chatcmpl-ui',
        object: 'chat.completion',
        created: 1700000000,
        model: body.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                proposals: [
                  {
                    question: 'Which settings control RAG chunking?',
                    expectedAnswer: 'Set boundary thresholds and overlap.',
                    acceptanceRule: 'Cover both settings.',
                    referenceFacts: ['chunking thresholds'],
                    answerable: true,
                    sourceSpans: [
                      {
                        documentVersionId: chunkingDoc.versionId,
                        start: i1,
                        end: i1 + s1.length,
                        quote: s1,
                      },
                    ],
                    qrels: [{ documentId: chunkingDoc.id, grade: 3 }],
                  },
                  {
                    question: 'How should embeddings be maintained?',
                    expectedAnswer: text,
                    acceptanceRule: 'Refresh embeddings.',
                    referenceFacts: ['maintaining up-to-date embeddings'],
                    answerable: true,
                    sourceSpans: [
                      {
                        documentVersionId: chunkingDoc.versionId,
                        start: i2,
                        end: i2 + s2.length,
                        quote: s2,
                      },
                    ],
                    qrels: [{ documentId: chunkingDoc.id, grade: 2 }],
                  },
                ],
              }),
            },
          },
        ],
      });
    });
    const providers = new ProviderRegistry(cloudConfig, { openai: fakeOpenAI });
    const syntheticGenerator = new SyntheticGenerator({
      generations,
      indexes,
      providers,
    });
    const cloudApp = createApp({
      config: cloudConfig,
      datasets,
      pipelines,
      indexes,
      generations,
      providers,
      logger: createLogger({ write: () => {} }),
      ready: () => true,
    });
    vi.stubGlobal('fetch', async (url: string, options: RequestInit = {}) => {
      const headers = Object.fromEntries(
        new Headers(options.headers).entries(),
      );
      const result = await send(
        cloudApp,
        options.method ?? 'GET',
        url,
        options.body ? JSON.parse(String(options.body)) : undefined,
        headers,
      );
      return Response.json(result.body, { status: result.status });
    });

    generations.createBatch(
      sample.id,
      { documentIds: [chunkingDoc.id], count: 2 },
      { capabilities: cloudConfig.capabilities },
    );

    const activeCache = new QueryClient();
    activeCache.setQueryData(
      listKey('datasets'),
      (await request(c.page(c.summary), 'datasets')).items,
    );
    activeCache.setQueryData(
      ['datasets', sample.id],
      await request(c.dataset, `datasets/${sample.id}`),
    );
    activeCache.setQueryData(
      ['capabilities'],
      await request(c.capabilities, 'capabilities'),
    );
    activeCache.setQueryData(
      ['generations', sample.id],
      await request(
        c.page(c.generationBatch),
        `datasets/${sample.id}/generations?limit=10`,
      ),
    );
    activeCache.setQueryData(
      ['proposals', sample.id],
      await request(
        c.page(c.syntheticProposal),
        `datasets/${sample.id}/proposals?limit=100`,
      ),
    );

    const queuedHtml = renderDatasets(activeCache);
    expect(queuedHtml).toContain('External data transfer:');
    expect(queuedHtml).toContain('fixture-cloud-chat');
    expect(queuedHtml).toContain('Cancel generation');
    expect(queuedHtml).toContain('No worker is running');
    activeCache.clear();

    // Execute worker and render completed review table
    await runOne(jobs, {
      directory: join(dir, 'blobs'),
      cloud: new CloudParser('', undefined),
      indexes,
      generations,
      syntheticGenerator,
    });

    const doneCache = new QueryClient();
    doneCache.setQueryData(
      listKey('datasets'),
      (await request(c.page(c.summary), 'datasets')).items,
    );
    doneCache.setQueryData(
      ['datasets', sample.id],
      await request(c.dataset, `datasets/${sample.id}`),
    );
    doneCache.setQueryData(
      ['capabilities'],
      await request(c.capabilities, 'capabilities'),
    );
    doneCache.setQueryData(
      ['generations', sample.id],
      await request(
        c.page(c.generationBatch),
        `datasets/${sample.id}/generations?limit=10`,
      ),
    );
    doneCache.setQueryData(
      ['proposals', sample.id],
      await request(
        c.page(c.syntheticProposal),
        `datasets/${sample.id}/proposals?limit=100`,
      ),
    );

    const doneHtml = renderDatasets(doneCache);
    expect(doneHtml).toContain('Which settings control RAG chunking?');
    expect(doneHtml).toContain('How should embeddings be maintained?');
    expect(doneHtml).toContain('Leakage flagged');
    expect(doneHtml).toContain('Accept');
    expect(doneHtml).toContain('Edit');
    expect(doneHtml).toContain('Reject');
    expect(doneHtml).toContain('Promote accepted (0) to revision 2');
    doneCache.clear();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
