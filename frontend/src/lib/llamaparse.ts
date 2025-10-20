const DEFAULT_LLAMA_PARSE_BASE_URL = 'https://api.cloud.llamaindex.ai/api';
const MAX_POLL_ATTEMPTS = Number(
  typeof import.meta !== 'undefined'
    ? (import.meta as any).env?.VITE_LLAMA_PARSE_MAX_POLLS ?? ''
    : ''
) || 120;
const POLL_INTERVAL_MS =
  Number(
    typeof import.meta !== 'undefined'
      ? (import.meta as any).env?.VITE_LLAMA_PARSE_POLL_INTERVAL_MS ?? ''
      : ''
  ) || 1500;

const resolveBaseUrl = () => {
  let envUrl: string | undefined;

  try {
    envUrl =
      typeof import.meta !== 'undefined'
        ? (import.meta as any).env?.VITE_LLAMA_PARSE_BASE_URL
        : undefined;
  } catch {
    envUrl = undefined;
  }

  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.replace(/\/$/, '');
  }

  if (typeof window !== 'undefined') {
    const fromGlobal = (window as any).__LLAMA_PARSE_BASE_URL__;
    if (typeof fromGlobal === 'string' && fromGlobal.trim()) {
      return fromGlobal.replace(/\/$/, '');
    }
  }

  if (typeof window !== 'undefined' && typeof import.meta !== 'undefined') {
    const meta = import.meta as any;
    if (meta.env?.DEV) {
      return '/llamacloud';
    }
  }

  return DEFAULT_LLAMA_PARSE_BASE_URL;
};

const resolveEndpoint = (path: string) => `${resolveBaseUrl()}${path}`;

export type LlamaParseStage =
  | 'uploading'
  | 'queued'
  | 'processing'
  | 'retrieving';

export interface LlamaParseProgress {
  stage: LlamaParseStage;
  message?: string;
  progress?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const logLlamaParse = (...values: any[]) => {
  if (typeof console !== 'undefined' && typeof console.info === 'function') {
    console.info('[LlamaParse]', ...values);
  }
};

function extractJobId(payload: any): string | undefined {
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
}

function extractJobStatus(payload: any): string | undefined {
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
}

function normalizeJobStatus(status: string | undefined) {
  if (!status) {
    return 'UNKNOWN';
  }

  return status.toUpperCase();
}

function extractTextFromResult(payload: any): string {
  if (!payload) {
    return '';
  }

  if (Array.isArray(payload)) {
    const joined = payload
      .map((item) => extractTextFromResult(item))
      .filter(Boolean)
      .join('\n\n');
    if (joined.trim()) {
      return joined;
    }
    return '';
  }

  if (typeof payload === 'string') {
    return payload;
  }

  const directFields = [
    payload.markdown,
    payload.text,
    payload.content,
    payload.html,
    payload.body,
    payload.data,
    payload.document,
  ];

  for (const field of directFields) {
    if (typeof field === 'string' && field.trim()) {
      return field;
    }
  }

  const nestedCandidates = [
    payload.result,
    payload.output,
    payload.data,
    payload.markdown_result,
  ];

  for (const candidate of nestedCandidates) {
    const extracted = extractTextFromResult(candidate);
    if (extracted.trim()) {
      return extracted;
    }
  }

  const arrayCollections = [payload.pages, payload.documents, payload.nodes, payload.chunks].filter(
    (value): value is any[] => Array.isArray(value)
  );

  for (const collection of arrayCollections) {
    const text = collection
      .map((item) => extractTextFromResult(item))
      .filter(Boolean)
      .join('\n\n');
    if (text.trim()) {
      return text;
    }
  }

  return JSON.stringify(payload, null, 2);
}

export async function parseDocumentWithLlamaParse(
  file: File,
  apiKey: string,
  onProgress?: (progress: LlamaParseProgress) => void
): Promise<string> {
  if (!apiKey) {
    throw new Error('Missing LlamaParse API key.');
  }

  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };

  const startedAt = Date.now();
  logLlamaParse('Uploading document to LlamaParse', {
    fileName: file.name,
    fileSize: file.size,
  });

  const formData = new FormData();
  formData.append('file', file, file.name);

  onProgress?.({
    stage: 'uploading',
    message: 'Uploading document to LlamaParse…',
    progress: 15,
  });

