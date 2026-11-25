import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job } from '@rag-eval/contracts';
import type { Logger } from 'pino';
import type { Generations } from '../db/generations.js';
import type { Indexes } from '../db/indexes.js';
import { type Jobs, LostLease, type Lease } from '../db/jobs.js';
import type { Runs } from '../db/runs.js';
import { ApiError } from '../errors.js';
import type { EvaluationRunner } from '../evaluation/runner.js';
import type { SyntheticGenerator } from '../generation/generator.js';
import { mediaType, validateContent } from '../ingestion/blobs.js';
import {
  chunkArtifact,
  sha256,
  type ArtifactChunk,
} from '../ingestion/chunks.js';
import {
  RemoteJobFailed,
  UploadThrottled,
  type CloudParser,
} from '../ingestion/cloud.js';
import {
  parseLocal,
  ParseFailure,
  type Extraction,
} from '../ingestion/local.js';
import { ProviderError } from '../providers/errors.js';
import type { IndexBuilder } from '../retrieval/indexer.js';

export interface WorkerOptions {
  directory: string;
  cloud: CloudParser;
  indexes?: Indexes;
  indexBuilder?: IndexBuilder;
  runs?: Runs;
  evaluationRunner?: EvaluationRunner;
  generations?: Generations;
  syntheticGenerator?: SyntheticGenerator;
  signal?: AbortSignal;
  random?: () => number;
  pollMs?: number;
  logger?: Logger;
}

const maxBackoffMs = 60_000;

async function extract(
  jobs: Jobs,
  lease: Job & Lease,
  options: WorkerOptions,
  signal: AbortSignal,
) {
  if (!lease.versionId || !lease.parser)
    throw new ParseFailure('Missing document version or parser.');
  const source = jobs.source(lease.versionId);
  // Phase 3 browser uploads sometimes used the generic octet-stream MIME.
  const mime = mediaType(
    source.name,
    source.mime || 'application/octet-stream',
  );
  const version =
    lease.parser === 'local' ? 'local-unpdf1.9.1-v1' : 'llamaparse-markdown-v1';
  const id =
    jobs.step(lease.id, 'extraction') ??
    sha256(JSON.stringify([source.hash, mime, version]));
  const cached = jobs.artifact(id);
  if (cached) return { id, result: cached };
  async function readSource() {
    if (source.blobKey)
      return readFile(join(options.directory, source.blobKey));
    const inline = Buffer.from(source.inline);
    validateContent(inline, mime);
    return inline;
  }
  let result: Extraction;
  if (lease.parser === 'local') {
    jobs.checkpoint(lease, 'extracting');
    result = await parseLocal(await readSource(), mime, signal);
  } else {
    let remote = jobs.step(lease.id, 'remote-id');
    if (!remote) {
      if (jobs.step(lease.id, 'upload-started'))
        throw new ParseFailure(
          'Upload outcome unknown. An explicit retry may incur another charge.',
        );
      const bytes = await readSource();
      signal.throwIfAborted();
      jobs.checkpoint(lease, 'upload-started');
      remote = await options.cloud.upload(bytes, source.name, mime, signal);
      jobs.checkpoint(lease, 'remote-id', remote);
    }
    if (!jobs.step(lease.id, 'poll-complete')) {
      try {
        while (!(await options.cloud.poll(remote, signal)))
          await wait(options.pollMs ?? 1500, undefined, { signal });
      } catch (err) {
        if (err instanceof RemoteJobFailed)
          jobs.checkpoint(lease, 'remote-failed');
        throw err;
      }
      jobs.checkpoint(lease, 'poll-complete');
    }
    result = await options.cloud.download(remote, signal);
  }
  signal.throwIfAborted();
  jobs.saveExtraction(lease, id, source.hash, version, result);
  // Concurrent parses of identical bytes share the first committed extraction.
  return { id, result: jobs.artifact(id) ?? result };
}

