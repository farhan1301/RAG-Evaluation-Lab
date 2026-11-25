import type {
  Capabilities,
  PipelineConfig,
  Profile,
  Role,
} from '@rag-eval/contracts';
import type { Config, ResolvedProviderProfile } from '../config/env.js';
import { ApiError } from '../errors.js';
import { AnthropicProvider } from './anthropic.js';
import { ProviderError } from './errors.js';
import { OpenAIProvider } from './openai.js';
import { HttpRerankProvider } from './reranker.js';
import type {
  ChatProvider,
  EmbeddingProvider,
  RerankProvider,
} from './types.js';

export interface ProviderTransports {
  openai?: typeof fetch;
  openaiCompatible?: typeof fetch;
  anthropic?: typeof fetch;
  rerank?: typeof fetch;
}

export function validateGenerationParams(
  profile: Profile,
  params: { temperature?: number; maxTokens?: number },
) {
  const { capabilities } = profile;
  if (params.temperature !== undefined) {
    if (!capabilities.temperature) {
      if (params.temperature !== 1) {
        throw new ApiError(
          422,
          'missing_capability',
          'The selected answer profile requires the default temperature of 1.',
        );
      }
    } else if (
      capabilities.maxTemperature !== null &&
      (params.temperature < 0 ||
        params.temperature > capabilities.maxTemperature)
    ) {
      throw new ApiError(
        422,
        'missing_capability',
        `The selected answer profile supports temperature up to ${capabilities.maxTemperature}.`,
      );
    }
  }
  if (params.maxTokens !== undefined && !capabilities.maxTokens) {
    throw new ApiError(
      422,
      'missing_capability',
      'The selected profile does not support maxTokens.',
    );
  }
}

export function validatePipelineCapabilities(
  config: PipelineConfig,
  capabilities: Capabilities,
) {
  const resolveRole = (role: Role, requestedModel: string) =>
    capabilities.profiles.find(
      (p) => p.role === role && (!requestedModel || p.model === requestedModel),
    );

  const chat = resolveRole('chat', config.llm.model);
  if (chat) {
    validateGenerationParams(chat, {
      temperature: config.llm.temperature,
      maxTokens: config.llm.maxTokens,
    });
  }

  for (const [role, model] of [
    ['embedding', config.embedding.model],
    ['chat', config.llm.model],
    ['judge', config.judge.model],
  ] as const) {
    if (
      model &&
      !capabilities.profiles.some((p) => p.role === role && p.model === model)
    ) {
      throw new ApiError(
        422,
        'missing_capability',
        `The selected ${role} profile is unavailable.`,
      );
    }
  }

  if (config.retriever.mode === 'dense' || config.retriever.mode === 'hybrid') {
    if (!capabilities.denseStore) {
      throw new ApiError(
        422,
        'missing_capability',
        `Retrieval mode "${config.retriever.mode}" requires Qdrant (QDRANT_URL).`,
      );
    }
    const embed = resolveRole('embedding', config.embedding.model);
    if (!embed?.capabilities.embeddings) {
      throw new ApiError(
        422,
        'missing_capability',
        `Retrieval mode "${config.retriever.mode}" requires a configured embedding profile.`,
      );
    }
  }

  if (config.reranker.enabled) {
    const reranker = resolveRole('rerank', config.reranker.model);
    if (!reranker?.capabilities.rerank) {
      throw new ApiError(
        422,
        'missing_capability',
        'Reranking requires a configured HTTP reranker profile.',
      );
    }
  }
}

export class ProviderRegistry {
  private readonly profiles: ResolvedProviderProfile[];
  private readonly timeoutMs: number;
  private readonly embedBatchSize: number;
  private readonly transports: ProviderTransports;
  private readonly chatCache = new Map<string, ChatProvider>();
  private readonly embedCache = new Map<string, EmbeddingProvider>();
  private readonly rerankCache = new Map<string, RerankProvider>();

