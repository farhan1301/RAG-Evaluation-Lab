import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  dataset,
  document,
  task,
  taskInput,
  type Dataset,
  type TaskInput,
  type Task,
} from '@rag-eval/contracts';
import { ApiError, missing } from '../errors.js';
import { examples, passages } from './sample.js';
import { transaction } from './database.js';
import { Definitions, hash, paginate } from './definitions.js';

export class Datasets extends Definitions {
  constructor(db: DatabaseSync) {
    super(db, 'datasets');
  }

  private fresh(name: string, seed: string | null = null) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO datasets(id,revision,seed) VALUES (?,1,?)')
      .run(id, seed);
    this.db
      .prepare('INSERT INTO dataset_revisions VALUES (?,1,?,?)')
      .run(id, name, new Date().toISOString());
    return id;
  }
  create(name: string) {
    return transaction(this.db, () => this.get(this.fresh(name)));
  }

  private tasksAt(id: string, revision: number, cursor = '', limit = -1) {
    const rows = this.db
      .prepare(`SELECT t.task_id AS id,t.id AS versionId,t.fields,t.pool FROM revision_tasks r
      JOIN task_versions t ON r.version_id=t.id WHERE r.dataset_id=? AND r.revision=? AND t.task_id>?
      ORDER BY t.task_id LIMIT ?`)
      .all(id, revision, cursor, limit);
    const grades =
      this.db.prepare(`SELECT d.document_id AS documentId,q.grade FROM qrels q
      JOIN document_versions d ON d.id=q.document_version WHERE q.task_version=? ORDER BY d.document_id`);
    return rows.map(({ id, versionId, fields, pool }) =>
      task.parse({
        id,
        versionId,
        pool,
        ...JSON.parse(String(fields)),
        qrels: grades.all(versionId),
      }),
    );
  }
  listTasks(id: string, limit: number, cursor?: string) {
    const { revision } = this.head(id);
    return paginate(
      this.tasksAt(id, revision, cursor, limit + 1),
      limit,
      (t) => t.id,
    );
  }
  get(id: string, frozen?: number): Dataset {
    const head = this.head(id, frozen);
    const documents = this.db
      .prepare(`SELECT d.document_id AS id,d.id AS versionId,d.name,d.mime_type AS mimeType,
      d.hash,length(d.bytes) AS size FROM revision_documents r JOIN document_versions d ON r.version_id=d.id
      WHERE r.dataset_id=? AND r.revision=? ORDER BY d.document_id`)
      .all(id, head.revision)
      .map((row) => document.parse(row));
    return dataset.parse({
      ...head,
      documents,
      tasks: this.tasksAt(id, head.revision),
    });
  }

  getDocument(id: string, documentId: string, frozen?: number) {
    const { revision } = this.head(id, frozen);
    const row = this.db
      .prepare(`SELECT d.document_id AS id,d.id AS versionId,d.name,d.mime_type AS mimeType,
      d.hash,d.bytes,d.is_text FROM revision_documents r JOIN document_versions d ON r.version_id=d.id
      WHERE r.dataset_id=? AND r.revision=? AND d.document_id=?`)
      .get(id, revision, documentId);
    if (!row) return missing();
    const { bytes: blob, is_text, ...fields } = row;
    const bytes = Buffer.from(blob as Uint8Array);
    return document.parse({
      ...fields,
      size: bytes.length,
      ...(is_text
        ? { content: bytes.toString('utf8') }
        : { fileBase64: bytes.toString('base64') }),
    });
  }

  private edit(
    id: string,
    expected: number,
    change: (revision: number) => void,
    name?: string,
  ) {
    return transaction(this.db, () => {
      const current = this.writable(id, expected);
      const next = expected + 1;
      this.db
        .prepare('INSERT INTO dataset_revisions VALUES (?,?,?,?)')
        .run(id, next, name ?? current.name, new Date().toISOString());
      for (const table of ['revision_tasks', 'revision_documents']) {
        this.db
          .prepare(
            `INSERT INTO ${table} SELECT dataset_id,?,version_id FROM ${table} WHERE dataset_id=? AND revision=?`,
          )
          .run(next, id, expected);
      }
      change(next);
      this.db
        .prepare('UPDATE datasets SET revision=? WHERE id=?')
        .run(next, id);
      return this.get(id);
    });
  }
  rename(id: string, expected: number, name: string) {
    return this.edit(id, expected, () => {}, name);
  }

  private insertDocument(
    datasetId: string,
    revision: number,
    name: string,
    mimeType: string,
    bytes: Buffer,
    isText = false,
  ) {
    const id = randomUUID(),
      version = randomUUID();
    this.db.prepare('INSERT INTO documents VALUES (?,?)').run(id, datasetId);
    this.db
      .prepare('INSERT INTO document_versions VALUES (?,?,?,?,?,?,?)')
      .run(version, id, name, mimeType, hash(bytes), bytes, Number(isText));
    this.db
      .prepare('INSERT INTO revision_documents VALUES (?,?,?)')
      .run(datasetId, revision, version);
    return id;
  }
  addDocument(
    id: string,
    expected: number,
    input: { name: string; mimeType: string; fileBase64: string },
  ) {
    return this.edit(id, expected, (rev) =>
      this.insertDocument(
        id,
        rev,
        input.name,
        input.mimeType,
        Buffer.from(input.fileBase64, 'base64'),
      ),
    );
  }
  removeDocument(id: string, expected: number, documentId: string) {
    return this.edit(id, expected, (rev) => {
      const result = this.db
        .prepare(`DELETE FROM revision_documents WHERE dataset_id=? AND revision=? AND version_id IN
        (SELECT id FROM document_versions WHERE document_id=?)`)
        .run(id, rev, documentId);
      if (!result.changes) missing();
      for (const t of this.tasksAt(id, rev)) {
        const remaining = t.qrels.filter((q) => q.documentId !== documentId);
        if (remaining.length !== t.qrels.length)
          this.replaceTask(id, rev, t, { qrels: remaining });
      }
    });
  }

  datasetForTask(taskId: string) {
    const row = this.db
      .prepare('SELECT dataset_id FROM tasks WHERE id=?')
      .get(taskId);
    if (!row) return missing();
    return String(row.dataset_id);
  }
  private insertTask(
    datasetId: string,
    rev: number,
    input: TaskInput,
    taskId?: string,
  ) {
    const { qrels, pool, ...fields } = taskInput.parse(input);
    const id = taskId ?? randomUUID(),
      version = randomUUID();
    if (!taskId)
      this.db.prepare('INSERT INTO tasks VALUES (?,?)').run(id, datasetId);
    this.db
      .prepare('INSERT INTO task_versions VALUES (?,?,?,?)')
      .run(version, id, JSON.stringify(fields), pool);
    this.db
      .prepare('INSERT INTO revision_tasks VALUES (?,?,?)')
      .run(datasetId, rev, version);
    for (const q of qrels) {
      const result = this.db
        .prepare(`INSERT INTO qrels SELECT ?,d.id,? FROM revision_documents r JOIN document_versions d ON d.id=r.version_id
        WHERE r.dataset_id=? AND r.revision=? AND d.document_id=?`)
        .run(version, q.grade, datasetId, rev, q.documentId);
      if (!result.changes)
        throw new ApiError(
          400,
          'invalid_input',
          'A graded document is outside this dataset revision.',
        );
    }
  }
  addTask(id: string, expected: number, input: TaskInput) {
    return this.edit(id, expected, (rev) => this.insertTask(id, rev, input));
  }
  importTasks(id: string, expected: number, inputs: TaskInput[]) {
    return this.edit(id, expected, (rev) => {
      this.db
        .prepare('DELETE FROM revision_tasks WHERE dataset_id=? AND revision=?')
        .run(id, rev);
      for (const input of inputs) this.insertTask(id, rev, input);
    });
  }
  private replaceTask(
    id: string,
    rev: number,
    current: Task,
    patch?: Partial<TaskInput>,
  ) {
    const { id: taskId, versionId, ...fields } = current;
    this.db
      .prepare(
        'DELETE FROM revision_tasks WHERE dataset_id=? AND revision=? AND version_id=?',
      )
      .run(id, rev, versionId);
    if (patch) this.insertTask(id, rev, { ...fields, ...patch }, taskId);
  }
  editTask(
    id: string,
    expected: number,
    taskId: string,
    patch?: Partial<TaskInput>,
  ) {
    return this.edit(id, expected, (rev) => {
      const current = this.tasksAt(id, rev).find((t) => t.id === taskId);
      if (!current) return missing();
      this.replaceTask(id, rev, current, patch);
    });
  }

  sample() {
    return transaction(this.db, () => {
      const existing = this.db
        .prepare(
          "SELECT id FROM datasets WHERE seed='rag-fundamentals-v1' AND archived=0",
        )
        .get();
      if (existing) {
        const id = String(existing.id);
        return { created: false, value: this.get(id) };
      }
      const id = this.fresh('RAG fundamentals', 'rag-fundamentals-v1');
      const sources = (Object.keys(passages) as (keyof typeof passages)[]).map(
        (key) => {
          const passage = passages[key];
          return {
            key,
            documentId: this.insertDocument(
              id,
              1,
              passage.name,
              'text/plain',
              Buffer.from(passage.text),
              true,
            ),
          };
        },
      );
      for (const { question, answer, facts, grades } of examples) {
        this.insertTask(
          id,
          1,
          taskInput.parse({
            question,
            expectedAnswer: answer,
            referenceFacts: facts,
            acceptanceRule: facts.length
              ? 'Include the reviewed reference facts.'
              : 'Acknowledge that no numeric size is specified.',
            answerable: facts.length > 0,
            provenance: 'Reviewed RAG fundamentals sample',
            pool: 'complete',
            qrels: sources.map(({ key, documentId }) => ({
              documentId,
              grade: grades[key] ?? 0,
            })),
          }),
        );
      }
      return { created: true, value: this.get(id) };
    });
  }
}
