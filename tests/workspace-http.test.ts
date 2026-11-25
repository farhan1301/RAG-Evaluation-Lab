import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
import { Pipelines } from '../backend/src/db/pipelines';
import { Datasets } from '../backend/src/db/datasets';
import { createApp } from '../backend/src/http/app';
import { createLogger } from '../backend/src/lib/logger';
import { send } from './inProcess';

let db: ReturnType<typeof openDatabase>,
  directory: string,
  log: string[],
  clock: number,
  isReady: boolean;
function app(env: NodeJS.ProcessEnv = {}) {
  return createApp({
    config: readConfig({ BLOB_DIRECTORY: directory, ...env }),
    datasets: new Datasets(db),
    pipelines: new Pipelines(db),
    logger: createLogger({ write: (line) => log.push(line) }),
    now: () => clock,
    ready: () => isReady,
  });
}
const match = (revision: number) => ({ 'if-match': `"${revision}"` });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'http-blobs-'));
  db = openDatabase(':memory:');
  log = [];
  clock = 100;
  isReady = true;
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it('exposes safe capabilities and process/database health with zero credentials', async () => {
  const api = app();
  expect(c.health.parse((await send(api, 'GET', '/health/live')).body)).toEqual(
    { status: 'ok' },
  );
  expect((await send(api, 'GET', '/health/ready')).status).toBe(200);
  isReady = false;
  expect((await send(api, 'GET', '/health/ready')).status).toBe(503);
  expect(
    c.capabilities.parse((await send(api, 'GET', '/api/v1/capabilities')).body),
  ).toEqual({ profiles: [], cloudParser: false, denseStore: false });
  expect((await send(api, 'POST', '/api/answer', {})).body).toMatchObject({
    error: { code: 'missing_capability' },
  });
});