  let uploadResponse: Response;
  try {
    uploadResponse = await fetch(resolveEndpoint('/v1/parsing/upload'), {
      method: 'POST',
      headers: authHeaders,
      body: formData,
    });
  } catch (error) {
    if (error instanceof TypeError && /Failed to fetch/i.test(error.message)) {
      logLlamaParse('Upload request failed: network error', { fileName: file.name, error });
      throw new Error(
        'Unable to reach LlamaParse service. Check your network connection or configure a proxy endpoint.'
      );
    }
    logLlamaParse('Upload request failed', { fileName: file.name, error });
    throw error;
  }

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    if (uploadResponse.status === 405) {
      throw new Error(
        'LlamaParse rejected the upload request (405). Confirm that your proxy forwards POST requests to https://cloud.llamaindex.ai/api and that the base URL ends with /api.'
      );
    }
    logLlamaParse('Upload rejected by LlamaParse', {
      fileName: file.name,
      status: uploadResponse.status,
      errorText,
    });
    throw new Error(
      `Upload failed (${uploadResponse.status}): ${errorText || uploadResponse.statusText}`
    );
  }

  let uploadPayload: any;
  const contentType = uploadResponse.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    uploadPayload = await uploadResponse.json();
  } else {
    uploadPayload = await uploadResponse.text();
  }

  const jobId = extractJobId(uploadPayload);
  if (!jobId) {
    logLlamaParse('Upload succeeded but no job id returned', { fileName: file.name, payload: uploadPayload });
    throw new Error('LlamaParse did not return a job id.');
  }

  logLlamaParse('Upload successful', { fileName: file.name, jobId });

  onProgress?.({
    stage: 'queued',
    message: 'Document is queued for parsing…',
    progress: 35,
  });

  let attempts = 0;
  let status = 'QUEUED';
  let lastPayload: any = uploadPayload;
  let consecutiveMissing = 0;
  let lastLoggedStatus: string | null = null;

  while (attempts < MAX_POLL_ATTEMPTS) {
    attempts += 1;

    let jobResponse: Response | null = null;
    try {
      jobResponse = await fetch(resolveEndpoint(`/v1/parsing/job/${jobId}`), {
        method: 'GET',
        headers: authHeaders,
      });
    } catch (error) {
      if (error instanceof TypeError && /Failed to fetch/i.test(error.message)) {
        logLlamaParse('Polling job failed: network error', { jobId, attempt: attempts, error });
        throw new Error(
          'Connection lost while polling LlamaParse. Verify proxy configuration or retry later.'
        );
      }
      logLlamaParse('Polling job failed', { jobId, attempt: attempts, error });
      throw error;
    }

    if (jobResponse.status === 404) {
      consecutiveMissing += 1;
      onProgress?.({
        stage: 'processing',
        message:
          consecutiveMissing > 3
            ? 'Still waiting for parse job to register…'
            : 'Waiting for parse job to be ready…',
        progress: 40 + Math.min(10, consecutiveMissing * 3),
      });
      await sleep(POLL_INTERVAL_MS);
      continue;
    } else {
      consecutiveMissing = 0;
    }

    if (!jobResponse.ok) {
      const errorText = await jobResponse.text();
      logLlamaParse('Polling job returned error response', {
        jobId,
        status: jobResponse.status,
        errorText,
      });
      throw new Error(
        `Failed to poll parse job (${jobResponse.status}): ${errorText || jobResponse.statusText}`
      );
    }

    const jobContentType = jobResponse.headers.get('content-type') || '';
    if (jobContentType.includes('application/json')) {
      lastPayload = await jobResponse.json();
    } else {
      lastPayload = await jobResponse.text();
    }

    status = normalizeJobStatus(extractJobStatus(lastPayload));

    if (status !== lastLoggedStatus) {
      logLlamaParse('Job status update', { jobId, status });
      lastLoggedStatus = status;
    }

    if (status === 'SUCCESS' || status === 'SUCCEEDED' || status === 'COMPLETED') {
      break;
    }

    if (status === 'FAILED' || status === 'ERROR') {
      const errorMessage =
        lastPayload?.error ||
        lastPayload?.detail ||
        lastPayload?.message ||
        'The document failed to parse.';
      logLlamaParse('Job failed', { jobId, status, errorMessage });
      throw new Error(errorMessage);
    }

    onProgress?.({
      stage: 'processing',
      message: `Parsing in progress (${status.toLowerCase()})…`,
      progress:
        status === 'QUEUED'
          ? 35 + Math.min(25, attempts)
          : 45 + Math.min(45, attempts * 2),
    });

    await sleep(POLL_INTERVAL_MS);
  }

  if (
    status !== 'SUCCESS' &&
    status !== 'SUCCEEDED' &&
    status !== 'COMPLETED'
  ) {
    logLlamaParse('Job timed out', { jobId, attempts, lastStatus: status });
    throw new Error(
      `Parsing timed out after ${attempts} checks. Last status: ${status}`
    );
  }

  onProgress?.({
    stage: 'retrieving',
    message: 'Fetching parsed output…',
    progress: 90,
  });

  let resultResponse: Response;
  try {
    resultResponse = await fetch(
      resolveEndpoint(`/v1/parsing/job/${jobId}/result/markdown`),
      {
        method: 'GET',
        headers: authHeaders,
      }
    );
  } catch (error) {
    if (error instanceof TypeError && /Failed to fetch/i.test(error.message)) {
      logLlamaParse('Failed to download result: network error', { jobId, error });
      throw new Error(
        'Unable to download parsed document. Ensure outbound HTTPS access to LlamaParse is permitted.'
      );
    }
    logLlamaParse('Failed to download result', { jobId, error });
    throw error;
  }

  if (!resultResponse.ok) {
    const errorText = await resultResponse.text();
    logLlamaParse('Result download returned error response', {
      jobId,
      status: resultResponse.status,
      errorText,
    });
    throw new Error(
      `Failed to download parsed result (${resultResponse.status}): ${errorText || resultResponse.statusText}`
    );
  }

  const resultContentType = resultResponse.headers.get('content-type') || '';
  let resultPayload: any;

  if (resultContentType.includes('application/json')) {
    resultPayload = await resultResponse.json();
  } else {
    resultPayload = await resultResponse.text();
  }

  const extractedText = extractTextFromResult(resultPayload);
  if (!extractedText || !extractedText.trim()) {
    logLlamaParse('Parsed document returned empty content', { jobId, payload: resultPayload });
    throw new Error('Parsed document returned empty content.');
  }

  logLlamaParse('Parsing complete', {
    jobId,
    durationMs: Date.now() - startedAt,
    characters: extractedText.length,
  });

  return extractedText;
}