async function runIndexJob(
  jobs: Jobs,
  lease: Job & Lease & { generationId: string },
  options: WorkerOptions,
) {
  if (!options.indexBuilder || !options.indexes) return false;
  const span = trace.getTracer('rag-eval.jobs').startSpan('index.build', {
    attributes: {
      'job.id': lease.id,
      'index.generation_id': lease.generationId,
      'job.attempt': lease.attempt,
    },
  });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setInterval(
    () => {
      if (options.signal?.aborted || !jobs.heartbeatIndex(lease))
        controller.abort();
    },
    Math.floor(jobs.leaseMs / 3),
  );
  try {
    await options.indexBuilder.build(lease.generationId, {
      signal,
      guard: () => jobs.guardIndex(lease),
      checkpoint: (stage) => jobs.checkpointIndex(lease, stage),
    });
    jobs.finishIndex(lease);
    options.logger?.info(
      {
        jobId: lease.id,
        generationId: lease.generationId,
        attempt: lease.attempt,
        state: 'succeeded',
      },
      'index job complete',
    );
  } catch (err) {
    if (!options.signal?.aborted) {
      const active = jobs.heartbeatIndex(lease);
      if (active && !(err instanceof LostLease) && !signal.aborted) {
        const backoff =
          Math.min(maxBackoffMs, 1000 * 2 ** (lease.attempt - 1)) *
          (0.5 + (options.random ?? Math.random)());
        const delay =
          err instanceof ProviderError && err.retryable
            ? Math.ceil(Math.max(backoff, err.retryAfterMs ?? 0))
            : undefined;
        const message =
          err instanceof ProviderError || err instanceof ApiError
            ? err.message
            : 'Index build failed. Check configuration and retry.';
        const terminal = jobs.failIndex(lease, message, delay);
        if (terminal) options.indexes.markFailed(lease.generationId, message);
        span.setStatus({ code: SpanStatusCode.ERROR });
        options.logger?.warn(
          {
            jobId: lease.id,
            generationId: lease.generationId,
            attempt: lease.attempt,
            transient: delay !== undefined && !terminal,
          },
          'index job failed',
        );
      }
    }
  } finally {
    clearInterval(timer);
    span.end();
  }
  return true;
}

async function runEvaluationJob(
  jobs: Jobs,
  lease: Job & Lease & { runId: string },
  options: WorkerOptions,
) {
  if (!options.evaluationRunner || !options.runs) return false;
  const span = trace.getTracer('rag-eval.jobs').startSpan('run.execute', {
    attributes: {
      'job.id': lease.id,
      'run.id': lease.runId,
      'job.attempt': lease.attempt,
    },
  });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setInterval(
    () => {
      if (options.signal?.aborted || !jobs.heartbeatRun(lease))
        controller.abort();
    },
    Math.floor(jobs.leaseMs / 3),
  );
  try {
    await options.evaluationRunner.execute(lease.runId, {
      signal,
      guard: () => jobs.guardRun(lease),
      checkpoint: (stage) => jobs.checkpointRun(lease, stage),
      isRetryJob: lease.parentId !== null,
    });
    const finalRun = options.runs.getRun(lease.runId);
    if (finalRun.state === 'failed') {
      jobs.failRun(
        lease,
        finalRun.errorMessage ?? 'Evaluation run failed.',
        undefined,
      );
    } else if (finalRun.state !== 'cancelled') {
      jobs.finishRun(lease);
    }
    options.logger?.info(
      {
        jobId: lease.id,
        runId: lease.runId,
        attempt: lease.attempt,
        state: finalRun.state,
      },
      'run job complete',
    );
  } catch (err) {
    if (!options.signal?.aborted) {
      const active = jobs.heartbeatRun(lease);
      if (active && !(err instanceof LostLease) && !signal.aborted) {
        const backoff =
          Math.min(maxBackoffMs, 1000 * 2 ** (lease.attempt - 1)) *
          (0.5 + (options.random ?? Math.random)());
        const delay =
          err instanceof ProviderError && err.retryable
            ? Math.ceil(Math.max(backoff, err.retryAfterMs ?? 0))
            : undefined;
        const message =
          err instanceof ProviderError || err instanceof ApiError
            ? err.message
            : 'Evaluation run failed. Inspect run details and retry.';
        const terminal = jobs.failRun(lease, message, delay);
        if (terminal) options.runs.markRunFailed(lease.runId, message);
        span.setStatus({ code: SpanStatusCode.ERROR });
        options.logger?.warn(
          {
            jobId: lease.id,
            runId: lease.runId,
            attempt: lease.attempt,
            transient: delay !== undefined && !terminal,
          },
          'run job failed',
        );
      }
    }
  } finally {
    clearInterval(timer);
    span.end();
  }
  return true;
}

