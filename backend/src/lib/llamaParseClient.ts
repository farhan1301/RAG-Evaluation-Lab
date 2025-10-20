import fetch, { Blob, FormData, type RequestInit, type Response } from 'node-fetch';
import type { AppConfig } from './config.js';

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

export interface ParseDocumentInput {
  buffer: Buffer;
  filename: string;
  mimeType?: string;
}

const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'READY', 'DONE']);
const FAILURE_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED']);
const MAX_POLL_ATTEMPTS = 120;
const POLL_DELAY_MS = 1500;
const UPLOAD_PATH = '/v1/parsing/upload';
const JOB_PATH = '/v1/parsing/job';
const RESULT_PATH_SUFFIX = '/result';
const RESULT_FORMAT = 'markdown';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const extractPageCount = (payload: ParseJobResponse | undefined): number | undefined => {
  if (!payload) {
    return undefined;
  }

  const candidates = [
    payload.page_count,
    payload.pageCount,
    payload.metadata?.page_count,
    payload.parsing_job?.page_count,
    payload.parsing_job?.metadata?.page_count,
    payload.parsingJob?.page_count,
    payload.data?.page_count,
    payload.data?.metadata?.page_count,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (candidates.length > 0) {
    return candidates[0];
  }

  const arrayLike =
    payload.pages ||
    (Array.isArray(payload.data?.pages) ? payload.data?.pages : undefined) ||
    (Array.isArray(payload.output) ? payload.output : undefined);

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
  if (!payload) {
    return '';
  }

  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((entry) => extractTextFromResult(entry)).filter(Boolean).join('\n\n');
  }

  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const directFields = [
      record.markdown,
      record.text,
      record.content,
      record.html,
      record.body,
      record.data,
      record.document,
    ];

    for (const field of directFields) {
      if (typeof field === 'string' && field.trim()) {
        return field;
      }
    }

    const nestedCandidates = [record.result, record.output, record.data, record.markdown_result];

    for (const candidate of nestedCandidates) {
      const extracted = extractTextFromResult(candidate);
      if (extracted.trim()) {
        return extracted;
      }
    }

    const arrayCollections = [record.pages, record.documents, record.nodes, record.chunks].filter(
      (value): value is unknown[] => Array.isArray(value)
    );

    for (const collection of arrayCollections) {
      const text = collection.map((item) => extractTextFromResult(item)).filter(Boolean).join('\n\n');
      if (text.trim()) {
        return text;
      }
    }

    return JSON.stringify(payload, null, 2);
  }

  return '';
};

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

    const { jobId, uploadPayload } = await this.uploadDocument(input);
    const { jobPayload, pageCountFromJob } = await this.pollForCompletion(jobId);
    const { text, rawResult, pageCountFromResult } = await this.downloadResult(jobId);

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
      const errorText = await response.text();
      throw new Error(
        `LlamaParse upload failed (${response.status}): ${errorText || response.statusText}`
      );
    }

    const uploadPayload = (await this.parseJsonOrText(response)) as ParseJobResponse;
    const jobId = extractJobId(uploadPayload);

    if (!jobId) {
      throw new Error('LlamaParse did not return a job identifier.');
    }

    return { jobId, uploadPayload };
  }

  private async pollForCompletion(
    jobId: string
  ): Promise<{ jobPayload: ParseJobResponse; pageCountFromJob?: number }> {
    let attempts = 0;
    let lastPayload: ParseJobResponse | undefined;

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts += 1;

      const response = await this.fetchWithAuth(`${JOB_PATH}/${encodeURIComponent(jobId)}`, {
        method: 'GET',
      });

      if (response.status === 404) {
        await sleep(POLL_DELAY_MS);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to poll LlamaParse job (${response.status}): ${errorText || response.statusText}`
        );
      }

      lastPayload = (await this.parseJsonOrText(response)) as ParseJobResponse;
      const status = normalizeStatus(extractJobStatus(lastPayload));

      if (status && SUCCESS_STATUSES.has(status)) {
        return { jobPayload: lastPayload, pageCountFromJob: extractPageCount(lastPayload) };
      }

      if (status && FAILURE_STATUSES.has(status)) {
        const failureMessage =
          extractErrorMessage(lastPayload) || 'LlamaParse failed to process the document.';
        throw new Error(failureMessage);
      }

      await sleep(POLL_DELAY_MS);
    }

    throw new Error('Timed out while waiting for LlamaParse to finish parsing.');
  }

  private async downloadResult(
    jobId: string
  ): Promise<{ text: string; rawResult: unknown; pageCountFromResult?: number }> {
    const response = await this.fetchWithAuth(
      `${JOB_PATH}/${encodeURIComponent(jobId)}${RESULT_PATH_SUFFIX}/${RESULT_FORMAT}`,
      {
        method: 'GET',
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to download parsed document (${response.status}): ${errorText || response.statusText}`
      );
    }

    const rawResult = await this.parseJsonOrText(response);
    const text = extractTextFromResult(rawResult).trim();

    if (!text) {
      throw new Error('Parsed document returned empty content.');
    }

    return {
      text,
      rawResult,
      pageCountFromResult: extractPageCount(rawResult as ParseJobResponse),
    };
  }

  private async fetchWithAuth(path: string, init: RequestInit): Promise<Response> {
    if (!this.apiKey) {
      throw new Error('LlamaParse API key is not configured.');
    }

    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });
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
