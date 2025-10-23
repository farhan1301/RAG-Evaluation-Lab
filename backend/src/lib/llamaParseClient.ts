import fetch, { Blob, FormData, FetchError, type RequestInit, type Response } from 'node-fetch';
import type { AppConfig } from './config.js';
import { logInfo, logWarn, logError } from './logger.js';

interface ParseJobResponse {
  id?: string;
  job_id?: string;
  jobId?: string;
  parse_id?: string;
  parsing_job_id?: string;
  parsingJobId?: string;
  parsing_job_status?: string;
  job_status?: string;
  status?: string;
  state?: string;
  output?: Array<{ text?: string; markdown?: string }>;
  result?: unknown;
  markdown?: string;
  text?: string;
  error?: string;
  detail?: string;
  message?: string;
  page_count?: number;
  pageCount?: number;
  job_metadata?: {
    page_count?: number;
    [key: string]: unknown;
  };
  pages?: Array<unknown>;
  data?: ParseJobResponse & { [key: string]: unknown };
  parsing_job?: {
    id?: string;
    status?: string;
    page_count?: number;
    metadata?: { page_count?: number };
    [key: string]: unknown;
  };
  parsingJob?: ParseJobResponse['parsing_job'];
  metadata?: { page_count?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ParsedDocument {
  text: string;
  pageCount: number;
  jobId: string;
  raw: unknown;
}

export type LlamaParseResultFormat = 'markdown' | 'text';

export interface ParseDocumentInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
  outputFormat?: LlamaParseResultFormat;
}

const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'READY', 'DONE']);
const FAILURE_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED']);
const MAX_POLL_ATTEMPTS = 120;
const POLL_DELAY_MS = 1500;
const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const UPLOAD_PATH = '/v1/parsing/upload';
const JOB_PATH = '/v1/parsing/job';
const RESULT_PATH_SUFFIX = '/result';
const DEFAULT_RESULT_FORMAT: LlamaParseResultFormat = 'markdown';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const stripMarkdownCodeFences = (value: string): string => {
  const lines = value.trim().split(/\r?\n/);
  if (lines.length === 0) {
    return '';
  }

  const startsWithFence = lines[0]?.trim().startsWith('```');
  const endsWithFence = lines[lines.length - 1]?.trim().endsWith('```');

  if (startsWithFence) {
    lines.shift();
  }

  if (endsWithFence) {
    lines.pop();
  }

  return lines.join('\n').trim();
};

const normalizePageEntry = (entry: unknown): string | null => {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const candidates = [
    record.md,
    record.markdown,
    record.raw_markdown,
    record.clean_markdown,
    record.text,
    record.content,
  ];

  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) {
      return stripMarkdownCodeFences(candidate);
    }
  }

  return null;
};

const findPagesCollection = (payload: unknown, visited = new Set<unknown>()): unknown[] | null => {
  if (!payload || visited.has(payload)) {
    return null;
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const pages = findPagesCollection(entry, new Set(visited).add(payload));
      if (pages && pages.length > 0) {
        return pages;
      }
    }
    return null;
  }

  if (typeof payload === 'object') {
    visited.add(payload);
    const record = payload as Record<string, unknown>;

    if (Array.isArray(record.pages) && record.pages.length > 0) {
      return record.pages;
    }

    const nestedKeys = [
      'result',
      'output',
      'data',
      'documents',
      'document',
      'content',
      'items',
      'children',
    ];

    for (const key of nestedKeys) {
      const nested = record[key];
      const pages = findPagesCollection(nested, new Set(visited));
      if (pages && pages.length > 0) {
        return pages;
      }
    }
  }

  return null;
};

const extractMarkdownPages = (payload: unknown): string[] => {
  const pages = findPagesCollection(payload);
  if (!pages || pages.length === 0) {
    return [];
  }

  const segments: string[] = [];

  for (const entry of pages) {
    const normalized = normalizePageEntry(entry);
    if (isNonEmptyString(normalized)) {
      segments.push(normalized);
    } else if (Array.isArray(entry)) {
      for (const nested of entry) {
        const nestedNormalized = normalizePageEntry(nested);
        if (isNonEmptyString(nestedNormalized)) {
          segments.push(nestedNormalized);
        }
      }
    }
  }

  return segments;
};

