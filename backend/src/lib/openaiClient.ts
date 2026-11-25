import fetch from 'node-fetch';
import { supportsTemperature } from '../config/modelOptions.js';
import type { AppConfig } from './config.js';

export interface EmbeddingResponse {
  vectors: number[][];
}

export interface ChatResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?:
    | { type: 'json_object' }
    | { type: 'json_schema'; json_schema: unknown };
}

export class OpenAIClient {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async createEmbeddings(
    inputs: string[],
    options: { model?: string; signal?: AbortSignal } = {}
  ): Promise<EmbeddingResponse> {
    if (!inputs.length) {
      return { vectors: [] };
    }

    const targetModel = options.model?.trim() || this.config.openaiEmbeddingModel;

    const local = targetModel === this.config.localEmbedModel;
    const baseUrl = local ? this.config.localEmbedBaseUrl : 'https://api.openai.com/v1';
    if (!baseUrl) throw new Error('Embedding endpoint is unavailable.');
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(!local && { Authorization: `Bearer ${this.config.openaiApiKey}` }),
      },
      body: JSON.stringify({
        model: targetModel,
        input: inputs,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI embeddings failed (${response.status}): ${detail}`);
    }

    const payload: any = await response.json();
    const vectors = Array.isArray(payload?.data)
      ? payload.data.map((item: any) => item?.embedding).filter(Array.isArray)
      : [];

    if (!vectors.length) {
      throw new Error('OpenAI embedding response did not include vectors.');
    }

    return { vectors };
  }

  async chatCompletion(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options: ChatCompletionOptions = {},
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const { model, temperature, maxTokens, responseFormat } = options;

    const resolvedModel = (model ?? this.config.openaiChatModel).trim();
    const body: Record<string, unknown> = {
      model: resolvedModel,
      messages,
      ...(typeof maxTokens === 'number' ? { [resolvedModel.toLowerCase().startsWith('gpt-5') ? 'max_completion_tokens' : 'max_tokens']: maxTokens } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };

    if (supportsTemperature(resolvedModel)) {
      body.temperature = typeof temperature === 'number' ? temperature : 0.2;
    } else if (typeof temperature === 'number' && temperature === 1) {
      body.temperature = 1;
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI chat completion failed (${response.status}): ${detail}`);
    }

    const payload: any = await response.json();
    const content = payload?.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('OpenAI chat completion returned empty content.');
    }

    const usage = payload?.usage;

    return {
      content,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            totalTokens: usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
}
