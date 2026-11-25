import { z } from '@rag-eval/contracts';
import type {
  ProviderCapabilities,
  RerankProvider,
  RerankRequest,
  RerankResult,
} from './types.js';
import {
  isAbortOrTimeout,
  parseRetryAfterMs,
  ProviderError,
} from './errors.js';

const MAX_CANDIDATES = 100;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const rerankEntry = z.object({
  index: z.number().int().nonnegative(),
  relevance_score: z.number().finite().optional(),
  score: z.number().finite().optional(),
});
const rerankPayload = z.object({
  results: z.array(rerankEntry),
  id: z.string().optional(),
  meta: z
    .object({
      billed_units: z
        .object({ search_units: z.number().int().nonnegative().optional() })
        .optional(),
    })
    .optional(),
});

export interface HttpRerankerOptions {
  baseURL: string;
  apiKey?: string;
  defaultTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpRerankProvider implements RerankProvider {
  readonly kind = 'http' as const;
  readonly capabilities: ProviderCapabilities = {
    chat: false,
    embeddings: false,
    rerank: true,
    structuredOutput: false,
    temperature: false,
    maxTemperature: null,
    maxTokens: false,
    requiresMaxTokens: false,
  };
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly defaultTimeoutMs: number;
  private readonly transport: typeof fetch;

  constructor(options: HttpRerankerOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.transport = options.fetch ?? fetch;
  }

  async rerank(request: RerankRequest): Promise<RerankResult> {
    if (!request.query.trim()) {
      throw new ProviderError('invalid_input', 'Rerank query is required.');
    }
    if (!request.documents.length) {
      return { results: [], model: request.model, requestId: null };
    }
    if (request.documents.length > MAX_CANDIDATES) {
      throw new ProviderError(
        'invalid_input',
        `Reranker accepts at most ${MAX_CANDIDATES} candidates.`,
      );
    }

    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await this.transport(this.baseURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: request.model,
          query: request.query,
          documents: request.documents,
          ...(request.topN !== undefined ? { top_n: request.topN } : {}),
        }),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      if (isAbortOrTimeout(err)) {
        throw new ProviderError('timeout', 'Reranker request timed out.', {
          retryable: true,
          cause: err,
        });
      }
      throw new ProviderError('upstream_failure', 'Reranker request failed.', {
        retryable: true,
        cause: err,
      });
    }

    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 504) {
        throw new ProviderError(
          'timeout',
          'Reranker gateway timed out (HTTP 504).',
          { status: response.status },
        );
      }
      throw new ProviderError(
        'upstream_failure',
        `Reranker returned HTTP ${response.status}.`,
        {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
        },
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new ProviderError(
        'malformed_response',
        'Reranker returned an empty response body.',
      );
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ProviderError(
            'malformed_response',
            'Reranker response exceeded size limit.',
          );
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (isAbortOrTimeout(err)) {
        throw new ProviderError('timeout', 'Reranker response timed out.', {
          retryable: true,
          cause: err,
        });
      }
      throw new ProviderError(
        'upstream_failure',
        'Reranker response stream interrupted.',
        { retryable: true, cause: err },
      );
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new ProviderError(
        'malformed_response',
        'Reranker returned malformed JSON.',
      );
    }

    const parsed = rerankPayload.safeParse(rawJson);
    if (!parsed.success) {
      throw new ProviderError(
        'malformed_response',
        'Reranker returned an invalid payload structure.',
      );
    }
    if (!parsed.data.results.length) {
      throw new ProviderError(
        'malformed_response',
        'Reranker returned no candidate scores.',
      );
    }

    const seen = new Set<number>();
    const results: RerankResult['results'] = [];
    for (const item of parsed.data.results) {
      const score = item.relevance_score ?? item.score;
      if (
        item.index < 0 ||
        item.index >= request.documents.length ||
        seen.has(item.index) ||
        typeof score !== 'number' ||
        !Number.isFinite(score)
      ) {
        throw new ProviderError(
          'malformed_response',
          'Reranker returned invalid, duplicate, or out-of-range candidate scores.',
        );
      }
      seen.add(item.index);
      results.push({ index: item.index, score });
    }

    return {
      results,
      model: request.model,
      requestId: response.headers.get('x-request-id') ?? parsed.data.id ?? null,
    };
  }
}
