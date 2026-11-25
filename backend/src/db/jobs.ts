import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  job,
  jobEvent,
  chunkOptions,
  chunkRow,
  type Job,
  type Parser,
  z,
  pageSpan,
} from '@rag-eval/contracts';
import { ApiError, missing } from '../errors.js';
import { transaction } from './database.js';
import { dropGenerationFts } from './indexes.js';
import type { Extraction } from '../ingestion/local.js';
import {
  defaultChunks,
  sha256,
  type ArtifactChunk,
} from '../ingestion/chunks.js';

const parseFields =
  "id, 'parse' AS kind, version_id AS versionId, parser, NULL AS generationId, NULL AS runId, NULL AS batchId, state, stage, attempt, message, parent_id AS parentId, artifact_id AS artifactId";
const indexFields =
  "id, 'index' AS kind, NULL AS versionId, NULL AS parser, generation_id AS generationId, NULL AS runId, NULL AS batchId, state, stage, attempt, message, parent_id AS parentId, NULL AS artifactId";
const runFields =
  "id, 'run' AS kind, NULL AS versionId, NULL AS parser, NULL AS generationId, run_id AS runId, NULL AS batchId, state, stage, attempt, message, parent_id AS parentId, NULL AS artifactId";
const generationFields =
  "id, 'generate' AS kind, NULL AS versionId, NULL AS parser, NULL AS generationId, NULL AS runId, batch_id AS batchId, state, stage, attempt, message, parent_id AS parentId, NULL AS artifactId";
export interface Lease {
  id: string;
  token: number;
}
export class LostLease extends Error {}
export const attempts = 4;
const duration = 10 * 60 * 1000;

export class Jobs {
  constructor(
    private readonly db: DatabaseSync,
    readonly now = Date.now,
    readonly leaseMs = 30000,
  ) {}

  private parseRow(row: Record<string, unknown>): Job {
    return job.parse({ ...row, workerOnline: this.online() });
  }

  get(id: string): Job {
    const parsed = this.db
      .prepare(`SELECT ${parseFields} FROM jobs WHERE id=?`)
      .get(id);
    if (parsed) return this.parseRow(parsed);
    const indexed = this.db
      .prepare(`SELECT ${indexFields} FROM index_jobs WHERE id=?`)
      .get(id);
    if (indexed) return this.parseRow(indexed);
    const runRow = this.db
      .prepare(`SELECT ${runFields} FROM run_jobs WHERE id=?`)
      .get(id);
    if (runRow) return this.parseRow(runRow);
    const genRow = this.db
      .prepare(`SELECT ${generationFields} FROM generation_jobs WHERE id=?`)
      .get(id);
    if (genRow) return this.parseRow(genRow);
    return missing();
  }

  events(id: string, after: number) {
    const found = this.get(id);
    const table =
      found.kind === 'index'
        ? 'index_job_events'
        : found.kind === 'run'
          ? 'run_job_events'
          : found.kind === 'generate'
            ? 'generation_job_events'
            : 'job_events';
    return this.db
      .prepare(
        `SELECT seq,state,stage,message,time FROM ${table} WHERE job_id=? AND seq>? ORDER BY seq LIMIT 100`,
      )
      .all(id, after)
      .map((row) => jobEvent.parse(row));
  }

  private event(id: string) {
    this.db
      .prepare(
        'INSERT INTO job_events(job_id,state,stage,message,time) SELECT id,state,stage,message,? FROM jobs WHERE id=?',
      )
      .run(this.now(), id);
  }

  private indexEvent(id: string) {
    this.db
      .prepare(
        'INSERT INTO index_job_events(job_id,state,stage,message,time) SELECT id,state,stage,message,? FROM index_jobs WHERE id=?',
      )
      .run(this.now(), id);
  }

  private runEvent(id: string) {
    this.db
      .prepare(
        'INSERT INTO run_job_events(job_id,state,stage,message,time) SELECT id,state,stage,message,? FROM run_jobs WHERE id=?',
      )
      .run(this.now(), id);
  }

  private generationEvent(id: string) {
    this.db
      .prepare(
        'INSERT INTO generation_job_events(job_id,state,stage,message,time) SELECT id,state,stage,message,? FROM generation_jobs WHERE id=?',
      )
      .run(this.now(), id);
  }

  replay(key: string | null, hash: string) {
    if (!key) return;
    const row = this.db
      .prepare('SELECT id,request_hash FROM jobs WHERE request_key=?')
      .get(key);
    if (row && row.request_hash !== hash)
      throw new ApiError(
        409,
        'conflict',
        'Idempotency key was used with different input.',
      );
    if (row) return String(row.id);
  }

  replayIndex(key: string | null, hash: string) {
    if (!key) return;
    const row = this.db
      .prepare(
        'SELECT id,generation_id,request_hash FROM index_jobs WHERE request_key=?',
      )
      .get(key);
    if (row && row.request_hash !== hash)
      throw new ApiError(
        409,
        'conflict',
        'Idempotency key was used with different input.',
      );
    if (row)
      return {
        jobId: String(row.id),
        generationId: String(row.generation_id),
      };
  }

