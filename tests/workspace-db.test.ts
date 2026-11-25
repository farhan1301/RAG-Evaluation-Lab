import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import * as c from '@rag-eval/contracts';
import { openDatabase, ready } from '../backend/src/db/database';
import { Pipelines } from '../backend/src/db/pipelines';
import { Datasets } from '../backend/src/db/datasets';

let dir: string,
  path: string,
  db: ReturnType<typeof openDatabase>,
  datasets: Datasets,
  pipelines: Pipelines;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rag-db-'));
  path = join(dir, 'workspace.db');
  db = openDatabase(path);
  datasets = new Datasets(db);
  pipelines = new Pipelines(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('applies migrations once, enforces foreign keys and WAL, and opens FTS5', () => {
  expect(ready(db)).toBe(true);
  expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  expect(db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(5000);
  db.exec('CREATE VIRTUAL TABLE temp.probe USING fts5(text)');
  expect(() =>
    db.prepare('INSERT INTO tasks VALUES (?,?)').run('bad', 'missing'),
  ).toThrow();
  const another = openDatabase(path);
  try {
    expect(ready(another)).toBe(true);
  } finally {
    another.close();
  }
  db.exec('PRAGMA user_version=100');
  expect(() => openDatabase(path)).toThrow('newer application');
});

it('rejects a stale writer on another connection and preserves frozen snapshots across restart and archive', () => {
  const original = datasets.sample().value;
  const second = openDatabase(path);
  try {
    const other = new Datasets(second);
    expect(other.get(original.id)).toEqual(original);
    const answerable = original.tasks.find((t) => t.answerable);
    if (!answerable) throw new Error('Missing positive sample.');
    const updated = datasets.editTask(original.id, 1, answerable.id, {
      question: 'New question',
    });
    const changed = updated.tasks.find((t) => t.id === answerable.id);
    expect(changed).toMatchObject({
      question: 'New question',
      qrels: answerable.qrels,
      expectedAnswer: answerable.expectedAnswer,
    });
    expect(changed?.versionId).not.toBe(answerable.versionId);
    expect(() => other.rename(original.id, 1, 'stale')).toThrowError(
      expect.objectContaining({ code: 'stale_revision' }),
    );
    datasets.archive(original.id, 2);
    expect(datasets.list(50).items).toEqual([]);
    expect(() => other.editTask(original.id, 2, answerable.id)).toThrowError(
      expect.objectContaining({ code: 'archived' }),
    );
  } finally {
    second.close();
  }
  db.close();
  db = openDatabase(path);
  datasets = new Datasets(db);
  expect(datasets.get(original.id, 1)).toEqual(original);
  expect(datasets.get(original.id)).toMatchObject({
    revision: 2,
    archived: true,
  });
  expect(datasets.revisions(original.id, 1)).toMatchObject({
    items: [{ revision: 1 }],
    nextCursor: '1',
  });
});

it('seeds reviewed gold labels separately, idempotently, and keeps document grades tied to the frozen corpus', () => {
  const own = datasets.create('My dataset');
  const original = datasets.sample().value;
  expect(datasets.sample()).toEqual({ created: false, value: original });
  expect(datasets.get(own.id)).toEqual(own);
  for (const t of original.tasks) {
    expect(t.qrels).toHaveLength(original.documents.length);
    const relevant = t.qrels.filter((q) => q.grade > 0);
    if (t.answerable) {
      const evidence = relevant.map((q) =>
        datasets
          .getDocument(original.id, q.documentId, 1)
          .content?.toLowerCase(),
      );
      for (const fact of t.referenceFacts)
        expect(
          evidence.some((text) => text?.includes(fact.toLowerCase())),
        ).toBe(true);
    } else expect(relevant).toEqual([]);
  }
  const doc = original.documents[0];
  const next = datasets.removeDocument(original.id, 1, doc.id);
  expect(
    next.tasks.every((t) => t.qrels.every((q) => q.documentId !== doc.id)),
  ).toBe(true);
  expect(datasets.get(original.id, 1)).toEqual(original);
  expect(() =>
    datasets.addTask(
      own.id,
      1,
      c.taskInput.parse({
        question: 'Cross dataset',
        qrels: [{ documentId: doc.id, grade: 3 }],
      }),
    ),
  ).toThrow('outside');
  expect(datasets.get(own.id)).toEqual(own);
  expect(datasets.revisions(own.id, 10).items).toHaveLength(1);
});

it('archives referenced pipeline definitions while preserving independent copies and recorded configs', () => {
  const original = pipelines.create(c.pipelineInput.parse({ name: 'Base' }));
  const copy = pipelines.copy(original.id, 1);
  expect(copy.hash).toBe(original.hash);
  const next = pipelines.edit(original.id, 1, {
    config: { ...original.config, retriever: { topK: 8, deduplicate: false } },
  });
  expect(next.hash).not.toBe(original.hash);
  expect(() => pipelines.edit(original.id, 1, { name: 'Old' })).toThrowError(
    expect.objectContaining({ code: 'stale_revision' }),
  );
  // Stand-in for a future run foreign key. A retained revision must remain referentially intact.
  db.exec(
    'CREATE TABLE fixture_run(pipeline TEXT,rev INTEGER,FOREIGN KEY(pipeline,rev) REFERENCES pipeline_revisions)',
  );
  db.prepare('INSERT INTO fixture_run VALUES (?,?)').run(original.id, 1);
  pipelines.archive(original.id, 2);
  expect(pipelines.get(original.id, 1)).toEqual(original);
  expect(pipelines.get(copy.id)).toEqual(copy);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(pipelines.list(10).items.map((p) => p.id)).toEqual([copy.id]);
});