  constructor(config: Config, transports: ProviderTransports = {}) {
    this.profiles = config.providerProfiles;
    this.timeoutMs = config.env.PROVIDER_TIMEOUT_MS;
    this.embedBatchSize = config.env.EMBED_BATCH_SIZE;
    this.transports = transports;
  }

  findProfile(role: Role, requestedModel?: string) {
    const model = requestedModel?.trim() || '';
    return this.profiles.find(
      (p) => p.role === role && (!model || p.model === model),
    );
  }

  resolveChat(
    role: 'chat' | 'judge',
    requestedModel?: string,
  ): { profile: ResolvedProviderProfile; provider: ChatProvider } {
    const found = this.findProfile(role, requestedModel);
    if (!found?.capabilities.chat) {
      throw new ProviderError(
        'missing_capability',
        `Configure a ${role} profile before running ${role} operations.`,
      );
    }
    const key = `${found.role}:${found.provider}:${found.model}`;
    let provider = this.chatCache.get(key);
    if (!provider) {
      if (found.provider === 'anthropic') {
        if (!found.apiKey) {
          throw new ProviderError(
            'missing_capability',
            'Anthropic API key is missing.',
          );
        }
        provider = new AnthropicProvider({
          capabilities: found.capabilities,
          apiKey: found.apiKey,
          baseURL: found.baseURL,
          defaultTimeoutMs: this.timeoutMs,
          fetch: this.transports.anthropic,
        });
      } else if (
        found.provider === 'openai' ||
        found.provider === 'openai-compatible'
      ) {
        provider = new OpenAIProvider({
          kind: found.provider,
          capabilities: found.capabilities,
          apiKey: found.apiKey,
          baseURL: found.baseURL,
          defaultTimeoutMs: this.timeoutMs,
          fetch:
            found.provider === 'openai'
              ? this.transports.openai
              : this.transports.openaiCompatible,
        });
      } else {
        throw new ProviderError(
          'missing_capability',
          `Unsupported chat provider "${found.provider}".`,
        );
      }
      this.chatCache.set(key, provider);
    }
    return { profile: found, provider };
  }

  resolveEmbedding(requestedModel?: string): {
    profile: ResolvedProviderProfile;
    provider: EmbeddingProvider;
  } {
    const found = this.findProfile('embedding', requestedModel);
    if (
      !found?.capabilities.embeddings ||
      (found.provider !== 'openai' && found.provider !== 'openai-compatible')
    ) {
      throw new ProviderError(
        'missing_capability',
        'Configure an embedding profile before indexing or searching dense vectors.',
      );
    }
    const key = `${found.provider}:${found.model}`;
    let provider = this.embedCache.get(key);
    if (!provider) {
      provider = new OpenAIProvider({
        kind: found.provider,
        capabilities: found.capabilities,
        apiKey: found.apiKey,
        baseURL: found.baseURL,
        defaultTimeoutMs: this.timeoutMs,
        defaultBatchSize: this.embedBatchSize,
        expectedDimensions: found.expectedDimensions,
        fetch:
          found.provider === 'openai'
            ? this.transports.openai
            : this.transports.openaiCompatible,
      });
      this.embedCache.set(key, provider);
    }
    return { profile: found, provider };
  }

  resolveReranker(requestedModel?: string): {
    profile: ResolvedProviderProfile;
    provider: RerankProvider;
  } {
    const found = this.findProfile('rerank', requestedModel);
    if (
      !found?.capabilities.rerank ||
      found.provider !== 'http' ||
      !found.baseURL
    ) {
      throw new ProviderError(
        'missing_capability',
        'Configure an HTTP reranker profile before enabling reranking.',
      );
    }
    const key = `${found.model}:${found.baseURL}`;
    let provider = this.rerankCache.get(key);
    if (!provider) {
      provider = new HttpRerankProvider({
        baseURL: found.baseURL,
        apiKey: found.apiKey,
        defaultTimeoutMs: this.timeoutMs,
        fetch: this.transports.rerank,
      });
      this.rerankCache.set(key, provider);
    }
    return { profile: found, provider };
  }
}