it('supports conditional dataset/task/grade CRUD, archive, revision history and CSV import', async () => {
  const api = app(),
    base = '/api/v1/datasets';
  const created = await send(api, 'POST', base, { name: 'Research' });
  expect(created.status).toBe(201);
  const d = c.dataset.parse(created.body),
    path = `${base}/${d.id}`;
  expect(created.headers.etag).toBe('"1"');
  expect((await send(api, 'PATCH', path, { name: 'x' })).status).toBe(428);
  const added = await send(
    api,
    'POST',
    `${path}/documents?name=test.txt`,
    undefined,
    { 'content-type': 'text/plain', ...match(1) },
    'test',
  );
  const doc = c.uploadResult.parse(added.body).dataset.documents[0];
  expect(added.status).toBe(202);
  expect((await send(api, 'GET', `${path}/documents/${doc.id}`)).body).toEqual(
    doc,
  );
  const createTask = await send(
    api,
    'POST',
    `${path}/tasks`,
    { question: 'Why?', expectedAnswer: 'Evidence' },
    match(2),
  );
  const task = c.dataset.parse(createTask.body).tasks[0];
  const stale = await send(api, 'DELETE', path, undefined, match(1));
  expect(stale.status).toBe(409);
  expect(c.errorEnvelope.parse(stale.body).error).toMatchObject({
    code: 'stale_revision',
    requestId: stale.headers['x-request-id'],
  });
  const grades = {
    pool: 'complete',
    qrels: [{ documentId: doc.id, grade: 2 }],
  };
  const qpath = `/api/v1/tasks/${task.id}/qrels`;
  expect(
    (
      await send(
        api,
        'PUT',
        qpath,
        { ...grades, qrels: [...grades.qrels, ...grades.qrels] },
        match(3),
      )
    ).status,
  ).toBe(400);
  expect((await send(api, 'PUT', qpath, grades, match(3))).status).toBe(200);
  const edited = await send(
    api,
    'PATCH',
    `${path}/tasks/${task.id}`,
    { question: 'What?' },
    match(4),
  );
  expect(c.dataset.parse(edited.body).tasks[0]).toMatchObject({
    ...grades,
    question: 'What?',
    expectedAnswer: 'Evidence',
  });
  expect(
    c.page(c.task).parse((await send(api, 'GET', `${path}/tasks?limit=1`)).body)
      .items,
  ).toHaveLength(1);
  expect(
    (await send(api, 'DELETE', `${path}/tasks/${task.id}`, undefined, match(5)))
      .status,
  ).toBe(200);
  expect(
    (
      await send(
        api,
        'POST',
        `${path}/task-imports`,
        {
          mode: 'commit',
          csv: 'question,answer,acceptance rule\nImported?,Answer,Rule',
        },
        match(6),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await send(
        api,
        'DELETE',
        `${path}/documents/${doc.id}`,
        undefined,
        match(7),
      )
    ).status,
  ).toBe(200);
  expect((await send(api, 'DELETE', path, undefined, match(8))).status).toBe(
    204,
  );
  expect(
    c.dataset.parse((await send(api, 'GET', `${path}/revisions/5`)).body)
      .tasks[0],
  ).toMatchObject(grades);
  expect(
    c
      .page(c.revisionSummary)
      .parse(
        (await send(api, 'GET', `${path}/revisions?limit=2&cursor=3`)).body,
      )
      .items.map((r) => r.revision),
  ).toEqual([4, 5]);
  expect(
    c.page(c.summary).parse((await send(api, 'GET', base)).body).items,
  ).toEqual([]);
});

it('validates pipeline configs, independent copies, role availability and cursor pagination', async () => {
  const api = app(),
    base = '/api/v1/pipelines';
  for (const config of [
    { schemaVersion: 2 },
    { foo: true },
    { retriever: { topK: 0, deduplicate: false } },
    { llm: { model: 'x', temperature: 5, maxTokens: 100 } },
  ])
    expect((await send(api, 'POST', base, { name: 'p', config })).status).toBe(
      400,
    );
  expect(
    (
      await send(api, 'POST', base, {
        name: 'p',
        config: { embedding: { model: 'unconfigured' } },
      })
    ).status,
  ).toBe(422);
  const original = c.pipeline.parse(
    (
      await send(api, 'POST', base, {
        name: 'Baseline',
        description: 'Original',
      })
    ).body,
  );
  const path = `${base}/${original.id}`;
  const copy = c.pipeline.parse(
    (await send(api, 'POST', `${path}/copies`, {}, match(1))).body,
  );
  expect(copy.config).toEqual(original.config);
  expect(copy.id).not.toBe(original.id);
  expect(
    (await send(api, 'PATCH', path, { name: 'New' }, match(1))).body,
  ).toMatchObject({
    revision: 2,
    description: 'Original',
    config: original.config,
  });
  expect((await send(api, 'POST', `${path}/copies`, {}, match(1))).status).toBe(
    409,
  );
  const first = c
    .page(c.summary)
    .parse((await send(api, 'GET', `${base}?limit=1`)).body);
  const second = c
    .page(c.summary)
    .parse(
      (await send(api, 'GET', `${base}?limit=1&cursor=${first.nextCursor}`))
        .body,
    );
  expect(second.nextCursor).toBeNull();
  expect(second.items[0].id).not.toBe(first.items[0].id);
  expect((await send(api, 'GET', `${base}?extra=1`)).status).toBe(400);
  expect((await send(api, 'GET', `${base}/invalid`)).status).toBe(400);
  expect((await send(api, 'POST', '/api/v1/datasets/sample')).status).toBe(201);
  expect((await send(api, 'POST', '/api/v1/datasets/sample')).status).toBe(200);
});

it('checks role-specific options before saving an explicit override and resolves a usable default', async () => {
  const api = app({
    OPENAI_API_KEY: 'fixture',
    OPENAI_CHAT_MODEL: 'gpt-5-mini',
  });
  const path = '/api/v1/pipelines';
  const created = c.pipeline.parse(
    (await send(api, 'POST', path, { name: 'Default' })).body,
  );
  expect(created.config.llm.temperature).toBe(1);
  const input = {
    config: {
      ...created.config,
      llm: { ...created.config.llm, temperature: 0.1 },
    },
  };
  expect(
    (await send(api, 'PATCH', `${path}/${created.id}`, input, match(1))).status,
  ).toBe(422);
});

it('rejects foreign origins for writes and preflight, limits trusted hosts and allows explicit origins', async () => {
  const api = app({ CORS_ORIGINS: 'https://editor.example' });
  for (const method of ['POST', 'OPTIONS']) {
    const rejected = await send(
      api,
      method,
      '/api/v1/datasets',
      { name: 'rejected' },
      { origin: 'https://unknown.example' },
    );
    expect(rejected.status).toBe(403);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  }
  for (const origin of ['http://localhost', 'https://editor.example']) {
    const allowed = await send(api, 'OPTIONS', '/api/v1/datasets', undefined, {
      origin,
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);
    expect(allowed.headers['access-control-allow-headers']).toContain(
      'If-Match',
    );
  }
  expect(
    (
      await send(api, 'GET', '/health/live', undefined, {
        host: 'foreign.example',
      })
    ).status,
  ).toBe(403);
  expect(new Datasets(db).list(10).items).toHaveLength(0);
});

it('enforces body limits, safe errors and fixed-window throttling before writes', async () => {
  const api = app({
      RATE_LIMIT: '3',
      RATE_WINDOW_MS: '1000',
      JSON_LIMIT_BYTES: '64',
    }),
    path = '/api/v1/datasets';
  const tooBig = await send(api, 'POST', path, { name: 'x'.repeat(100) });
  expect(tooBig.status).toBe(413);
  expect(c.errorEnvelope.parse(tooBig.body).error.code).toBe('size_limit');
  expect(
    (await send(api, 'POST', path, 'text', { 'content-type': 'text/plain' }))
      .status,
  ).toBe(415);
  expect((await send(api, 'POST', path, undefined, {}, '{')).status).toBe(400);
  const limited = await send(
    api,
    'POST',
    path,
    { name: 'x' },
    { 'x-forwarded-for': 'somewhere-else' },
  );
  expect(limited.status).toBe(429);
  expect(limited.headers['retry-after']).toBe('1');
  expect((await send(api, 'GET', '/health/live')).status).toBe(200);
  clock += 1001;
  expect((await send(api, 'POST', path, { name: 'now allowed' })).status).toBe(
    201,
  );
});

it('keeps request contents, credentials and upstream URLs out of structured logs and capabilities', async () => {
  const secret = 'sentinel-private';
  const api = app({
    OPENAI_API_KEY: secret,
    OPENAI_CHAT_MODEL: 'test-chat',
    LOCAL_EMBED_BASE_URL: 'http://private.invalid/v1',
    LOCAL_EMBED_MODEL: 'local',
  });
  const response = await send(
    api,
    'POST',
    '/api/v1/datasets',
    { name: secret },
    { authorization: secret, cookie: secret },
  );
  const caps = (await send(api, 'GET', '/api/v1/capabilities')).body;
  expect(JSON.stringify(caps)).not.toMatch(/sentinel-private|private.invalid/);
  expect(c.capabilities.parse(caps).profiles.map((p) => p.role)).toEqual([
    'embedding',
    'chat',
    'judge',
  ]);
  createLogger({ write: (line) => log.push(line) }).info({
    req: { headers: { authorization: secret, cookie: secret }, body: secret },
    prompt: secret,
    error: secret,
  });
  expect(log.join('')).not.toContain(secret);
  expect(JSON.parse(log[0])).toMatchObject({
    requestId: response.headers['x-request-id'],
    method: 'POST',
    status: 201,
  });
});

it.each([
  { PORT: 'abc' },
  { RATE_LIMIT: '0' },
  { OPENAI_CHAT_MODEL: 'chat' },
  { QDRANT_REQUIRED: 'true' },
  { CORS_ORIGINS: '*' },
  { LOCAL_EMBED_BASE_URL: 'file:///tmp/secret', LOCAL_EMBED_MODEL: 'local' },
  { LOCAL_EMBED_MODEL: 'only' },
])('rejects invalid or incomplete environment profiles', (env) => {
  expect(() => readConfig(env)).toThrow('Invalid environment');
});