  // Caller owns the write transaction, including document/revision creation.
  enqueue(
    version: string,
    parser: Parser,
    key: string | null = null,
    hash: string | null = null,
    parent: string | null = null,
  ) {
    const id = randomUUID(),
      now = this.now();
    this.db
      .prepare(
        "INSERT INTO jobs(id,version_id,parser,state,stage,eligible,deadline,parent_id,request_key,request_hash) VALUES (?,?,?,'queued','waiting',?,?,?,?,?)",
      )
      .run(id, version, parser, now, now + duration, parent, key, hash);
    this.event(id);
    return id;
  }

  replayRun(key: string | null, hash: string) {
    if (!key) return;
    const row = this.db
      .prepare(
        'SELECT id,run_id,request_hash FROM run_jobs WHERE request_key=?',
      )
      .get(key);
    if (row && row.request_hash !== hash)
      throw new ApiError(
        409,
        'conflict',
        'Idempotency key was used with different input.',
      );
    if (row)
      return {
        jobId: String(row.id),
        runId: String(row.run_id),
      };
  }

  // Caller owns the write transaction, including run snapshot creation.
  enqueueRun(
    runId: string,
    key: string | null = null,
    hash: string | null = null,
    parent: string | null = null,
  ) {
    const id = randomUUID(),
      now = this.now();
    this.db
      .prepare(
        "INSERT INTO run_jobs(id,run_id,state,stage,eligible,deadline,parent_id,request_key,request_hash) VALUES (?,?,'queued','waiting',?,?,?,?,?)",
      )
      .run(id, runId, now, now + duration, parent, key, hash);
    this.runEvent(id);
    return id;
  }

  // Caller owns the write transaction, including index_generations creation.
  enqueueIndex(
    generationId: string,
    key: string | null = null,
    hash: string | null = null,
    parent: string | null = null,
  ) {
    const id = randomUUID(),
      now = this.now();
    this.db
      .prepare(
        "INSERT INTO index_jobs(id,generation_id,state,stage,eligible,deadline,parent_id,request_key,request_hash) VALUES (?,?,'queued','waiting',?,?,?,?,?)",
      )
      .run(id, generationId, now, now + duration, parent, key, hash);
    this.indexEvent(id);
    return id;
  }

  replayGeneration(key: string | null, hash: string) {
    if (!key) return;
    const row = this.db
      .prepare(
        'SELECT id,batch_id,request_hash FROM generation_jobs WHERE request_key=?',
      )
      .get(key);
    if (row && row.request_hash !== hash)
      throw new ApiError(
        409,
        'conflict',
        'Idempotency key was used with different input.',
      );
    if (row)
      return {
        jobId: String(row.id),
        batchId: String(row.batch_id),
      };
  }

  // Caller owns the write transaction, including generation_batches creation.
  enqueueGeneration(
    batchId: string,
    key: string | null = null,
    hash: string | null = null,
    parent: string | null = null,
  ) {
    const id = randomUUID(),
      now = this.now();
    this.db
      .prepare(
        "INSERT INTO generation_jobs(id,batch_id,state,stage,eligible,deadline,parent_id,request_key,request_hash) VALUES (?,?,'queued','waiting',?,?,?,?,?)",
      )
      .run(id, batchId, now, now + duration, parent, key, hash);
    this.generationEvent(id);
    return id;
  }

