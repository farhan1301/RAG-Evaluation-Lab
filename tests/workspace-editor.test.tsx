import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, afterEach } from 'vitest';
import * as c from '@rag-eval/contracts';
import { openDatabase } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Pipelines } from '../backend/src/db/pipelines';
import { readConfig } from '../backend/src/config/env';
import { createApp } from '../backend/src/http/app';
import { createLogger } from '../backend/src/lib/logger';
import { DatasetsPage } from '../frontend/src/components/DatasetsPage';
import { PipelinesPage } from '../frontend/src/components/PipelinesPage';
import { useRunnerInputs } from '../frontend/src/data/legacyRunner';
import {
  request,
  pipelineQuery,
  listKey,
} from '../frontend/src/data/workspace';
import { send } from './inProcess';

afterEach(() => vi.unstubAllGlobals());
it('reloads the editors and runner in a fresh Query client after a server restart, retaining stale drafts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-editors-')),
    path = join(dir, 'workspace.db');
  let db = openDatabase(path);
  try {
    const datasets = new Datasets(db),
      pipelines = new Pipelines(db);
    const d = datasets.sample().value;
    const p = pipelines.create(c.pipelineInput.parse({ name: 'Baseline' }));
    datasets.rename(d.id, 1, 'Saved dataset');
    pipelines.edit(p.id, 1, { name: 'Saved pipeline' });
    db.close();
    db = openDatabase(path);
    const config = readConfig({});
    const api = createApp({
      config,
      datasets: new Datasets(db),
      pipelines: new Pipelines(db),
      ready: () => true,
      logger: createLogger({ write: () => {} }),
    });
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
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
    const storage = new Map([
      ['rag-eval.dataset', d.id],
      ['rag-eval.baseline', p.id],
      [
        `rag-eval.draft.v1.name.${d.id}`,
        JSON.stringify({ revision: 1, value: 'Unsaved dataset name' }),
      ],
      [
        `rag-eval.draft.v1.${p.id}`,
        JSON.stringify({
          revision: 1,
          value: {
            name: 'Unsaved pipeline name',
            description: '',
            config: p.config,
          },
        }),
      ],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
    });
    const cache = new QueryClient();
    for (const kind of ['datasets', 'pipelines'] as const) {
      const rows = await request(c.page(c.summary), kind);
      cache.setQueryData(listKey(kind), rows.items);
    }
    const saved = await request(c.dataset, `datasets/${d.id}`);
    cache.setQueryData(['datasets', d.id], saved);
    await cache.fetchQuery(pipelineQuery(p.id));
    cache.setQueryData(
      ['capabilities'],
      await request(c.capabilities, 'capabilities'),
    );
    for (const doc of saved.documents)
      cache.setQueryData(
        ['runner-document', doc.versionId],
        await request(c.document, `datasets/${d.id}/documents/${doc.id}`),
      );
    function Runner() {
      const inputs = useRunnerInputs();
      return (
        <p>
          {inputs.pipelines[0].name} {inputs.documents[0].content}{' '}
          {inputs.tasks.length} questions
        </p>
      );
    }
    const render = (component: React.ReactNode) =>
      renderToStaticMarkup(
        <QueryClientProvider client={cache}>
          <MemoryRouter>{component}</MemoryRouter>
        </QueryClientProvider>,
      );
    const datasetPage = render(<DatasetsPage />),
      pipelinePage = render(<PipelinesPage />);
    for (const [pageValue, savedName, draftName] of [
      [datasetPage, 'Saved dataset', 'Unsaved dataset name'],
      [pipelinePage, 'Saved pipeline', 'Unsaved pipeline name'],
    ]) {
      expect(pageValue).toContain(savedName);
      expect(pageValue).toContain(draftName);
      expect(pageValue).toContain('Discard draft and load latest');
    }
    await expect(
      request(c.dataset, `datasets/${d.id}`, 'PATCH', { name: 'Stale' }, 1),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    const runner = render(<Runner />);
    expect(runner).toContain('Saved pipeline');
    expect(runner).not.toContain('Unsaved');
    expect(runner).toContain('10 questions');
    expect(runner).toContain(
      cache.getQueryData<c.SavedDocument>([
        'runner-document',
        saved.documents[0].versionId,
      ])?.content,
    );
    cache.clear();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('writes recoverable form edits against their original revision and clears discarded drafts', async () => {
  const { useDraft } = await import('../frontend/src/data/draft');
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  function editor(revision: number) {
    let state: ReturnType<typeof useDraft<string>> | undefined;
    function Form() {
      state = useDraft('fixture', revision, 'saved name', c.z.string());
      return null;
    }
    renderToStaticMarkup(<Form />);
    if (!state) throw new Error('Editor did not mount');
    return state;
  }
  editor(1).change('unsaved name');
  const recovered = editor(2);
  expect(recovered).toMatchObject({
    revision: 1,
    stale: true,
    dirty: true,
    value: 'unsaved name',
  });
  recovered.change('still unsaved');
  expect(editor(2)).toMatchObject({
    revision: 1,
    stale: true,
    value: 'still unsaved',
  });
  recovered.discard();
  expect(editor(2)).toMatchObject({
    revision: 2,
    stale: false,
    dirty: false,
    value: 'saved name',
  });
});

it('streams raw File uploads without base64 and renders refreshable document parse states in DatasetsPage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-upload-ui-'));
  const blobs = join(dir, 'blobs');
  const db = openDatabase(join(dir, 'workspace.db'));
  try {
    const datasets = new Datasets(db);
    const created = datasets.create('Uploads');
    const api = createApp({
      config: readConfig({ BLOB_DIRECTORY: blobs }),
      datasets,
      pipelines: new Pipelines(db),
      ready: () => true,
      logger: createLogger({ write: () => {} }),
    });
    const fetchSpy = vi.fn(async (url: string, options: RequestInit = {}) => {
      const headers = Object.fromEntries(
        new Headers(options.headers).entries(),
      );
      const isBlob = options.body instanceof Blob;
      const raw = isBlob
        ? Buffer.from(await (options.body as Blob).arrayBuffer())
        : undefined;
      const jsonBody =
        !isBlob && options.body ? JSON.parse(String(options.body)) : undefined;
      const result = await send(
        api,
        options.method ?? 'GET',
        url,
        jsonBody,
        headers,
        raw,
      );
      return Response.json(result.body, { status: result.status });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const file = new Blob(['Streamed offline text.'], { type: 'text/plain' });
    const uploaded = await request(
      c.uploadResult,
      `datasets/${created.id}/documents?name=notes.txt&parser=local`,
      'POST',
      file,
      1,
      'upload-key-1',
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/datasets/${created.id}/documents?name=notes.txt&parser=local`,
      expect.objectContaining({
        method: 'POST',
        body: file,
        headers: expect.objectContaining({
          'Content-Type': 'text/plain',
          'If-Match': '"1"',
          'Idempotency-Key': 'upload-key-1',
        }),
      }),
    );

    const storage = new Map([['rag-eval.dataset', created.id]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
    });
    const renderWithJob = async () => {
      const cache = new QueryClient();
      const rows = await request(c.page(c.summary), 'datasets');
      cache.setQueryData(listKey('datasets'), rows.items);
      const latest = await request(c.dataset, `datasets/${created.id}`);
      cache.setQueryData(['datasets', created.id], latest);
      cache.setQueryData(
        ['capabilities'],
        await request(c.capabilities, 'capabilities'),
      );
      cache.setQueryData(
        ['jobs', uploaded.jobId],
        await request(c.job, `jobs/${uploaded.jobId}`),
      );
      const html = renderToStaticMarkup(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <DatasetsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      cache.clear();
      return html;
    };

    const queuedHtml = await renderWithJob();
    expect(queuedHtml).toContain('local · queued · waiting · attempt 0');
    expect(queuedHtml).toContain(
      'No worker is running — start it with npm run dev:worker',
    );
    expect(queuedHtml).toContain('Refresh status');
    expect(queuedHtml).toContain('Cancel parsing');

    datasets.jobs.presence();
    const onlineQueuedHtml = await renderWithJob();
    expect(onlineQueuedHtml).toContain('local · queued · waiting · attempt 0');
    expect(onlineQueuedHtml).not.toContain('No worker is running');

    const lease = datasets.jobs.claim();
    if (!lease) throw new Error('Expected claimed job.');
    datasets.jobs.fail(lease, 'Simulated extraction error.');
    db.exec('DELETE FROM worker_presence');
    const failedHtml = await renderWithJob();
    expect(failedHtml).toContain(
      'local · failed · waiting · attempt 1 · Simulated extraction error.',
    );
    expect(failedHtml).not.toContain('No worker is running');
    expect(failedHtml).toContain('Retry local parse');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
