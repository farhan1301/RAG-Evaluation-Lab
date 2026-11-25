import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,readFileSync,readdirSync,rmSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import * as c from '@rag-eval/contracts';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
import { Jobs,LostLease } from '../backend/src/db/jobs';
import { Datasets } from '../backend/src/db/datasets';
import { Pipelines } from '../backend/src/db/pipelines';
import { createApp } from '../backend/src/http/app';
import { createLogger } from '../backend/src/lib/logger';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { runOne } from '../backend/src/jobs/run';
import { send } from './inProcess';

let dir:string, blobs:string, db:ReturnType<typeof openDatabase>, repo:Datasets, base:string;
let api:ReturnType<typeof createApp>;
const same='http://localhost',allowed='https://editor.test';
const headers=(origin=same)=>({origin,'if-match':'"1"'});
const pdf=readFileSync(new URL('./fixtures/tiny.pdf',import.meta.url));
const docx=readFileSync(new URL('./fixtures/tiny.docx',import.meta.url));
const docMime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function upload(
  name: string,
  raw: Buffer | string,
  mime: string,
  parser = 'local',
  extra: Record<string, string> = {},
) {
  return send(
    api,
    'POST',
    `${base}/documents?${new URLSearchParams({ name, parser })}`,
    undefined,
    { ...headers(), 'content-type': mime, ...extra },
    raw,
  );
}
function mustClaim(jobs: Jobs) {
  const lease = jobs.claim();
  if (!lease) throw new Error('Expected a claimed job lease.');
  return lease;
}
function worker(
  transport: typeof fetch = () => {
    throw new Error('Unexpected cloud request');
  },
  jobs = repo.jobs,
  signal?: AbortSignal,
) {
  return runOne(jobs, {
    directory: blobs,
    cloud: new CloudParser('https://fixture.invalid', 'fixture-key', transport),
    random: () => 0.5,
    pollMs: 1,
    signal,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phase4-'));
  blobs = join(dir, 'blobs');
  db = openDatabase(join(dir, 'workspace.db'));
  repo = new Datasets(db);
  base = `/api/v1/datasets/${repo.create('Corpus').id}`;
  api = createApp({
    datasets: repo,
    pipelines: new Pipelines(db),
    config: readConfig({
      BLOB_DIRECTORY: blobs,
      CORS_ORIGINS: allowed,
      DOCUMENT_LIMIT_BYTES: '4096',
      LLAMA_CLOUD_API_KEY: 'test',
    }),
    logger: createLogger({ write: () => {} }),
    ready: () => true,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each([
  ['tiny.pdf', pdf, 'application/pdf', 'Offline fixture text.'],
  ['notes.md', '# Héllo\r\n😀', 'text/markdown', '# Héllo\n😀'],
  ['text.txt', 'Snow and rain.', 'text/plain', 'Snow and rain.'],
] as const)(
  'streams and parses %s offline with a private blob, durable preview and chunk offsets',
  async (name, raw, mime, text) => {
    const key = randomUUID(),
      extra = { 'idempotency-key': key };
    const res = await upload(name, raw, mime, 'local', extra);
    expect(res.status).toBe(202);
    const result = c.uploadResult.parse(res.body);
    expect(res.headers.location).toBe(`/api/v1/jobs/${result.jobId}`);
    expect((await upload(name, raw, mime, 'local', extra)).body).toEqual(
      result,
    );
    expect(
      (await upload('changed.txt', 'different', 'text/plain', 'local', extra))
        .status,
    ).toBe(409);
    const files = readdirSync(blobs);
    expect(files).toHaveLength(1);
    expect(statSync(join(blobs, files[0])).mode & 0o777).toBe(0o600);
    expect(await worker()).toBe(true);
    expect(repo.jobs.get(result.jobId)).toMatchObject({
      state: 'succeeded',
      attempt: 1,
    });
    const doc = c.document.parse(
      (
        await send(
          api,
          'GET',
          `${base}/documents/${result.documentId}?preview=true`,
        )
      ).body,
    );
    expect(doc.content).toBe(text);
    const rows = repo.jobs.chunks(result.jobId, -1).items;
    expect(rows.map((r) => r.content)).toEqual([text]);
    expect(rows[0]).toMatchObject({ start: 0, end: text.length, page: 1 });
  },
);

it('rejects extension/type/content mismatches, invalid containers, interrupted and oversized streams', async () => {
  for (const [name, bytes, mime] of [
    ['text.txt', pdf, 'text/plain'],
    ['notes.pdf', 'ordinary text', 'application/pdf'],
    ['notes.txt', 'text', 'application/pdf'],
    ['empty.txt', '', 'text/plain'],
    ['fake.docx', 'PK', 'application/octet-stream'],
    [
      'wrong.docx',
      Buffer.from(
        docx
          .toString('latin1')
          .replace('word/document.xml', 'word/otherdoc.xml'),
        'latin1',
      ),
      docMime,
    ],
    ['notes.exe', 'words', 'text/plain'],
    ['text.txt', Buffer.from([255]), 'text/plain'],
  ] as const)
    expect(
      (await upload(name, bytes, mime, name.endsWith('.docx') ? 'llama-parse' : 'local')).status,
    ).toBe(415);
  expect((await upload('../escape.txt', 'words', 'text/plain')).status).toBe(
    400,
  );
  expect((await upload('a.docx', docx, docMime)).status).toBe(415);
  expect((await upload('large.txt', 'x'.repeat(4100), 'text/plain')).status).toBe(
    413,
  );
  expect(
    (
      await upload('large.txt', 'x'.repeat(4100), 'text/plain', 'local', {
        'transfer-encoding': 'chunked',
        'content-length': '',
      })
    ).status,
  ).toBe(413);
  const { storeUpload } = await import('../backend/src/ingestion/blobs');
  async function* multiChunk() {
    yield Buffer.from('first ');
    yield Buffer.from('second');
  }
  const stored = await storeUpload(blobs, multiChunk(), 'text/plain', 4096);
  expect(readFileSync(join(blobs, stored.key), 'utf8')).toBe('first second');
  rmSync(join(blobs, stored.key));
  async function* disconnected() {
    yield Buffer.from('part');
    throw new Error('disconnected');
  }
  await expect(
    storeUpload(blobs, disconnected(), 'text/plain', 4096),
  ).rejects.toThrow('disconnected');
  expect(readdirSync(blobs)).toEqual([]);
  expect(repo.list(1).items[0].revision).toBe(1);
});

it.each([same, allowed])(
  'allows %s and rejects a foreign origin on every ingestion endpoint and preflight',
  async (origin) => {
    const foreign = 'https://unknown.test';
    async function checked(
      method: string,
      path: string,
      body?: unknown,
      raw?: string,
      extra: Record<string, string> = {},
    ) {
      for (const [from, status] of [
        [foreign, 403],
        [origin, 204],
      ] as const) {
        const pre = await send(api, 'OPTIONS', path, undefined, {
          origin: from,
        });
        expect(pre.status).toBe(status);
        if (status === 204)
          expect(pre.headers['access-control-allow-headers']).toContain(
            'Idempotency-Key',
          );
      }
      expect(
        (await send(api, method, path, body, { ...extra, origin: foreign }, raw))
          .status,
      ).toBe(403);
      const res = await send(api, method, path, body, { ...extra, origin }, raw);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      return res.body;
    }
    const result = c.uploadResult.parse(
      await checked(
        'POST',
        `${base}/documents?name=note.txt`,
        undefined,
        'note',
        { 'if-match': '"1"', 'content-type': 'text/plain' },
      ),
    );
    const jp = `/api/v1/jobs/${result.jobId}`;
    expect(c.job.parse(await checked('GET', jp)).state).toBe('queued');
    expect(c.job.parse(await checked('POST', `${jp}/cancel`, {})).state).toBe(
      'cancelled',
    );
    const retried = c.job.parse(await checked('POST', `${jp}/retry`, {}));
    expect(retried.parentId).toBe(result.jobId);
    const journal = c.z
      .array(c.jobEvent)
      .parse(await checked('GET', `${jp}/events?after=0`));
    expect(journal.map((e) => e.state)).toEqual(['queued', 'cancelled']);
    expect(
      await checked('GET', `${jp}/events?after=${journal[0].seq}`),
    ).toEqual(journal.slice(1));
    await worker();
    const rev = { 'if-match': '"2"' },
      csv =
        'Prompt,Ground Truth,Pass Criteria\nGood?,Answer,Yes\nMissing,,';
    expect(
      c.csvPreview.parse(
        await checked(
          'POST',
          `${base}/task-imports`,
          { mode: 'preview', csv },
          undefined,
          rev,
        ),
      ).warnings,
    ).toHaveLength(1);
    expect(repo.list(1).items[0].revision).toBe(2);
    const parsed = c.job.parse(
      await checked(
        'POST',
        `/api/v1/documents/${result.documentId}/parses`,
        { parser: 'local' },
        undefined,
        rev,
      ),
    );
    await worker();
    expect(repo.jobs.get(parsed.id).state).toBe('succeeded');
    const doc = c.document.parse(
      await checked(
        'GET',
        `${base}/documents/${result.documentId}?preview=true`,
      ),
    );
    const chunkJob = c.job.parse(
      await checked('POST', `/api/v1/document-versions/${doc.versionId}/chunks`, {
        strategy: 'layout',
        chunkSize: 120,
        overlap: 5,
      }),
    );
    await worker();
    expect(
      c.page(c.chunkRow).parse(
        await checked('GET', `/api/v1/jobs/${chunkJob.id}/chunks`),
      ).items[0].content,
    ).toBe('note');
    expect(
      c.dataset.parse(
        await checked(
          'POST',
          `${base}/task-imports`,
          { mode: 'commit', csv },
          undefined,
          rev,
        ),
      ).tasks,
    ).toHaveLength(1);
    expect(
      (
        await send(
          api,
          'POST',
          `${base}/task-imports`,
          { mode: 'commit', csv },
          rev,
        )
      ).status,
    ).toBe(409);
  },
);

it('rejects mismatched dev port origins and accepts rewritten same-origin requests on new endpoints', async () => {
  const hostHeaders = {
    host: '127.0.0.1:7070',
    'if-match': '"1"',
    'content-type': 'text/plain',
  };
  const mismatched = await send(
    api,
    'POST',
    `${base}/documents?name=note.txt`,
    undefined,
    { ...hostHeaders, origin: 'http://127.0.0.1:3000' },
    'note',
  );
  expect(mismatched.status).toBe(403);
  const proxied = await send(
    api,
    'POST',
    `${base}/documents?name=note.txt`,
    undefined,
    { ...hostHeaders, origin: 'http://127.0.0.1:7070' },
    'note',
  );
  expect(proxied.status).toBe(202);
  const { jobId } = c.uploadResult.parse(proxied.body);
  expect(
    (
      await send(api, 'POST', `/api/v1/jobs/${jobId}/cancel`, {}, {
        host: '127.0.0.1:7070',
        origin: 'http://127.0.0.1:3000',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await send(api, 'POST', `/api/v1/jobs/${jobId}/cancel`, {}, {
        host: '127.0.0.1:7070',
        origin: 'http://127.0.0.1:7070',
      })
    ).status,
  ).toBe(200);
});

it('rejects missing cloud capability before enqueue and rejects CSV preview on archived datasets', async () => {
  const localOnly = createApp({
    datasets: repo,
    pipelines: new Pipelines(db),
    config: readConfig({ BLOB_DIRECTORY: blobs, DOCUMENT_LIMIT_BYTES: '4096' }),
    logger: createLogger({ write: () => {} }),
    ready: () => true,
  });
  const missingCap = await send(
    localOnly,
    'POST',
    `${base}/documents?name=word.docx&parser=llama-parse`,
    undefined,
    { ...headers(), 'content-type': docMime },
    docx,
  );
  expect(missingCap.status).toBe(422);
  expect(c.errorEnvelope.parse(missingCap.body).error.code).toBe(
    'missing_capability',
  );
  const uploaded = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  expect(repo.jobs.cancel(uploaded.jobId).state).toBe('cancelled');
  expect(
    (await send(localOnly, 'POST', `/api/v1/jobs/${uploaded.jobId}/retry`, {}))
      .status,
  ).toBe(422);
  repo.archive(repo.list(1).items[0].id, 2);
  const archivedPreview = await send(
    localOnly,
    'POST',
    `${base}/task-imports`,
    { mode: 'preview', csv: 'question,answer,acceptance_rule\nQ,A,R' },
    { 'if-match': '"2"' },
  );
  expect(archivedPreview.status).toBe(409);
  expect(c.errorEnvelope.parse(archivedPreview.body).error.code).toBe(
    'archived',
  );
});

it('fences expired owners, renews current leases and cancels a running worker before publication', async () => {
  const { jobId } = c.uploadResult.parse(
    (await upload('a.txt', 'abc', 'text/plain')).body,
  );
  let now = Date.now() + 1;
  const jobs = new Jobs(db, () => now, 300);
  const old = mustClaim(jobs);
  now += 200;
  expect(jobs.heartbeat(old)).toBe(true);
  now += 200;
  expect(jobs.claim()).toBeUndefined();
  now += 101;
  const fresh = mustClaim(jobs);
  expect(fresh.token).toBeGreaterThan(old.token);
  expect(jobs.heartbeat(old)).toBe(false);
  for (const write of [
    () => jobs.checkpoint(old, 'late'),
    () => jobs.finish(old, 'bad'),
    () => jobs.fail(old, 'late'),
  ])
    expect(write).toThrow(LostLease);
  expect(jobs.cancel(jobId).state).toBe('cancellation_requested');
  expect(() => jobs.checkpoint(fresh, 'late')).toThrow(LostLease);
  expect(jobs.heartbeat(fresh)).toBe(false);
  expect(jobs.get(jobId).state).toBe('cancelled');
});

it('completes DOCX parsing through upload, poll and download steps and emits ordered job events', async () => {
  const { jobId, documentId } = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  let polls = 0;
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (target.endsWith('/upload')) {
      if (!(init?.body instanceof FormData))
        throw new Error('Expected FormData upload body.');
      const file = init.body.get('file');
      if (!(file instanceof File))
        throw new Error('Expected File upload entry.');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(docx);
      return Response.json({ parsing_job_id: 'docx-ok-1' });
    }
    if (target.endsWith('/job/docx-ok-1')) {
      polls += 1;
      return Response.json({ status: polls === 1 ? 'PENDING' : 'SUCCESS' });
    }
    if (target.endsWith('/job/docx-ok-1/result/markdown')) {
      return Response.json({
        pages: [{ md: 'Section one.' }, { md: 'Section two.' }],
      });
    }
    throw new Error(`Unexpected cloud URL: ${target}`);
  });
  expect(await worker(transport)).toBe(true);
  expect(polls).toBe(2);
  expect(repo.jobs.get(jobId)).toMatchObject({
    state: 'succeeded',
    stage: 'complete',
    attempt: 1,
  });
  const stages = repo.jobs.events(jobId, 0).map((e) => e.stage);
  expect(stages).toEqual([
    'waiting',
    'waiting',
    'upload-started',
    'remote-id',
    'poll-complete',
    'chunking',
    'complete',
  ]);
  const doc = c.document.parse(
    (await send(api, 'GET', `${base}/documents/${documentId}?preview=true`))
      .body,
  );
  expect(doc.content).toBe('Section one.\n\nSection two.');
  expect(repo.jobs.chunks(jobId, -1).items.map((r) => r.page)).toEqual([1, 2]);
});

it('honors Retry-After, persists backoff and caps retries without re-uploading DOCX', async () => {
  const { jobId } = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  let now = Date.now() + 5;
  const jobs = new Jobs(db, () => now);
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/upload')) {
      if (!(init?.body instanceof FormData))
        throw new Error('Expected FormData upload body.');
      const file = init.body.get('file');
      if (!(file instanceof File))
        throw new Error('Expected File upload entry.');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(docx);
      return Response.json({ data: { job_id: 'word-1' } });
    }
    return new Response('secret upstream error', {
      status: 503,
      headers: { 'Retry-After': '3' },
    });
  });
  for (const delay of [3000, 3000, 4000]) {
    expect(await worker(transport, jobs)).toBe(true);
    expect(jobs.get(jobId).state).toBe('queued');
    now += delay - 1;
    expect(await worker(transport, jobs)).toBe(false);
    now += 1;
  }
  await worker(transport, jobs);
  expect(jobs.get(jobId)).toMatchObject({
    state: 'failed',
    attempt: 4,
    message: 'LlamaParse returned HTTP 503.',
  });
  expect(
    transport.mock.calls.filter(([url]) => String(url).endsWith('/upload')),
  ).toHaveLength(1);
});

it('marks ambiguous cloud uploads for explicit retry and sanitizes provider failures', async () => {
  const { jobId } = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  await worker(async () => {
    throw new Error('secret');
  });
  expect(repo.jobs.get(jobId)).toMatchObject({
    state: 'failed',
    message: expect.stringContaining('explicit retry'),
  });
  const next = repo.jobs.retry(jobId);
  await worker(async (url) =>
    Response.json(
      String(url).endsWith('/upload')
        ? { job_id: 'word-2' }
        : { status: 'FAILED', error: 'secret' },
    ),
  );
  expect(repo.jobs.get(next.id)).toMatchObject({
    state: 'failed',
    attempt: 1,
    message: expect.not.stringContaining('secret'),
  });
});

it('recovers a SIGKILL during remote parsing and publishes exactly one artifact and one chunk per source page', async () => {
  const { jobId, documentId } = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  const calls = join(dir, 'cloud-calls');
  function start(hold: boolean) {
    return spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        './tests/fixtures/cloud-transport.mjs',
        'backend/src/jobs/worker.ts',
      ],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_PATH: join(dir, 'workspace.db'),
          BLOB_DIRECTORY: blobs,
          WORKER_LEASE_MS: '600',
          LLAMA_CLOUD_API_KEY: 'fixture',
          FIXTURE_CALLS: calls,
          FIXTURE_HOLD: hold ? 'yes' : '',
        },
      },
    );
  }
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 6000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error('Worker checkpoint timed out.');
      await wait(20);
    }
  }
  const first = start(true),
    exit = once(first, 'exit');
  try {
    await until(() => repo.jobs.step(jobId, 'remote-id') === 'remote-123');
  } finally {
    first.kill('SIGKILL');
    await exit;
  }
  const second = start(false),
    done = once(second, 'exit');
  try {
    await until(() => repo.jobs.get(jobId).state === 'succeeded');
    expect(repo.jobs.get(jobId).attempt).toBe(2);
    expect(readFileSync(calls, 'utf8').match(/\/upload\n/g)).toHaveLength(1);
    expect(
      repo.getDocument(repo.list(1).items[0].id, documentId).content,
    ).toBe('Repeated page.\n\nRepeated page.');
    expect(
      repo.jobs.chunks(jobId, -1).items.map((row) => [row.page, row.start]),
    ).toEqual([
      [1, 0],
      [2, 16],
    ]);
    expect(
      db.prepare('SELECT count(*) AS n FROM parse_artifacts').get()?.n,
    ).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM chunks').get()?.n).toBe(2);
  } finally {
    second.kill('SIGTERM');
    await done;
  }
}, 15000);

