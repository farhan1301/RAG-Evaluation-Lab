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