const collectTextSegments = (payload: unknown, visited = new Set<unknown>()): string[] => {
  if (!payload || visited.has(payload)) {
    return [];
  }

  if (isNonEmptyString(payload)) {
    return [payload.trim()];
  }

  if (Array.isArray(payload)) {
    const nextVisited = new Set(visited).add(payload);
    return payload.flatMap((entry) => collectTextSegments(entry, nextVisited));
  }

  if (typeof payload === 'object') {
    visited.add(payload);
    const record = payload as Record<string, unknown>;
    const segments: string[] = [];
    const directFieldOrder = [
      'md',
      'markdown',
      'raw_markdown',
      'clean_markdown',
      'text',
      'content',
      'html',
      'body',
      'document',
      'value',
    ];

    for (const field of directFieldOrder) {
      const current = record[field];

      if (isNonEmptyString(current)) {
        const normalized =
          field === 'md' || field.includes('markdown')
            ? stripMarkdownCodeFences(current)
            : current.trim();

        if (isNonEmptyString(normalized)) {
          segments.push(normalized);
        }
      } else if (Array.isArray(current)) {
        segments.push(...collectTextSegments(current, new Set(visited)));
      }
    }

    const nestedFieldOrder = [
      'pages',
      'result',
      'output',
      'data',
      'documents',
      'document',
      'nodes',
      'chunks',
      'items',
      'sections',
      'paragraphs',
      'children',
      'parts',
    ];

    for (const field of nestedFieldOrder) {
      const nested = record[field];
      if (nested && !visited.has(nested)) {
        segments.push(...collectTextSegments(nested, new Set(visited)));
      }
    }

    // Fallback: inspect any remaining values if we still have nothing.
    if (segments.length === 0) {
      for (const value of Object.values(record)) {
        segments.push(...collectTextSegments(value, new Set(visited)));
      }
    }

    return segments;
  }

  return [];
};

const normalizeStatus = (status: string | undefined): string | undefined =>
  typeof status === 'string' && status.trim() ? status.trim().toUpperCase() : undefined;

const extractJobId = (payload: ParseJobResponse | undefined): string | undefined => {
  if (!payload) {
    return undefined;
  }

  if (typeof payload === 'string') {
    return payload;
  }

  return (
    payload.parsing_job_id ||
    payload.parsingJobId ||
    payload.parsing_job?.id ||
    payload.parsingJob?.id ||
    payload.id ||
    payload.job_id ||
    payload.jobId ||
    payload.data?.id ||
    payload.data?.job_id ||
    payload.data?.parsing_job_id
  );
};

const extractJobStatus = (payload: ParseJobResponse | undefined): string | undefined => {
  if (!payload) {
    return undefined;
  }

  return (
    payload.parsing_job_status ||
    payload.parsing_job?.status ||
    payload.parsingJob?.status ||
    payload.status ||
    payload.state ||
    payload.job_status ||
    payload.data?.status ||
    payload.data?.state ||
    payload.data?.parsing_job_status
  );
};

const extractPageCount = (payload: unknown): number | undefined => {
  const normalizeNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

  if (!payload) {
    return undefined;
  }

  if (Array.isArray(payload)) {
    const flattened = payload
      .map((entry) => extractPageCount(entry))
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (flattened.length > 0) {
      return flattened[0];
    }
    return undefined;
  }

  if (typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as ParseJobResponse;

  const jobMetadata =
    record.job_metadata && typeof record.job_metadata === 'object' && !Array.isArray(record.job_metadata)
      ? (record.job_metadata as Record<string, unknown>)
      : null;

  const candidates = [
    record.page_count,
    record.pageCount,
    record.metadata?.page_count,
    record.parsing_job?.page_count,
    record.parsing_job?.metadata?.page_count,
    record.parsingJob?.page_count,
    record.data?.page_count,
    record.data?.metadata?.page_count,
    jobMetadata?.page_count,
    jobMetadata?.pageCount,
    jobMetadata?.pages,
    jobMetadata?.job_pages,
  ]
    .flatMap((value) => {
      if (Array.isArray(value)) {
        return value.length ? [value.length] : [];
      }
      return [value];
    })
    .map((value) => normalizeNumber(value))
    .filter((value): value is number => typeof value === 'number');

  if (candidates.length > 0) {
    return candidates[0];
  }

  const arrayLike =
    record.pages ||
    (Array.isArray(record.data?.pages) ? record.data?.pages : undefined) ||
    (Array.isArray(record.output) ? record.output : undefined);

  if (Array.isArray(arrayLike)) {
    return arrayLike.length;
  }

  return undefined;
};

const extractErrorMessage = (payload: ParseJobResponse | undefined): string | undefined => {
  if (!payload) {
    return undefined;
  }

  const candidates = [payload.error, payload.detail, payload.message, payload.data?.error].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );

  return candidates.length > 0 ? candidates[0] : undefined;
};

const extractTextFromResult = (payload: unknown): string => {
  const markdownPages = extractMarkdownPages(payload)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (markdownPages.length > 0) {
    const seenPages = new Set<string>();
    const orderedPages = markdownPages.filter((segment) => {
      if (seenPages.has(segment)) {
        return false;
      }
      seenPages.add(segment);
      return true;
    });
    return orderedPages.join('\n\n');
  }

  const segments = collectTextSegments(payload)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0 && payload && typeof payload === 'object') {
    return JSON.stringify(payload, null, 2);
  }

  const seen = new Set<string>();
  const orderedUnique = segments.filter((segment) => {
    if (seen.has(segment)) {
      return false;
    }
    seen.add(segment);
    return true;
  });

  return orderedUnique.join('\n\n');
};

