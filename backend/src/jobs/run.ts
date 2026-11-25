import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job } from '@rag-eval/contracts';
import type { Logger } from 'pino';
import { type Jobs, LostLease, type Lease } from '../db/jobs.js';
import {
  chunkArtifact,
  sha256,
  type ArtifactChunk,
} from '../ingestion/chunks.js';
import {
  parseLocal,
  ParseFailure,
  type Extraction,
} from '../ingestion/local.js';
import {
  RemoteJobFailed,
  UploadThrottled,
  type CloudParser,
} from '../ingestion/cloud.js';
import { mediaType, validateContent } from '../ingestion/blobs.js';

export interface WorkerOptions {
  directory: string;
  cloud: CloudParser;
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
  const source = jobs.source(lease.versionId);
  // Phase 3 browser uploads sometimes used the generic octet-stream MIME.
  const mime = mediaType(
    source.name,
    source.mime || 'application/octet-stream',
  );
  const version =
    lease.parser === 'local'
      ? 'local-unpdf1.9.1-v1'
      : 'llamaparse-markdown-v1';
  const id =
    jobs.step(lease.id, 'extraction') ??
    sha256(JSON.stringify([source.hash, mime, version]));
  const cached = jobs.artifact(id);
  if (cached) return { id, result: cached };
  async function readSource() {
    if (source.blobKey) return readFile(join(options.directory, source.blobKey));
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

export async function runOne(jobs: Jobs, options: WorkerOptions) {
  const lease = jobs.claim();
  if (!lease) return false;
  const span = trace.getTracer('rag-eval.jobs').startSpan('job.run', {
    attributes: {
      'job.id': lease.id,
      'job.parser': lease.parser,
      'job.attempt': lease.attempt,
    },
  });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setInterval(() => {
    if (options.signal?.aborted || !jobs.heartbeat(lease)) controller.abort();
  }, Math.floor(jobs.leaseMs / 3));
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