async function runGenerationJob(
  jobs: Jobs,
  lease: Job & Lease & { batchId: string },
  options: WorkerOptions,
) {
  if (!options.syntheticGenerator || !options.generations) return false;
  const span = trace.getTracer('rag-eval.jobs').startSpan('generation.run', {
    attributes: {
      'job.id': lease.id,
      'generation.batch_id': lease.batchId,
      'job.attempt': lease.attempt,
    },
  });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setInterval(
    () => {
      if (options.signal?.aborted || !jobs.heartbeatGeneration(lease))
        controller.abort();
    },
    Math.floor(jobs.leaseMs / 3),
  );
  try {
    await options.syntheticGenerator.execute(lease.batchId, {
      signal,
      guard: () => jobs.guardGeneration(lease),
      checkpoint: (stage) => jobs.checkpointGeneration(lease, stage),
      isRetryJob: lease.parentId !== null,
    });
    const finalBatch = options.generations.getBatch(lease.batchId);
    if (finalBatch.state === 'failed') {
      jobs.failGeneration(
        lease,
        finalBatch.errorMessage ?? 'Synthetic generation failed.',
        undefined,
      );
    } else if (finalBatch.state !== 'cancelled') {
      jobs.finishGeneration(lease);
    }
    options.logger?.info(
      {
        jobId: lease.id,
        batchId: lease.batchId,
        attempt: lease.attempt,
        state: finalBatch.state,
      },
      'generation job complete',
    );
  } catch (err) {
    if (!options.signal?.aborted) {
      const active = jobs.heartbeatGeneration(lease);
      if (active && !(err instanceof LostLease) && !signal.aborted) {
        const backoff =
          Math.min(maxBackoffMs, 1000 * 2 ** (lease.attempt - 1)) *
          (0.5 + (options.random ?? Math.random)());
        const delay =
          err instanceof ProviderError && err.retryable
            ? Math.ceil(Math.max(backoff, err.retryAfterMs ?? 0))
            : undefined;
        const message =
          err instanceof ProviderError || err instanceof ApiError
            ? err.message
            : 'Synthetic question generation failed. Inspect status and retry.';
        const terminal = jobs.failGeneration(lease, message, delay);
        if (terminal)
          options.generations.markBatchFailed(lease.batchId, message);
        span.setStatus({ code: SpanStatusCode.ERROR });
        options.logger?.warn(
          {
            jobId: lease.id,
            batchId: lease.batchId,
            attempt: lease.attempt,
            transient: delay !== undefined && !terminal,
          },
          'generation job failed',
        );
      }
    }
  } finally {
    clearInterval(timer);
    span.end();
  }
  return true;
}

export async function runOne(jobs: Jobs, options: WorkerOptions) {
  const lease = jobs.claim();
  if (!lease) {
    if (options.indexBuilder && options.indexes) {
      const indexLease = jobs.claimIndex();
      if (indexLease) return runIndexJob(jobs, indexLease, options);
    }
    if (options.evaluationRunner && options.runs) {
      const runLease = jobs.claimRun();
      if (runLease) return runEvaluationJob(jobs, runLease, options);
    }
    if (options.syntheticGenerator && options.generations) {
      const genLease = jobs.claimGeneration();
      if (genLease) return runGenerationJob(jobs, genLease, options);
    }
    return false;
  }
  const span = trace.getTracer('rag-eval.jobs').startSpan('job.run', {
    attributes: {
      'job.id': lease.id,
      'job.parser': lease.parser ?? 'local',
      'job.attempt': lease.attempt,
    },
  });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setInterval(
    () => {
      if (options.signal?.aborted || !jobs.heartbeat(lease)) controller.abort();
    },
    Math.floor(jobs.leaseMs / 3),
  );
  try {
    const { id, result } = await extract(jobs, lease, options, signal);
    let batch: ArtifactChunk[] = [];
    for (const row of chunkArtifact(id, result, jobs.chunkOptions(lease.id))) {
      signal.throwIfAborted();
      batch.push(row);
      if (batch.length === 250) {
        jobs.saveChunks(lease, id, batch);
        batch = [];
        await setImmediate();
      }
    }
    signal.throwIfAborted();
    jobs.saveChunks(lease, id, batch);
    jobs.finish(lease, id);
    options.logger?.info(
      {
        jobId: lease.id,
        parser: lease.parser,
        attempt: lease.attempt,
        state: 'succeeded',
      },
      'job complete',
    );
  } catch (err) {
    // Cancellation and lease loss win over an upstream response in flight.
    // On graceful shutdown, leave the lease unrenewed so another worker can reclaim it promptly.
    if (!options.signal?.aborted) {
      const active = jobs.heartbeat(lease);
      if (active && !(err instanceof LostLease) && !signal.aborted) {
        const backoff =
          Math.min(maxBackoffMs, 1000 * 2 ** (lease.attempt - 1)) *
          (0.5 + (options.random ?? Math.random)());
        const delay =
          err instanceof ParseFailure && err.transient
            ? Math.ceil(Math.max(backoff, err.retryAfterMs))
            : undefined;
        jobs.fail(
          lease,
          err instanceof ParseFailure
            ? err.message
            : 'Document processing failed. Check the file and retry.',
          delay,
          err instanceof UploadThrottled,
        );
        span.setStatus({ code: SpanStatusCode.ERROR });
        options.logger?.warn(
          {
            jobId: lease.id,
            parser: lease.parser,
            attempt: lease.attempt,
            transient: delay !== undefined,
          },
          'job failed',
        );
      }
    }
  } finally {
    clearInterval(timer);
    span.end();
  }
  return true;
}