const shouldRetryStatus = (status: number) => status === 429 || (status >= 500 && status < 600);

export class LlamaParseClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(config: AppConfig) {
    this.apiKey = config.llamaParseApiKey;
    this.baseUrl = config.llamaParseBaseUrl.replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async parseDocument(input: ParseDocumentInput): Promise<ParsedDocument> {
    if (!this.apiKey) {
      throw new Error('LlamaParse API key is not configured.');
    }

    const format = input.outputFormat ?? DEFAULT_RESULT_FORMAT;
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const context = {
      requestId,
      filename: input.filename,
      mimeType: input.mimeType,
      format,
      bufferSize: input.buffer.byteLength,
    };
    logInfo('llama-parse starting parse', context);
    const { jobId, uploadPayload } = await this.uploadDocument(input);
    const { jobPayload, pageCountFromJob } = await this.pollForCompletion(jobId);
    const { text, rawResult, pageCountFromResult } = await this.downloadResult(jobId, format);
    logInfo('llama-parse parse complete', {
      requestId,
      jobId,
      pageCountFromJob,
      pageCountFromResult,
      textLength: text.length,
    });

    return {
      text,
      pageCount: pageCountFromResult ?? pageCountFromJob ?? 0,
      jobId,
      raw: {
        upload: uploadPayload,
        job: jobPayload,
        result: rawResult,
      },
    };
  }

  private createUploadForm(input: ParseDocumentInput): FormData {
    const formData = new FormData();
    const byteArray = Uint8Array.from(input.buffer);
    const blob = new Blob([byteArray], { type: input.mimeType ?? 'application/octet-stream' });
    formData.append('file', blob, input.filename);
    return formData;
  }

  private async uploadDocument(
    input: ParseDocumentInput
  ): Promise<{ jobId: string; uploadPayload: ParseJobResponse }> {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const context = {
      requestId,
      filename: input.filename,
      mimeType: input.mimeType,
      bufferSize: input.buffer.byteLength,
    };
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      logInfo('llama-parse uploading document', { ...context, attempt });
      const response = await this.fetchWithAuth(UPLOAD_PATH, {
        method: 'POST',
        body: this.createUploadForm(input),
      });

      if (response.status === 405) {
        throw new Error(
          'LlamaParse rejected the upload request (405). Confirm that LLAMA_CLOUD_BASE_URL points to https://api.cloud.llamaindex.ai/api or a compatible proxy that forwards POST requests.'
        );
      }

      if (!response.ok) {
        logWarn('llama-parse upload failed', {
          ...context,
          status: response.status,
          statusText: response.statusText,
        });
        const errorText = await response.text();

        if (shouldRetryStatus(response.status) && attempt < MAX_UPLOAD_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * attempt);
          logInfo('llama-parse retrying upload', { ...context, attempt: attempt + 1 });
          continue;
        }

        throw new Error(
          `LlamaParse upload failed (${response.status}): ${errorText || response.statusText}`
        );
      }

      const uploadPayload = (await this.parseJsonOrText(response)) as ParseJobResponse;
      const jobId = extractJobId(uploadPayload);

      if (!jobId) {
        logError('llama-parse upload missing job id', context);
        throw new Error('LlamaParse did not return a job identifier.');
      }

