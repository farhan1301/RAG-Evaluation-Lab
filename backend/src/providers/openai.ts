import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  EmbeddingProvider,
  EmbedRequest,
  EmbedResult,
  ProviderCapabilities,
  ProviderUsage,
} from './types.js';
import {
  isAbortOrTimeout,
  parseRetryAfterMs,
  ProviderError,
  type ProviderCallMeta,
} from './errors.js';

export interface OpenAIAdapterOptions {
  kind: 'openai' | 'openai-compatible';
  capabilities: ProviderCapabilities;
  apiKey?: string;
  baseURL?: string;
  defaultTimeoutMs?: number;
  defaultBatchSize?: number;
  expectedDimensions?: number;
  fetch?: typeof fetch;
}

function usesMaxCompletionTokens(
  kind: 'openai' | 'openai-compatible',
  model: string,
) {
  if (kind !== 'openai') return false;
  const normalized = model.toLowerCase();
  return normalized.startsWith('gpt-5') || /^o\d/.test(normalized);
}

function extractRequestId(value: unknown): string | null {
  if (
    value &&
    typeof value === 'object' &&
    '_request_id' in value &&
    typeof value._request_id === 'string' &&
    value._request_id
  )
    return value._request_id;
  return null;
}

function mapOpenAIError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (
    err instanceof APIConnectionTimeoutError ||
    err instanceof APIUserAbortError ||
    isAbortOrTimeout(err)
  ) {
    return new ProviderError('timeout', 'Provider request timed out.', {
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof APIError) {
    const status = err.status;
    const retryAfterMs = parseRetryAfterMs(err.headers?.get('retry-after'));
    return new ProviderError(
      'upstream_failure',
      `Provider request failed (HTTP ${status ?? 'unknown'}).`,
      {
        status,
        retryable: status === 429 || (status !== undefined && status >= 500),
        retryAfterMs,
        cause: err,
      },
    );
  }
  return new ProviderError('upstream_failure', 'Provider request failed.', {
    retryable: true,
    cause: err,
  });
}

export class OpenAIProvider implements ChatProvider, EmbeddingProvider {
  readonly kind: 'openai' | 'openai-compatible';
  readonly capabilities: ProviderCapabilities;
  private readonly client: OpenAI;
  private readonly defaultTimeoutMs: number;
  private readonly defaultBatchSize: number;
  private readonly expectedDimensions?: number;

  constructor(options: OpenAIAdapterOptions) {
    this.kind = options.kind;
    this.capabilities = options.capabilities;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.defaultBatchSize = Math.max(
      1,
      Math.min(2048, options.defaultBatchSize ?? 64),
    );
    this.expectedDimensions = options.expectedDimensions;
    const hasKey = Boolean(options.apiKey?.trim());
    this.client = new OpenAI({
      apiKey: hasKey ? options.apiKey : 'local-no-auth',
      baseURL: options.baseURL,
      maxRetries: 0,
      timeout: this.defaultTimeoutMs,
      fetch: options.fetch,
      // Explicitly suppress Bearer auth for unauthenticated OpenAI-compatible local endpoints (e.g. Ollama).
      ...(hasKey ? {} : { defaultHeaders: { Authorization: null } }),
    });
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    if (!this.capabilities.embeddings) {
      throw new ProviderError(
        'missing_capability',
        'Selected provider profile does not support embeddings.',
      );
    }
    if (!request.inputs.length) {
      return {
        vectors: [],
        dimensions: request.expectedDimensions ?? this.expectedDimensions ?? 0,
        model: request.model,
        provider: this.kind,
        requestIds: [],
      };
    }
    const batchSize = Math.max(
      1,
      Math.min(2048, request.batchSize ?? this.defaultBatchSize),
    );
    const timeout = request.timeoutMs ?? this.defaultTimeoutMs;
    const vectors: number[][] = [];
    const requestIds: string[] = [];
    let expectedDim = request.expectedDimensions ?? this.expectedDimensions;
    let promptTokens = 0;
    let totalTokens = 0;
    let allBatchesHadUsage = true;

    for (let offset = 0; offset < request.inputs.length; offset += batchSize) {
      request.signal?.throwIfAborted();
      const batch = request.inputs.slice(offset, offset + batchSize);
      let response: OpenAI.Embeddings.CreateEmbeddingResponse;
      try {
        response = await this.client.embeddings.create(
          {
            model: request.model,
            input: batch,
            encoding_format: 'float',
          },
          { signal: request.signal, timeout },
        );
      } catch (err) {
        throw mapOpenAIError(err);
      }

      const reqId = extractRequestId(response);
      if (reqId) requestIds.push(reqId);
      const batchUsage: ProviderUsage | undefined =
        response.usage && typeof response.usage.prompt_tokens === 'number'
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: 0,
              totalTokens:
                typeof response.usage.total_tokens === 'number'
                  ? response.usage.total_tokens
                  : response.usage.prompt_tokens,
            }
          : undefined;
      const callMeta: ProviderCallMeta = {
        provider: this.kind,
        model: response.model || request.model,
        requestId: reqId,
        usage: batchUsage,
      };

      const items: OpenAI.Embeddings.Embedding[] | null = Array.isArray(
        response?.data,
      )
        ? response.data
        : null;
      if (!items || items.length !== batch.length) {
        throw new ProviderError(
          'partial_batch',
          `Embedding batch size mismatch: expected ${batch.length}, received ${items?.length ?? 0}.`,
          { callMeta },
        );
      }

      const ordered: Array<number[] | undefined> = new Array(batch.length);
      for (let i = 0; i < items.length; i++) {
        const entry: OpenAI.Embeddings.Embedding | undefined = items[i];
        const idx =
          typeof entry?.index === 'number' && Number.isInteger(entry.index)
            ? entry.index
            : i;
        if (idx < 0 || idx >= batch.length || ordered[idx] !== undefined) {
          throw new ProviderError(
            'partial_batch',
            'Embedding batch returned invalid or duplicate item indices.',
            { callMeta },
          );
        }
        const vec = entry?.embedding;
        if (
          !Array.isArray(vec) ||
          vec.length === 0 ||
          !vec.every((n) => typeof n === 'number' && Number.isFinite(n))
        ) {
          throw new ProviderError(
            'malformed_response',
            'Embedding provider returned an invalid vector.',
            { callMeta },
          );
        }
        if (expectedDim === undefined) expectedDim = vec.length;
        else if (vec.length !== expectedDim) {
          throw new ProviderError(
            'dimension_mismatch',
            `Embedding dimension mismatch: expected ${expectedDim}, received ${vec.length}.`,
            { callMeta },
          );
        }
        ordered[idx] = vec;
      }

      for (const vec of ordered) {
        if (!vec) {
          throw new ProviderError(
            'partial_batch',
            'Embedding batch was missing one or more vectors.',
            { callMeta },
          );
        }
        vectors.push(vec);
      }

      if (batchUsage) {
        promptTokens += batchUsage.inputTokens;
        totalTokens += batchUsage.totalTokens;
      } else {
        allBatchesHadUsage = false;
      }
    }

    return {
      vectors,
      dimensions: expectedDim ?? 0,
      model: request.model,
      provider: this.kind,
      requestIds,
      ...(allBatchesHadUsage
        ? {
            usage: {
              inputTokens: promptTokens,
              outputTokens: 0,
              totalTokens,
            },
          }
        : {}),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!this.capabilities.chat) {
      throw new ProviderError(
        'missing_capability',
        'Selected provider profile does not support chat generation.',
      );
    }
    const effectiveParams: ChatResult['effectiveParams'] = {
      structuredOutput: false,
    };
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming =
      {
        model: request.model,
        messages: request.messages,
      };

    if (request.temperature !== undefined) {
      if (!this.capabilities.temperature) {
        if (request.temperature !== 1) {
          throw new ProviderError(
            'missing_capability',
            'Selected profile requires the provider default temperature of 1.',
          );
        }
      } else {
        const maxTemp = this.capabilities.maxTemperature ?? 2;
        if (
          !Number.isFinite(request.temperature) ||
          request.temperature < 0 ||
          request.temperature > maxTemp
        ) {
          throw new ProviderError(
            'invalid_input',
            `Temperature must be between 0 and ${maxTemp} for this profile.`,
          );
        }
        body.temperature = request.temperature;
        effectiveParams.temperature = request.temperature;
      }
    }

    if (request.maxTokens !== undefined) {
      if (!this.capabilities.maxTokens) {
        throw new ProviderError(
          'missing_capability',
          'Selected profile does not support a token limit.',
        );
      }
      if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
        throw new ProviderError(
          'invalid_input',
          'maxTokens must be a positive integer.',
        );
      }
      if (usesMaxCompletionTokens(this.kind, request.model)) {
        body.max_completion_tokens = request.maxTokens;
      } else {
        body.max_tokens = request.maxTokens;
      }
      effectiveParams.maxTokens = request.maxTokens;
    }

    if (request.responseFormat) {
      if (
        request.responseFormat.type === 'json_schema' &&
        this.capabilities.structuredOutput
      ) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: request.responseFormat.name,
            strict: true,
            schema: request.responseFormat.schema,
          },
        };
        effectiveParams.structuredOutput = true;
      } else if (
        request.responseFormat.type === 'json_object' &&
        this.capabilities.structuredOutput
      ) {
        body.response_format = { type: 'json_object' };
      }
    }

    const timeout = request.timeoutMs ?? this.defaultTimeoutMs;
    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await this.client.chat.completions.create(body, {
        signal: request.signal,
        timeout,
      });
    } catch (err) {
      throw mapOpenAIError(err);
    }

    const requestId = extractRequestId(response);
    const responseModel = response.model || request.model;
    let usage: ProviderUsage | undefined;
    if (response.usage) {
      const inputTokens = response.usage.prompt_tokens ?? 0;
      const outputTokens = response.usage.completion_tokens ?? 0;
      const cached = response.usage.prompt_tokens_details?.cached_tokens;
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: response.usage.total_tokens ?? inputTokens + outputTokens,
        ...(typeof cached === 'number' && cached > 0
          ? { cacheReadTokens: cached }
          : {}),
      };
    }

    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError(
        'malformed_response',
        'Chat provider returned empty content.',
        {
          callMeta: {
            provider: this.kind,
            model: responseModel,
            requestId,
            usage,
          },
        },
      );
    }

    return {
      content,
      model: responseModel,
      provider: this.kind,
      requestId,
      usage,
      effectiveParams,
    };
  }
}