it('aborts an in-flight poll on cancellation and resumes that remote job on explicit retry', async () => {
  const { jobId } = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  const jobs = new Jobs(db, Date.now, 300);
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/upload')) return Response.json({ id: 'running' });
    jobs.cancel(jobId);
    return new Promise<Response>((_resolve, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      }),
    );
  });
  await worker(transport, jobs);
  expect(jobs.get(jobId).state).toBe('cancelled');
  expect(db.prepare('SELECT count(*) AS n FROM parse_artifacts').get()?.n).toBe(
    0,
  );
  const child = jobs.retry(jobId);
  const resumed = vi.fn<typeof fetch>(async (url) =>
    Response.json(
      String(url).endsWith('/markdown')
        ? { text: 'Recovered' }
        : { state: 'DONE' },
    ),
  );
  await worker(resumed, jobs);
  expect(resumed.mock.calls.map(([url]) => String(url))).toEqual([
    'https://fixture.invalid/v1/parsing/job/running',
    'https://fixture.invalid/v1/parsing/job/running/result/markdown',
  ]);
  expect(jobs.get(child.id).state).toBe('succeeded');
});

it('leaves the lease unrenewed on graceful worker shutdown without marking the job failed', async () => {
  const { jobId } = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  let now = Date.now() + 1;
  const jobs = new Jobs(db, () => now, 300);
  const shutdown = new AbortController();
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/upload'))
      return Response.json({ id: 'graceful-1' });
    now += 200;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new Error('shutdown')),
        { once: true },
      );
      shutdown.abort();
    });
  });
  await worker(transport, jobs, shutdown.signal);
  expect(jobs.get(jobId).state).toBe('running');
  // Original expiry was initial now + 300; advancing 101ms after +200ms must allow immediate reclaim.
  now += 101;
  const reclaimed = mustClaim(jobs);
  expect(reclaimed.id).toBe(jobId);
  expect(reclaimed.attempt).toBe(2);
});

it('applies jitter to a rejected upload and never repeats an ambiguous submission automatically', async () => {
  const { jobId } = c.uploadResult.parse(
    (await upload('word.docx', docx, docMime, 'llama-parse')).body,
  );
  let now = Date.now() + 1;
  const jobs = new Jobs(db, () => now);
  const cloud = new CloudParser(
    'https://fixture.invalid',
    'key',
    async () => new Response(null, { status: 429 }),
  );
  await runOne(jobs, { directory: blobs, cloud, random: () => 0.25 });
  expect(jobs.get(jobId).state).toBe('queued');
  now += 749;
  expect(jobs.claim()).toBeUndefined();
  now++;
  const abandoned = mustClaim(jobs);
  jobs.checkpoint(abandoned, 'upload-started');
  now += jobs.leaseMs + 1;
  const transport = vi.fn<typeof fetch>();
  await worker(transport, jobs);
  expect(transport).not.toHaveBeenCalled();
  expect(jobs.get(jobId)).toMatchObject({
    state: 'failed',
    message: expect.stringContaining('outcome unknown'),
  });
});