      logInfo('llama-parse upload succeeded', { ...context, jobId });
      return { jobId, uploadPayload };
    }

    throw new Error('Unable to upload document to LlamaParse after multiple attempts.');
  }

  private async pollForCompletion(
    jobId: string
  ): Promise<{ jobPayload: ParseJobResponse; pageCountFromJob?: number }> {
    let attempts = 0;
    let lastPayload: ParseJobResponse | undefined;

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts += 1;

      logInfo('llama-parse polling for completion', { jobId, attempt: attempts });
      const response = await this.fetchWithAuth(`${JOB_PATH}/${encodeURIComponent(jobId)}`, {
        method: 'GET',
      });

      if (response.status === 404) {
        logInfo('llama-parse job 404 retry', { jobId, attempt: attempts });
        await sleep(POLL_DELAY_MS);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        if (shouldRetryStatus(response.status)) {
          logWarn('llama-parse poll transient error', {
            jobId,
            attempt: attempts,
            status: response.status,
            statusText: response.statusText,
          });
          await sleep(POLL_DELAY_MS);
          continue;
        }
        logError('llama-parse poll failed', {
          jobId,
          attempt: attempts,
          status: response.status,
          statusText: response.statusText,
        });
        throw new Error(
          `Failed to poll LlamaParse job (${response.status}): ${errorText || response.statusText}`
        );
      }

      lastPayload = (await this.parseJsonOrText(response)) as ParseJobResponse;
      const status = normalizeStatus(extractJobStatus(lastPayload));

      if (status && SUCCESS_STATUSES.has(status)) {
        logInfo('llama-parse job completed', {
          jobId,
          attempts,
          status,
          pageCount: extractPageCount(lastPayload),
        });
        return { jobPayload: lastPayload, pageCountFromJob: extractPageCount(lastPayload) };
      }

      if (status && FAILURE_STATUSES.has(status)) {
        const failureMessage =
          extractErrorMessage(lastPayload) || 'LlamaParse failed to process the document.';
        logError('llama-parse job failed', { jobId, attempts, status, failureMessage });
        throw new Error(failureMessage);
      }

      await sleep(POLL_DELAY_MS);
    }

    logError('llama-parse job timed out', { jobId, maxAttempts: MAX_POLL_ATTEMPTS });
    throw new Error('Timed out while waiting for LlamaParse to finish parsing.');
  }

  private async downloadResult(
    jobId: string,
    format: LlamaParseResultFormat,
    attempt = 1
  ): Promise<{ text: string; rawResult: unknown; pageCountFromResult?: number }> {
    const normalizedFormat: LlamaParseResultFormat = format === 'text' ? 'text' : 'markdown';
    logInfo('llama-parse downloading result', { jobId, format: normalizedFormat, attempt });
    const response = await this.fetchWithAuth(
      `${JOB_PATH}/${encodeURIComponent(jobId)}${RESULT_PATH_SUFFIX}/${normalizedFormat}`,
      {
        method: 'GET',
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      if (shouldRetryStatus(response.status) && attempt < MAX_UPLOAD_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
        logWarn('llama-parse download retrying', {
          jobId,
          attempt,
          status: response.status,
          statusText: response.statusText,
        });
        return this.downloadResult(jobId, normalizedFormat, attempt + 1);
      }
      logError('llama-parse download failed', {
        jobId,
        attempt,
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(
        `Failed to download parsed document (${response.status}): ${errorText || response.statusText}`
      );
    }

    const rawResult = await this.parseJsonOrText(response);
    const text = extractTextFromResult(rawResult).trim();
    const pagesCollection = findPagesCollection(rawResult);
    const pageCountFromResult =
      extractPageCount(rawResult) ??
      (Array.isArray(pagesCollection) ? pagesCollection.length : undefined);

    if (!text || pageCountFromResult === undefined) {
      const rawRecord =
        rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
          ? (rawResult as Record<string, unknown>)
          : null;

      const serializedJobMetadata =
        rawRecord && rawRecord.job_metadata && typeof rawRecord.job_metadata === 'object'
          ? JSON.stringify(rawRecord.job_metadata)
          : undefined;

      const debugContext: Record<string, unknown> = {
        jobId,
        format: normalizedFormat,
        textLength: text?.length ?? 0,
        hasText: Boolean(text && text.trim()),
        rawResultType: Array.isArray(rawResult) ? 'array' : typeof rawResult,
        hasPagesArray: Array.isArray(pagesCollection),
        pagesLength: Array.isArray(pagesCollection) ? pagesCollection.length : undefined,
        pageCountFromResult,
        jobMetadata: serializedJobMetadata,
      };

      if (rawRecord) {
        debugContext.topLevelKeys = Object.keys(rawRecord).slice(0, 10);
      }

      logError('llama-parse download produced incomplete payload', debugContext);

      logError('llama-parse download returned empty text', { jobId, format: normalizedFormat });
      throw new Error('Parsed document returned empty content.');
    }

    logInfo('llama-parse download succeeded', {
      jobId,
      format: normalizedFormat,
      attempt,
      textLength: text.length,
    });
    return {
      text,
      rawResult,
      pageCountFromResult,
    };
  }

  private async fetchWithAuth(path: string, init: RequestInit, attempt = 1): Promise<Response> {
    if (!this.apiKey) {
      throw new Error('LlamaParse API key is not configured.');
    }

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json, text/plain',
          ...(init.headers || {}),
        },
      });
    } catch (error) {
      if (
        attempt < MAX_FETCH_RETRIES &&
        error instanceof FetchError &&
        error.type === 'system'
      ) {
        await sleep(RETRY_DELAY_MS * attempt);
        return this.fetchWithAuth(path, init, attempt + 1);
      }

      if (error instanceof Error) {
        throw new Error(`Failed to reach LlamaParse service: ${error.message}`);
      }

      throw error;
    }
  }

  private async parseJsonOrText(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

    if (contentType.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
