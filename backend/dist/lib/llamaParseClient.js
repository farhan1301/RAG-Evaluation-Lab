import fetch, { Blob, FormData } from 'node-fetch';
const SUCCESS_STATUSES = new Set(['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'READY', 'DONE']);
const FAILURE_STATUSES = new Set(['FAILED', 'ERROR', 'CANCELLED']);
const MAX_POLL_ATTEMPTS = 120;
const POLL_DELAY_MS = 1500;
const UPLOAD_PATH = '/v1/parsing/upload';
const JOB_PATH = '/v1/parsing/job';
const RESULT_PATH_SUFFIX = '/result';
const RESULT_FORMAT = 'markdown';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeStatus = (status) => typeof status === 'string' && status.trim() ? status.trim().toUpperCase() : undefined;
const extractJobId = (payload) => {
    if (!payload) {
        return undefined;
    }
    if (typeof payload === 'string') {
        return payload;
    }
    return (payload.parsing_job_id ||
        payload.parsingJobId ||
        payload.parsing_job?.id ||
        payload.parsingJob?.id ||
        payload.id ||
        payload.job_id ||
        payload.jobId ||
        payload.data?.id ||
        payload.data?.job_id ||
        payload.data?.parsing_job_id);
};
const extractJobStatus = (payload) => {
    if (!payload) {
        return undefined;
    }
    return (payload.parsing_job_status ||
        payload.parsing_job?.status ||
        payload.parsingJob?.status ||
        payload.status ||
        payload.state ||
        payload.job_status ||
        payload.data?.status ||
        payload.data?.state ||
        payload.data?.parsing_job_status);
};
const extractPageCount = (payload) => {
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
    ].filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (candidates.length > 0) {
        return candidates[0];
    }
    const arrayLike = payload.pages ||
        (Array.isArray(payload.data?.pages) ? payload.data?.pages : undefined) ||
        (Array.isArray(payload.output) ? payload.output : undefined);
    if (Array.isArray(arrayLike)) {
        return arrayLike.length;
    }
    return undefined;
};
const extractErrorMessage = (payload) => {
    if (!payload) {
        return undefined;
    }
    const candidates = [payload.error, payload.detail, payload.message, payload.data?.error].filter((value) => typeof value === 'string' && value.trim().length > 0);
    return candidates.length > 0 ? candidates[0] : undefined;
};
const extractTextFromResult = (payload) => {
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
        const record = payload;
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
        const arrayCollections = [record.pages, record.documents, record.nodes, record.chunks].filter((value) => Array.isArray(value));
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
    constructor(config) {
        this.apiKey = config.llamaParseApiKey;
        this.baseUrl = config.llamaParseBaseUrl.replace(/\/$/, '');
    }
    isConfigured() {
        return Boolean(this.apiKey);
    }
    async parseDocument(input) {
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
    createUploadForm(input) {
        const formData = new FormData();
        const byteArray = Uint8Array.from(input.buffer);
        const blob = new Blob([byteArray], { type: input.mimeType ?? 'application/octet-stream' });
        formData.append('file', blob, input.filename);
        return formData;
    }
    async uploadDocument(input) {
        const response = await this.fetchWithAuth(UPLOAD_PATH, {
            method: 'POST',
            body: this.createUploadForm(input),
        });
        if (response.status === 405) {
            throw new Error('LlamaParse rejected the upload request (405). Confirm that LLAMA_CLOUD_BASE_URL points to https://api.cloud.llamaindex.ai/api or a compatible proxy that forwards POST requests.');
        }
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`LlamaParse upload failed (${response.status}): ${errorText || response.statusText}`);
        }
        const uploadPayload = (await this.parseJsonOrText(response));
        const jobId = extractJobId(uploadPayload);
        if (!jobId) {
            throw new Error('LlamaParse did not return a job identifier.');
        }
        return { jobId, uploadPayload };
    }
    async pollForCompletion(jobId) {
        let attempts = 0;
        let lastPayload;
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
                throw new Error(`Failed to poll LlamaParse job (${response.status}): ${errorText || response.statusText}`);
            }
            lastPayload = (await this.parseJsonOrText(response));
            const status = normalizeStatus(extractJobStatus(lastPayload));
            if (status && SUCCESS_STATUSES.has(status)) {
                return { jobPayload: lastPayload, pageCountFromJob: extractPageCount(lastPayload) };
            }
            if (status && FAILURE_STATUSES.has(status)) {
                const failureMessage = extractErrorMessage(lastPayload) || 'LlamaParse failed to process the document.';
                throw new Error(failureMessage);
            }
            await sleep(POLL_DELAY_MS);
        }
        throw new Error('Timed out while waiting for LlamaParse to finish parsing.');
    }
    async downloadResult(jobId) {
        const response = await this.fetchWithAuth(`${JOB_PATH}/${encodeURIComponent(jobId)}${RESULT_PATH_SUFFIX}/${RESULT_FORMAT}`, {
            method: 'GET',
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to download parsed document (${response.status}): ${errorText || response.statusText}`);
        }
        const rawResult = await this.parseJsonOrText(response);
        const text = extractTextFromResult(rawResult).trim();
        if (!text) {
            throw new Error('Parsed document returned empty content.');
        }
        return {
            text,
            rawResult,
            pageCountFromResult: extractPageCount(rawResult),
        };
    }
    async fetchWithAuth(path, init) {
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
    async parseJsonOrText(response) {
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (contentType.includes('application/json')) {
            return response.json();
        }
        const text = await response.text();
        try {
            return JSON.parse(text);
        }
        catch {
            return text;
        }
    }
}