  retry(id: string) {
    return transaction(this.db, () => {
      const previous = this.get(id);
      if (previous.kind === 'generate') {
        const child = this.db
          .prepare('SELECT id FROM generation_jobs WHERE parent_id=?')
          .get(id);
        if (child) return this.get(String(child.id));
        if (!['failed', 'cancelled'].includes(previous.state))
          throw new ApiError(
            409,
            'conflict',
            'Only a failed or cancelled job can be retried.',
          );
        const batchId = previous.batchId ?? missing();
        this.db
          .prepare(
            "UPDATE generation_batches SET state='queued',stage='queued',completed_at=NULL,error_message=NULL WHERE id=?",
          )
          .run(batchId);
        this.db
          .prepare(
            "UPDATE generation_batch_documents SET state='pending',error_message=NULL WHERE batch_id=? AND state!='succeeded'",
          )
          .run(batchId);
        const next = this.enqueueGeneration(batchId, null, null, id);
        return this.get(next);
      }
      if (previous.kind === 'run') {
        const child = this.db
          .prepare('SELECT id FROM run_jobs WHERE parent_id=?')
          .get(id);
        if (child) return this.get(String(child.id));
        if (!['failed', 'cancelled'].includes(previous.state))
          throw new ApiError(
            409,
            'conflict',
            'Only a failed or cancelled job can be retried.',
          );
        const runId = previous.runId ?? missing();
        // Keep already-succeeded tasks checkpointed; reset only unfinished/failed/cancelled tasks.
        this.db
          .prepare(
            "UPDATE runs SET state='queued',stage='queued',completed_at=NULL,error_message=NULL WHERE id=?",
          )
          .run(runId);
        this.db
          .prepare(
            "UPDATE run_pipelines SET state='queued',error_message=NULL WHERE run_id=? AND state NOT IN ('succeeded')",
          )
          .run(runId);
        this.db
          .prepare(
            `UPDATE run_tasks
             SET state='pending',
                 retrieval_state=CASE WHEN retrieval_state='succeeded' THEN 'succeeded' ELSE 'pending' END,
                 answer_state=CASE WHEN answer_state IN ('succeeded','skipped') THEN answer_state ELSE 'pending' END,
                 judge_state=CASE WHEN judge_state IN ('succeeded','skipped') THEN judge_state ELSE 'pending' END,
                 error_code=NULL,error_message=NULL,completed_at=NULL
             WHERE run_id=? AND state!='succeeded'`,
          )
          .run(runId);
        const next = this.enqueueRun(runId, null, null, id);
        return this.get(next);
      }
      if (previous.kind === 'index') {
        const child = this.db
          .prepare('SELECT id FROM index_jobs WHERE parent_id=?')
          .get(id);
        if (child) return this.get(String(child.id));
        if (!['failed', 'cancelled'].includes(previous.state))
          throw new ApiError(
            409,
            'conflict',
            'Only a failed or cancelled job can be retried.',
          );
        const orig = this.db
          .prepare(
            'SELECT dataset_id,dataset_revision,fingerprint,mode,chunk_config,embedding_provider,embedding_model FROM index_generations WHERE id=?',
          )
          .get(previous.generationId ?? missing());
        if (!orig) return missing();
        const nextGenerationId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO index_generations(id,dataset_id,dataset_revision,fingerprint,state,mode,chunk_config,embedding_provider,embedding_model,created_at) VALUES (?,?,?,?,'building',?,?,?,?,?)",
          )
          .run(
            nextGenerationId,
            orig.dataset_id,
            orig.dataset_revision,
            orig.fingerprint,
            orig.mode,
            orig.chunk_config,
            orig.embedding_provider,
            orig.embedding_model,
            new Date(this.now()).toISOString(),
          );
        this.db
          .prepare(
            `INSERT INTO generation_source_artifacts(generation_id, document_version_id, artifact_id)
             SELECT ?, document_version_id, artifact_id
             FROM generation_source_artifacts
             WHERE generation_id = ?`,
          )
          .run(nextGenerationId, previous.generationId);
        const next = this.enqueueIndex(nextGenerationId, null, null, id);
        return this.get(next);
      }
      const child = this.db
        .prepare('SELECT id FROM jobs WHERE parent_id=?')
        .get(id);
      if (child) return this.get(String(child.id));
      if (!['failed', 'cancelled'].includes(previous.state))
        throw new ApiError(
          409,
          'conflict',
          'Only a failed or cancelled job can be retried.',
        );
      if (!previous.versionId || !previous.parser) return missing();
      const next = this.enqueue(
        previous.versionId,
        previous.parser,
        null,
        null,
        id,
      );
      this.db
        .prepare(
          'UPDATE jobs SET chunk_config=(SELECT chunk_config FROM jobs WHERE id=?) WHERE id=?',
        )
        .run(id, next);
      // Resume confirmed remote work unless the provider rejected the job itself.
      if (!this.step(id, 'remote-failed'))
        this.db
          .prepare(
            "INSERT INTO job_steps SELECT ?,stage,value FROM job_steps WHERE job_id=? AND stage IN ('remote-id','poll-complete','extraction')",
          )
          .run(next, id);
      return this.get(next);
    });
  }

  cancel(id: string) {
    return transaction(this.db, () => {
      const j = this.get(id);
      if (j.kind === 'generate') {
        if (j.state === 'queued' || j.state === 'running') {
          const nextState =
            j.state === 'queued' ? 'cancelled' : 'cancellation_requested';
          this.db
            .prepare(
              'UPDATE generation_jobs SET state=?,message=NULL WHERE id=?',
            )
            .run(nextState, id);
          if (j.batchId) {
            if (j.state === 'queued') {
              const nowIso = new Date(this.now()).toISOString();
              this.db
                .prepare(
                  "UPDATE generation_batches SET state='cancelled',stage='cancelled',completed_at=?,error_message=? WHERE id=?",
                )
                .run(nowIso, 'Generation cancelled.', j.batchId);
              this.db
                .prepare(
                  "UPDATE generation_batch_documents SET state='cancelled' WHERE batch_id=? AND state='pending'",
                )
                .run(j.batchId);
            } else {
              this.db
                .prepare(
                  "UPDATE generation_batches SET state='cancellation_requested' WHERE id=? AND state='running'",
                )
                .run(j.batchId);
            }
          }
          this.generationEvent(id);
        }
        return this.get(id);
      }
      if (j.kind === 'run') {
        if (j.state === 'queued' || j.state === 'running') {
          const nextState =
            j.state === 'queued' ? 'cancelled' : 'cancellation_requested';
          this.db
            .prepare('UPDATE run_jobs SET state=?,message=NULL WHERE id=?')
            .run(nextState, id);
          if (j.runId) {
            if (j.state === 'queued') {
              const nowIso = new Date(this.now()).toISOString();
              this.db
                .prepare(
                  "UPDATE runs SET state='cancelled',stage='cancelled',completed_at=?,error_message=? WHERE id=?",
                )
                .run(nowIso, 'Run cancelled.', j.runId);
              this.db
                .prepare(
                  "UPDATE run_pipelines SET state='cancelled' WHERE run_id=? AND state IN ('queued','indexing','running')",
                )
                .run(j.runId);
              this.db
                .prepare(
                  "UPDATE run_tasks SET state='cancelled',error_code='cancelled',error_message='Run cancelled.' WHERE run_id=? AND state IN ('pending','running')",
                )
                .run(j.runId);
            } else {
              this.db
                .prepare(
                  "UPDATE runs SET state='cancellation_requested' WHERE id=? AND state='running'",
                )
                .run(j.runId);
            }
          }
          this.runEvent(id);
        }
        return this.get(id);
      }
      if (j.kind === 'index') {
        if (j.state === 'queued' || j.state === 'running') {
          this.db
            .prepare('UPDATE index_jobs SET state=?,message=NULL WHERE id=?')
            .run(
              j.state === 'queued' ? 'cancelled' : 'cancellation_requested',
              id,
            );
          if (j.state === 'queued' && j.generationId) {
            const failed = this.db
              .prepare(
                "UPDATE index_generations SET state='failed',error_message=? WHERE id=? AND state='building'",
              )
              .run('Index build cancelled.', j.generationId);
            if (failed.changes > 0) dropGenerationFts(this.db, j.generationId);
          }
          this.indexEvent(id);
        }
        return this.get(id);
      }
      if (j.state === 'queued' || j.state === 'running') {
        this.db
          .prepare('UPDATE jobs SET state=?,message=NULL WHERE id=?')
          .run(
            j.state === 'queued' ? 'cancelled' : 'cancellation_requested',
            id,
          );
        this.event(id);
      }
      return this.get(id);
    });
  }

  presence() {
    this.db
      .prepare('INSERT OR REPLACE INTO worker_presence VALUES (1,?)')
      .run(this.now());
  }

  online() {
    return !!this.db
      .prepare('SELECT 1 FROM worker_presence WHERE seen>=?')
      .get(this.now() - this.leaseMs);
  }

  claim(): (Job & Lease) | undefined {
    return transaction(this.db, () => {
      const now = this.now();
      for (const row of this.db
        .prepare(`SELECT id,state FROM jobs WHERE state IN ('queued','running','cancellation_requested') AND
        (deadline<=? OR (state!='queued' AND expires<=? AND (attempt>=? OR state='cancellation_requested')))`)
        .all(now, now, attempts)) {
        const cancelled = row.state === 'cancellation_requested';
        this.db
          .prepare('UPDATE jobs SET state=?,message=? WHERE id=?')
          .run(
            cancelled ? 'cancelled' : 'failed',
            cancelled ? null : 'Job deadline or attempt limit reached.',
            row.id,
          );
        this.event(String(row.id));
      }
      const row = this.db
        .prepare(
          `SELECT id FROM jobs WHERE (state='queued' AND eligible<=?) OR (state='running' AND expires<=?) ORDER BY eligible,rowid LIMIT 1`,
        )
        .get(now, now);
      if (!row) return;
      const id = String(row.id);
      const lease = this.db
        .prepare(
          "UPDATE jobs SET state='running',message=NULL,attempt=attempt+1,token=token+1,expires=? WHERE id=? RETURNING token",
        )
        .get(now + this.leaseMs, id);
      this.event(id);
      return { ...this.get(id), token: Number(lease?.token) };
    });
  }

  claimIndex(): (Job & Lease & { generationId: string }) | undefined {
    return transaction(this.db, () => {
      const now = this.now();
      for (const row of this.db
        .prepare(`SELECT id,generation_id,state FROM index_jobs WHERE state IN ('queued','running','cancellation_requested') AND
        (deadline<=? OR (state!='queued' AND expires<=? AND (attempt>=? OR state='cancellation_requested')))`)
        .all(now, now, attempts)) {
        const cancelled = row.state === 'cancellation_requested';
        const message = cancelled
          ? null
          : 'Index build deadline or attempt limit reached.';
        this.db
          .prepare('UPDATE index_jobs SET state=?,message=? WHERE id=?')
          .run(cancelled ? 'cancelled' : 'failed', message, row.id);
        const failed = this.db
          .prepare(
            "UPDATE index_generations SET state='failed',error_message=? WHERE id=? AND state='building'",
          )
          .run(
            cancelled ? 'Index build cancelled.' : message,
            row.generation_id,
          );
        if (failed.changes > 0)
          dropGenerationFts(this.db, String(row.generation_id));
        this.indexEvent(String(row.id));
      }
      const row = this.db
        .prepare(
          `SELECT id FROM index_jobs WHERE (state='queued' AND eligible<=?) OR (state='running' AND expires<=?) ORDER BY eligible,rowid LIMIT 1`,
        )
        .get(now, now);
      if (!row) return;
      const id = String(row.id);
      const lease = this.db
        .prepare(
          "UPDATE index_jobs SET state='running',message=NULL,attempt=attempt+1,token=token+1,expires=? WHERE id=? RETURNING token,generation_id",
        )
        .get(now + this.leaseMs, id);
      this.indexEvent(id);
      return {
        ...this.get(id),
        generationId: String(lease?.generation_id),
        token: Number(lease?.token),
      };
    });
  }

  claimRun(): (Job & Lease & { runId: string }) | undefined {
    return transaction(this.db, () => {
      const now = this.now();
      for (const row of this.db
        .prepare(`SELECT id,run_id,state FROM run_jobs WHERE state IN ('queued','running','cancellation_requested') AND
        (deadline<=? OR (state!='queued' AND expires<=? AND (attempt>=? OR state='cancellation_requested')))`)
        .all(now, now, attempts)) {
        const cancelled = row.state === 'cancellation_requested';
        const message = cancelled
          ? null
          : 'Run deadline or attempt limit reached.';
        this.db
          .prepare('UPDATE run_jobs SET state=?,message=? WHERE id=?')
          .run(cancelled ? 'cancelled' : 'failed', message, row.id);
        this.db
          .prepare(
            "UPDATE runs SET state=?,stage=?,completed_at=?,error_message=? WHERE id=? AND state IN ('queued','running','cancellation_requested')",
          )
          .run(
            cancelled ? 'cancelled' : 'failed',
            cancelled ? 'cancelled' : 'failed',
            new Date(now).toISOString(),
            cancelled ? 'Run cancelled.' : message,
            row.run_id,
          );
        this.runEvent(String(row.id));
      }
      const row = this.db
        .prepare(
          `SELECT id FROM run_jobs WHERE (state='queued' AND eligible<=?) OR (state='running' AND expires<=?) ORDER BY eligible,rowid LIMIT 1`,
        )
        .get(now, now);
      if (!row) return;
      const id = String(row.id);
      const lease = this.db
        .prepare(
          "UPDATE run_jobs SET state='running',message=NULL,attempt=attempt+1,token=token+1,expires=? WHERE id=? RETURNING token,run_id",
        )
        .get(now + this.leaseMs, id);
      this.runEvent(id);
      return {
        ...this.get(id),
        runId: String(lease?.run_id),
        token: Number(lease?.token),
      };
    });
  }

  claimGeneration(): (Job & Lease & { batchId: string }) | undefined {
    return transaction(this.db, () => {
      const now = this.now();
      for (const row of this.db
        .prepare(`SELECT id,batch_id,state FROM generation_jobs WHERE state IN ('queued','running','cancellation_requested') AND
        (deadline<=? OR (state!='queued' AND expires<=? AND (attempt>=? OR state='cancellation_requested')))`)
        .all(now, now, attempts)) {
        const cancelled = row.state === 'cancellation_requested';
        const message = cancelled
          ? null
          : 'Generation deadline or attempt limit reached.';
        this.db
          .prepare('UPDATE generation_jobs SET state=?,message=? WHERE id=?')
          .run(cancelled ? 'cancelled' : 'failed', message, row.id);
        this.db
          .prepare(
            "UPDATE generation_batches SET state=?,stage=?,completed_at=?,error_message=? WHERE id=? AND state IN ('queued','running','cancellation_requested')",
          )
          .run(
            cancelled ? 'cancelled' : 'failed',
            cancelled ? 'cancelled' : 'failed',
            new Date(now).toISOString(),
            cancelled ? 'Generation cancelled.' : message,
            row.batch_id,
          );
        if (cancelled) {
          this.db
            .prepare(
              "UPDATE generation_batch_documents SET state='cancelled' WHERE batch_id=? AND state='pending'",
            )
            .run(row.batch_id);
        }
        this.generationEvent(String(row.id));
      }
      const row = this.db
        .prepare(
          `SELECT id FROM generation_jobs WHERE (state='queued' AND eligible<=?) OR (state='running' AND expires<=?) ORDER BY eligible,rowid LIMIT 1`,
        )
        .get(now, now);
      if (!row) return;
      const id = String(row.id);
      const lease = this.db
        .prepare(
          "UPDATE generation_jobs SET state='running',message=NULL,attempt=attempt+1,token=token+1,expires=? WHERE id=? RETURNING token,batch_id",
        )
        .get(now + this.leaseMs, id);
      this.generationEvent(id);
      return {
        ...this.get(id),
        batchId: String(lease?.batch_id),
        token: Number(lease?.token),
      };
    });
  }

  private guard(l: Lease) {
    const row = this.db
      .prepare(
        "SELECT 1 FROM jobs WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
      )
      .get(l.id, l.token, this.now(), this.now());
    if (!row) throw new LostLease();
  }

  guardIndex(l: Lease) {
    const row = this.db
      .prepare(
        "SELECT 1 FROM index_jobs WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
      )
      .get(l.id, l.token, this.now(), this.now());
    if (!row) throw new LostLease();
  }

  guardRun(l: Lease) {
    const row = this.db
      .prepare(
        "SELECT 1 FROM run_jobs WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
      )
      .get(l.id, l.token, this.now(), this.now());
    if (!row) throw new LostLease();
  }

  guardGeneration(l: Lease) {
    const row = this.db
      .prepare(
        "SELECT 1 FROM generation_jobs WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
      )
      .get(l.id, l.token, this.now(), this.now());
    if (!row) throw new LostLease();
  }

  heartbeat(l: Lease) {
    return transaction(this.db, () => {
      const now = this.now();
      const cancelled = this.db
        .prepare(
          "UPDATE jobs SET state='cancelled' WHERE id=? AND token=? AND state='cancellation_requested' AND expires>?",
        )
        .run(l.id, l.token, now);
      if (cancelled.changes) this.event(l.id);
      else if (
        this.db
          .prepare(
            "UPDATE jobs SET expires=? WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
          )
          .run(now + this.leaseMs, l.id, l.token, now, now).changes
      )
        return true;
      return false;
    });
  }

  heartbeatIndex(l: Lease) {
    return transaction(this.db, () => {
      const now = this.now();
      const cancelled = this.db
        .prepare(
          "UPDATE index_jobs SET state='cancelled' WHERE id=? AND token=? AND state='cancellation_requested' AND expires>?",
        )
        .run(l.id, l.token, now);
      if (cancelled.changes) {
        const gen = this.db
          .prepare('SELECT generation_id FROM index_jobs WHERE id=?')
          .get(l.id);
        if (gen?.generation_id) {
          const failed = this.db
            .prepare(
              "UPDATE index_generations SET state='failed',error_message=? WHERE id=? AND state='building'",
            )
            .run('Index build cancelled.', gen.generation_id);
          if (failed.changes > 0)
            dropGenerationFts(this.db, String(gen.generation_id));
        }
        this.indexEvent(l.id);
      } else if (
        this.db
          .prepare(
            "UPDATE index_jobs SET expires=? WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
          )
          .run(now + this.leaseMs, l.id, l.token, now, now).changes
      )
        return true;
      return false;
    });
  }

  heartbeatRun(l: Lease) {
    return transaction(this.db, () => {
      const now = this.now();
      const cancelled = this.db
        .prepare(
          "UPDATE run_jobs SET state='cancelled' WHERE id=? AND token=? AND state='cancellation_requested' AND expires>?",
        )
        .run(l.id, l.token, now);
      if (cancelled.changes) {
        const row = this.db
          .prepare('SELECT run_id FROM run_jobs WHERE id=?')
          .get(l.id);
        if (row?.run_id) {
          const nowIso = new Date(now).toISOString();
          this.db
            .prepare(
              "UPDATE runs SET state='cancelled',stage='cancelled',completed_at=?,error_message=? WHERE id=? AND state IN ('queued','running','cancellation_requested')",
            )
            .run(nowIso, 'Run cancelled.', row.run_id);
          this.db
            .prepare(
              "UPDATE run_pipelines SET state='cancelled' WHERE run_id=? AND state IN ('queued','indexing','running')",
            )
            .run(row.run_id);
          this.db
            .prepare(
              "UPDATE run_tasks SET state='cancelled',error_code='cancelled',error_message='Run cancelled.' WHERE run_id=? AND state IN ('pending','running')",
            )
            .run(row.run_id);
        }
        this.runEvent(l.id);
      } else if (
        this.db
          .prepare(
            "UPDATE run_jobs SET expires=? WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
          )
          .run(now + this.leaseMs, l.id, l.token, now, now).changes
      )
        return true;
      return false;
    });
  }

  checkpointRun(l: Lease, stage: string) {
    transaction(this.db, () => {
      this.guardRun(l);
      this.db
        .prepare('UPDATE run_jobs SET stage=? WHERE id=?')
        .run(stage, l.id);
      this.runEvent(l.id);
    });
  }

  finishRun(l: Lease) {
    transaction(this.db, () => {
      this.guardRun(l);
      this.db
        .prepare(
          "UPDATE run_jobs SET state='succeeded',stage='complete' WHERE id=?",
        )
        .run(l.id);
      this.runEvent(l.id);
    });
  }

  failRun(l: Lease, message: string, delay?: number) {
    return transaction(this.db, () => {
      this.guardRun(l);
      const eligible = this.now() + Math.min(delay ?? 0, duration);
      const updated = this.db
        .prepare(
          `UPDATE run_jobs SET state=CASE WHEN ? AND attempt<? AND deadline>? THEN 'queued' ELSE 'failed' END,message=?,eligible=? WHERE id=? RETURNING state`,
        )
        .get(
          Number(delay !== undefined),
          attempts,
          eligible,
          message,
          eligible,
          l.id,
        );
      this.runEvent(l.id);
      return String(updated?.state) === 'failed';
    });
  }

  heartbeatGeneration(l: Lease) {
    return transaction(this.db, () => {
      const now = this.now();
      const cancelled = this.db
        .prepare(
          "UPDATE generation_jobs SET state='cancelled' WHERE id=? AND token=? AND state='cancellation_requested' AND expires>?",
        )
        .run(l.id, l.token, now);
      if (cancelled.changes) {
        const row = this.db
          .prepare('SELECT batch_id FROM generation_jobs WHERE id=?')
          .get(l.id);
        if (row?.batch_id) {
          this.db
            .prepare(
              "UPDATE generation_batches SET state='cancelled',stage='cancelled',completed_at=?,error_message=? WHERE id=? AND state IN ('queued','running','cancellation_requested')",
            )
            .run(
              new Date(now).toISOString(),
              'Generation cancelled.',
              row.batch_id,
            );
          this.db
            .prepare(
              "UPDATE generation_batch_documents SET state='cancelled' WHERE batch_id=? AND state='pending'",
            )
            .run(row.batch_id);
        }
        this.generationEvent(l.id);
      } else if (
        this.db
          .prepare(
            "UPDATE generation_jobs SET expires=? WHERE id=? AND token=? AND state='running' AND expires>? AND deadline>?",
          )
          .run(now + this.leaseMs, l.id, l.token, now, now).changes
      )
        return true;
      return false;
    });
  }

  checkpointGeneration(l: Lease, stage: string) {
    transaction(this.db, () => {
      this.guardGeneration(l);
      this.db
        .prepare('UPDATE generation_jobs SET stage=? WHERE id=?')
        .run(stage, l.id);
      this.generationEvent(l.id);
    });
  }

  finishGeneration(l: Lease) {
    transaction(this.db, () => {
      this.guardGeneration(l);
      this.db
        .prepare(
          "UPDATE generation_jobs SET state='succeeded',stage='complete' WHERE id=?",
        )
        .run(l.id);
      this.generationEvent(l.id);
    });
  }

  failGeneration(l: Lease, message: string, delay?: number) {
    return transaction(this.db, () => {
      this.guardGeneration(l);
      const eligible = this.now() + Math.min(delay ?? 0, duration);
      const updated = this.db
        .prepare(
          `UPDATE generation_jobs SET state=CASE WHEN ? AND attempt<? AND deadline>? THEN 'queued' ELSE 'failed' END,message=?,eligible=? WHERE id=? RETURNING state`,
        )
        .get(
          Number(delay !== undefined),
          attempts,
          eligible,
          message,
          eligible,
          l.id,
        );
      this.generationEvent(l.id);
      return String(updated?.state) === 'failed';
    });
  }

  step(id: string, stage: string) {
    return this.db
      .prepare('SELECT value FROM job_steps WHERE job_id=? AND stage=?')
      .get(id, stage)?.value as string | undefined;
  }

  checkpoint(l: Lease, stage: string, value = 'done') {
    transaction(this.db, () => {
      this.guard(l);
      this.db
        .prepare('INSERT OR IGNORE INTO job_steps VALUES (?,?,?)')
        .run(l.id, stage, value);
      this.db.prepare('UPDATE jobs SET stage=? WHERE id=?').run(stage, l.id);
      this.event(l.id);
    });
  }

  checkpointIndex(l: Lease, stage: string) {
    transaction(this.db, () => {
      this.guardIndex(l);
      this.db
        .prepare('UPDATE index_jobs SET stage=? WHERE id=?')
        .run(stage, l.id);
      this.indexEvent(l.id);
    });
  }

  finishIndex(l: Lease) {
    transaction(this.db, () => {
      this.guardIndex(l);
      this.db
        .prepare(
          "UPDATE index_jobs SET state='succeeded',stage='complete' WHERE id=?",
        )
        .run(l.id);
      this.indexEvent(l.id);
    });
  }

  failIndex(l: Lease, message: string, delay?: number) {
    return transaction(this.db, () => {
      this.guardIndex(l);
      const eligible = this.now() + Math.min(delay ?? 0, duration);
      const updated = this.db
        .prepare(
          `UPDATE index_jobs SET state=CASE WHEN ? AND attempt<? AND deadline>? THEN 'queued' ELSE 'failed' END,message=?,eligible=? WHERE id=? RETURNING state`,
        )
        .get(
          Number(delay !== undefined),
          attempts,
          eligible,
          message,
          eligible,
          l.id,
        );
      this.indexEvent(l.id);
      return String(updated?.state) === 'failed';
    });
  }

  chunkOptions(id: string) {
    const value = this.db
      .prepare('SELECT chunk_config FROM jobs WHERE id=?')
      .get(id)?.chunk_config;
    return value
      ? chunkOptions.parse(JSON.parse(String(value)))
      : chunkOptions.parse(defaultChunks);
  }

  requestChunks(
    version: string,
    options: z.infer<typeof chunkOptions>,
    key: string | null,
  ) {
    return transaction(this.db, () => {
      const signature = sha256(JSON.stringify(['chunks', version, options]));
      const previous = this.replay(key, signature);
      if (previous) return this.get(previous);
      const source =
        this.db
          .prepare('SELECT is_text FROM document_versions WHERE id=?')
          .get(version) ?? missing();
      const parsed = this.db
        .prepare(
          'SELECT parser,artifact_id FROM jobs WHERE version_id=? AND chunk_config IS NULL ORDER BY rowid DESC LIMIT 1',
        )
        .get(version);
      if ((parsed || !source.is_text) && !parsed?.artifact_id)
        throw new ApiError(
          409,
          'conflict',
          'Finish parsing this document first.',
        );
      const id = this.enqueue(
        version,
        parsed?.parser === 'llama-parse' ? 'llama-parse' : 'local',
        key,
        signature,
      );
      this.db
        .prepare('UPDATE jobs SET chunk_config=? WHERE id=?')
        .run(JSON.stringify(options), id);
      if (parsed?.artifact_id)
        this.db
          .prepare("INSERT INTO job_steps VALUES (?,'extraction',?)")
          .run(id, parsed.artifact_id);
      return this.get(id);
    });
  }

  chunks(id: string, after: number) {
    const job = this.get(id);
    if (!job.artifactId || job.state !== 'succeeded')
      throw new ApiError(409, 'conflict', 'Job is not complete.');
    const options = this.chunkOptions(id);
    const rows = this.db
      .prepare(
        'SELECT id,ordinal,start,end,page FROM chunks WHERE artifact_id=? AND strategy=? AND chunk_size=? AND overlap=? AND ordinal>? ORDER BY ordinal LIMIT 101',
      )
      .all(
        job.artifactId,
        options.strategy,
        options.chunkSize,
        options.overlap,
        after,
      );
    const artifact = this.artifact(job.artifactId) ?? missing();
    const items = rows.slice(0, 100).map((row) =>
      chunkRow.parse({
        ...row,
        content: artifact.text.slice(Number(row.start), Number(row.end)),
      }),
    );
    return {
      items,
      nextCursor: rows.length > 100 ? String(items[99].ordinal) : null,
    };
  }

  source(version: string) {
    const row =
      this.db
        .prepare(
          'SELECT name,mime_type,hash,blob_key,bytes FROM document_versions WHERE id=?',
        )
        .get(version) ?? missing();
    return {
      name: String(row.name),
      mime: String(row.mime_type),
      hash: String(row.hash),
      blobKey: row.blob_key as string | null,
      inline: row.bytes as Uint8Array,
    };
  }

  artifact(id: string): Extraction | undefined {
    const row = this.db
      .prepare('SELECT text,pages FROM parse_artifacts WHERE id=?')
      .get(id);
    if (row)
      return {
        text: String(row.text),
        pages: z.array(pageSpan).parse(JSON.parse(String(row.pages))),
      };
  }

  saveExtraction(
    l: Lease,
    id: string,
    hash: string,
    version: string,
    result: Extraction,
  ) {
    transaction(this.db, () => {
      this.guard(l);
      this.db
        .prepare('INSERT OR IGNORE INTO parse_artifacts VALUES (?,?,?,?,?)')
        .run(id, hash, version, result.text, JSON.stringify(result.pages));
      this.db
        .prepare("INSERT OR IGNORE INTO job_steps VALUES (?,'extraction',?)")
        .run(l.id, id);
      this.db.prepare("UPDATE jobs SET stage='chunking' WHERE id=?").run(l.id);
      this.event(l.id);
    });
  }

  saveChunks(l: Lease, artifact: string, rows: ArtifactChunk[]) {
    transaction(this.db, () => {
      this.guard(l);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?)',
      );
      for (const row of rows)
        insert.run(
          row.id,
          artifact,
          row.strategy,
          row.chunkSize,
          row.overlap,
          row.ordinal,
          row.start,
          row.end,
          row.page,
          row.hash,
        );
    });
  }

  finish(l: Lease, artifact: string) {
    transaction(this.db, () => {
      this.guard(l);
      this.db
        .prepare(
          "UPDATE jobs SET state='succeeded',stage='complete',artifact_id=? WHERE id=?",
        )
        .run(artifact, l.id);
      this.event(l.id);
    });
  }

  fail(l: Lease, message: string, delay?: number, uploadRejected = false) {
    transaction(this.db, () => {
      this.guard(l);
      if (uploadRejected)
        this.db
          .prepare(
            "DELETE FROM job_steps WHERE job_id=? AND stage='upload-started'",
          )
          .run(l.id);
      const eligible = this.now() + Math.min(delay ?? 0, duration);
      this.db
        .prepare(
          `UPDATE jobs SET state=CASE WHEN ? AND attempt<? AND deadline>? THEN 'queued' ELSE 'failed' END,message=?,eligible=? WHERE id=?`,
        )
        .run(
          Number(delay !== undefined),
          attempts,
          eligible,
          message,
          eligible,
          l.id,
        );
      this.event(l.id);
    });
  }
}
