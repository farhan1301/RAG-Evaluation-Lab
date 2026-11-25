import { z } from '@rag-eval/contracts';
import { fromPages, ParseFailure } from './local.js';

const record = z.record(z.string(), z.unknown());
function field(value: unknown, keys: string[]): unknown {
  const obj = record.safeParse(value);
  if (!obj.success) return undefined;
  for (const key of keys) if (obj.data[key] !== undefined) return obj.data[key];
  return undefined;
}
function jobField(value: unknown, keys: string[]): unknown {
  return (
    field(value, keys) ??
    field(field(value, ['parsing_job', 'parsingJob', 'data']), keys)
  );
}
function pages(value: unknown, depth = 0): string[] {
  if (depth > 12) throw new ParseFailure('Malformed LlamaParse result.');
  if (typeof value === 'string') return [value];
  if (Array.isArray(value))
    return value.flatMap((item) => pages(item, depth + 1));
  const nested = field(value, [
    'pages',
    'md',
    'markdown',
    'raw_markdown',
    'clean_markdown',
    'text',
    'result',
    'output',
    'data',
    'documents',
    'document',
    'content',
    'items',
  ]);
  if (nested === undefined)
    throw new ParseFailure('LlamaParse returned no readable text.');
  return pages(nested, depth + 1);
}
export class RemoteJobFailed extends ParseFailure {}
export class UploadThrottled extends ParseFailure {}
export class CloudParser {
  constructor(
    private readonly base: string,
    private readonly key: string | undefined,
    private readonly transport: typeof fetch = fetch,
  ) {}
  private async call(path: string, signal: AbortSignal, form?: FormData) {
    if (!this.key) throw new ParseFailure('LlamaParse is not configured.');
    let response: Response;
    try {
      response = await this.transport(
        `${this.base.replace(/\/$/, '')}/v1/parsing/${path}`,
        {
          method: form ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${this.key}` },
          body: form,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        },
      );
    } catch {
      throw new ParseFailure(
        form
          ? 'Upload outcome unknown. An explicit retry may incur another charge.'
          : 'LlamaParse connection interrupted.',
        !form,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const after = response.headers.get('retry-after')?.trim();
      const delay =
        after && /^\d+$/.test(after)
          ? Number(after) * 1000
          : Math.max(0, (Date.parse(after ?? '') || 0) - Date.now());
      if (form && response.status === 429)
        throw new UploadThrottled(
          'LlamaParse upload was throttled.',
          true,
          delay,
        );
      if (form && response.status >= 500)
        throw new ParseFailure(
          'Upload outcome unknown. An explicit retry may incur another charge.',
        );
      throw new ParseFailure(
        `LlamaParse returned HTTP ${response.status}.`,
        !form &&
          (response.status === 429 ||
            response.status >= 500 ||
            response.status === 404),
        delay,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ParseFailure('Empty LlamaParse response.');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new ParseFailure('LlamaParse response exceeds the size limit.');
        }
        parts.push(value);
      }
    } catch (err) {
      if (err instanceof ParseFailure) throw err;
      throw new ParseFailure(
        form
          ? 'Upload outcome unknown. An explicit retry may incur another charge.'
          : 'LlamaParse response interrupted.',
        !form,
      );
    }
    const raw = Buffer.concat(parts).toString('utf8');
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      if (response.headers.get('content-type')?.includes('json'))
        throw new ParseFailure('Malformed LlamaParse response.');
      return raw;
    }
  }
  async upload(bytes: Buffer, name: string, mime: string, signal: AbortSignal) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(bytes)], { type: mime }),
      name,
    );
    const value = await this.call('upload', signal, form);
    const id =
      typeof value === 'string'
        ? value
        : jobField(value, [
            'id',
            'job_id',
            'jobId',
            'parse_id',
            'parsing_job_id',
            'parsingJobId',
          ]);
    if (typeof id !== 'string' || !/^[-\w]{1,200}$/.test(id))
      throw new ParseFailure(
        'Missing LlamaParse job ID. An explicit retry may incur another charge.',
      );
    return id;
  }
  async poll(id: string, signal: AbortSignal) {
    const value = await this.call(`job/${id}`, signal);
    const status = String(
      jobField(value, ['status', 'state', 'job_status', 'parsing_job_status']),
    )
      .trim()
      .toUpperCase();
    if (['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'READY', 'DONE'].includes(status))
      return true;
    if (
      [
        'PENDING',
        'QUEUED',
        'RUNNING',
        'PROCESSING',
        'IN_PROGRESS',
        'STARTED',
      ].includes(status)
    )
      return false;
    if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status))
      throw new RemoteJobFailed('LlamaParse failed to process the document.');
    throw new ParseFailure('LlamaParse returned an unknown status.');
  }
  async download(id: string, signal: AbortSignal) {
    return fromPages(
      pages(await this.call(`job/${id}/result/markdown`, signal)),
    );
  }
}
