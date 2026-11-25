import type {
  ProviderCapabilities,
  ProviderKind,
  ProviderUsage,
} from '@rag-eval/contracts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ChatResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown> };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ChatResponseFormat;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  provider: ProviderKind;
  requestId: string | null;
  usage?: ProviderUsage;
  effectiveParams: {
    temperature?: number;
    maxTokens?: number;
    structuredOutput: boolean;
  };
}

export interface EmbedRequest {
  model: string;
  inputs: string[];
  expectedDimensions?: number;
  batchSize?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
  dimensions: number;
  model: string;
  provider: 'openai' | 'openai-compatible';
  requestIds: string[];
  usage?: ProviderUsage;
}

export interface RerankRequest {
  model: string;
  query: string;
  documents: string[];
  topN?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RerankScore {
  index: number;
  score: number;
}

export interface RerankResult {
  results: RerankScore[];
  model: string;
  requestId: string | null;
  usage?: ProviderUsage;
}

export interface ChatProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface EmbeddingProvider {
  readonly kind: 'openai' | 'openai-compatible';
  readonly capabilities: ProviderCapabilities;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

export interface RerankProvider {
  readonly kind: 'http';
  readonly capabilities: ProviderCapabilities;
  rerank(request: RerankRequest): Promise<RerankResult>;
}

export type { ProviderCapabilities, ProviderKind, ProviderUsage };
