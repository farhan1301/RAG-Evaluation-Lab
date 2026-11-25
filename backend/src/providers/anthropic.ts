import Anthropic, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import type {
  ChatProvider,
  ChatRequest,
  ChatResult,
  ProviderCapabilities,
  ProviderUsage,
} from './types.js';
import {
  isAbortOrTimeout,
  parseRetryAfterMs,
  ProviderError,
} from './errors.js';

export interface AnthropicAdapterOptions {
  capabilities: ProviderCapabilities;
  apiKey: string;
  baseURL?: string;
  defaultTimeoutMs?: number;
  fetch?: typeof fetch;
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

function mapAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (
    err instanceof APIConnectionTimeoutError ||
    err instanceof APIUserAbortError ||
    isAbortOrTimeout(err)
  ) {
    return new ProviderError('timeout', 'Anthropic request timed out.', {
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 504) {
      return new ProviderError(
        'timeout',
        'Anthropic gateway timed out (HTTP 504).',
        { status, cause: err },
      );
    }
    const retryAfterMs = parseRetryAfterMs(err.headers?.get('retry-after'));
    return new ProviderError(
      'upstream_failure',
      `Anthropic request failed (HTTP ${status ?? 'unknown'}).`,
      {
        status,
        retryable:
          status === 429 ||
          status === 529 ||
          (status !== undefined && status >= 500),
        retryAfterMs,
        cause: err,
      },
    );
  }
  return new ProviderError('upstream_failure', 'Anthropic request failed.', {
    retryable: true,
    cause: err,
  });
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic' as const;
  readonly capabilities: ProviderCapabilities;
  private readonly client: Anthropic;
  private readonly defaultTimeoutMs: number;

  constructor(options: AnthropicAdapterOptions) {
    if (options.capabilities.embeddings) {
      throw new ProviderError(
        'missing_capability',
        'Anthropic does not implement the embeddings contract.',
      );
    }
    this.capabilities = options.capabilities;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      maxRetries: 0,
      timeout: this.defaultTimeoutMs,
      fetch: options.fetch,
      openTelemetry: false,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (!this.capabilities.chat) {
      throw new ProviderError(
        'missing_capability',
        'Selected Anthropic profile does not support chat generation.',
      );
    }
    const maxTokens = request.maxTokens ?? 1024;
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new ProviderError(
        'invalid_input',
        'maxTokens must be a positive integer.',
      );
    }

    const effectiveParams: ChatResult['effectiveParams'] = {
      maxTokens,
      structuredOutput: false,
    };

    const systemParts = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content.trim())
      .filter(Boolean);
    const messages: Anthropic.Messages.MessageParam[] = request.messages
      .filter(
        (m): m is { role: 'user' | 'assistant'; content: string } =>
          m.role !== 'system',
      )
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length) {
      throw new ProviderError(
        'invalid_input',
        'Anthropic requests require at least one user or assistant message.',
      );
    }

    const body: Anthropic.Messages.MessageCreateParamsNonStreaming & {
      temperature?: number;
    } = {
      model: request.model,
      max_tokens: maxTokens,
      messages,
      ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
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
        const maxTemp = this.capabilities.maxTemperature ?? 1;
        if (!Number.isFinite(request.temperature) || request.temperature < 0) {
          throw new ProviderError(
            'invalid_input',
            `Anthropic supports temperature between 0 and ${maxTemp}.`,
          );
        }
        if (request.temperature > maxTemp) {
          throw new ProviderError(
            'missing_capability',
            `Anthropic supports temperature between 0 and ${maxTemp}.`,
          );
        }
        body.temperature = request.temperature;
        effectiveParams.temperature = request.temperature;
      }
    }

    if (
      request.responseFormat?.type === 'json_schema' &&
      this.capabilities.structuredOutput
    ) {
      body.output_config = {
        format: {
          type: 'json_schema',
          schema: request.responseFormat.schema,
        },
      };
      effectiveParams.structuredOutput = true;
    }

    const timeout = request.timeoutMs ?? this.defaultTimeoutMs;
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create(body, {
        signal: request.signal,
        timeout,
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    const requestId = extractRequestId(response);
    const responseModel = response.model || request.model;
    let usage: ProviderUsage | undefined;
    if (response.usage) {
      const inputTokens = response.usage.input_tokens ?? 0;
      const outputTokens = response.usage.output_tokens ?? 0;
      const cacheRead = response.usage.cache_read_input_tokens ?? 0;
      const cacheCreation = response.usage.cache_creation_input_tokens ?? 0;
      usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
      };
    }

    const content = (response.content ?? [])
      .filter(
        (block): block is Anthropic.Messages.TextBlock =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('');

    if (!content.trim()) {
      throw new ProviderError(
        'malformed_response',
        'Anthropic returned empty text content.',
        {
          callMeta: {
            provider: 'anthropic',
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
      provider: 'anthropic',
      requestId,
      usage,
      effectiveParams,
    };
  }
}
