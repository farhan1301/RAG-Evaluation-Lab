import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../backend/src/config/env';
import {
  buildBoundedContext,
  generateGroundedAnswer,
  validateCitations,
} from '../backend/src/providers/answer';
import { AnthropicProvider } from '../backend/src/providers/anthropic';
import { ProviderError } from '../backend/src/providers/errors';
import { ProviderRegistry } from '../backend/src/providers/registry';
import { HttpRerankProvider } from '../backend/src/providers/reranker';

const chunkA = '11111111-1111-4111-8111-111111111111';
const chunkB = '22222222-2222-4222-8222-222222222222';
const docA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('OpenAI provider adapter', () => {
  it('supports bounded batching, index reordering, usage totals, and request IDs', async () => {
    const config = readConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_EMBED_MODEL: 'fixture-embed',
      OPENAI_EMBED_DIMENSIONS: '3',
      EMBED_BATCH_SIZE: '2',
    });
    const calls: string[][] = [];
    let batchNum = 0;
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      batchNum += 1;
      const parsed = JSON.parse(String(init?.body)) as { input: string[] };
      calls.push(parsed.input);
      // Return batch items in reverse order to verify index reordering.
      const data = parsed.input
        .map((text, idx) => ({
          object: 'embedding',
          index: idx,
          embedding: [text.length, batchNum, idx],
        }))
        .reverse();
      return new Response(
        JSON.stringify({
          object: 'list',
          model: 'fixture-embed',
          data,
          usage: {
            prompt_tokens: parsed.input.length * 4,
            total_tokens: parsed.input.length * 4,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': `req-batch-${batchNum}`,
          },
        },
      );
    });

    const registry = new ProviderRegistry(config, { openai: transport });
    const { profile, provider } = registry.resolveEmbedding();
    const res = await provider.embed({
      model: profile.model,
      inputs: ['a', 'bb', 'ccc', 'dddd', 'eeeee'],
      expectedDimensions: profile.expectedDimensions,
    });

    expect(calls).toEqual([['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
    expect(res.dimensions).toBe(3);
    expect(res.vectors).toEqual([
      [1, 1, 0],
      [2, 1, 1],
      [3, 2, 0],
      [4, 2, 1],
      [5, 3, 0],
    ]);
    expect(res.requestIds).toEqual([
      'req-batch-1',
      'req-batch-2',
      'req-batch-3',
    ]);
    expect(res.usage).toEqual({
      inputTokens: 20,
      outputTokens: 0,
      totalTokens: 20,
    });
  });

  it('rejects dimensionality mismatch against expected dimensions and across batches', async () => {
    const config = readConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_EMBED_MODEL: 'fixture-embed',
      OPENAI_EMBED_DIMENSIONS: '4',
    });
    const wrongDim = new ProviderRegistry(config, {
      openai: async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            model: 'fixture-embed',
            data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
            usage: { prompt_tokens: 11, total_tokens: 11 },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'req-wrong-dim',
            },
          },
        ),
    });
    await expect(
      wrongDim.resolveEmbedding().provider.embed({
        model: 'fixture-embed',
        inputs: ['hello'],
        expectedDimensions: 4,
      }),
    ).rejects.toMatchObject({
      code: 'dimension_mismatch',
      callMeta: {
        requestId: 'req-wrong-dim',
        usage: { inputTokens: 11, outputTokens: 0, totalTokens: 11 },
      },
    });

    const configNoPin = readConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_EMBED_MODEL: 'fixture-embed',
      EMBED_BATCH_SIZE: '1',
    });
    let call = 0;
    const inconsistent = new ProviderRegistry(configNoPin, {
      openai: async () => {
        call += 1;
        return Response.json({
          object: 'list',
          model: 'fixture-embed',
          data: [
            {
              object: 'embedding',
              index: 0,
              embedding: call === 1 ? [1, 2, 3] : [1, 2],
            },
          ],
        });
      },
    });
    await expect(
      inconsistent.resolveEmbedding().provider.embed({
        model: 'fixture-embed',
        inputs: ['first', 'second'],
      }),
    ).rejects.toMatchObject({ code: 'dimension_mismatch' });
  });

  it('rejects partial embedding batches, duplicate indices, and malformed vectors', async () => {
    const config = readConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_EMBED_MODEL: 'fixture-embed',
    });
    const partial = new ProviderRegistry(config, {
      openai: async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            model: 'fixture-embed',
            data: [{ object: 'embedding', index: 0, embedding: [0.5, 0.5] }],
            usage: { prompt_tokens: 7, total_tokens: 7 },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'req-partial-batch',
            },
          },
        ),
    });
    await expect(
      partial.resolveEmbedding().provider.embed({
        model: 'fixture-embed',
        inputs: ['one', 'two'],
      }),
    ).rejects.toMatchObject({
      code: 'partial_batch',
      callMeta: {
        requestId: 'req-partial-batch',
        usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
      },
    });

    const duplicateIdx = new ProviderRegistry(config, {
      openai: async () =>
        Response.json({
          object: 'list',
          model: 'fixture-embed',
          data: [
            { object: 'embedding', index: 0, embedding: [0.5, 0.5] },
            { object: 'embedding', index: 0, embedding: [0.2, 0.8] },
          ],
        }),
    });
    await expect(
      duplicateIdx.resolveEmbedding().provider.embed({
        model: 'fixture-embed',
        inputs: ['one', 'two'],
      }),
    ).rejects.toMatchObject({ code: 'partial_batch' });

    const malformed = new ProviderRegistry(config, {
      openai: async () =>
        Response.json({
          object: 'list',
          model: 'fixture-embed',
          data: [{ object: 'embedding', index: 0, embedding: [] }],
        }),
    });
    await expect(
      malformed.resolveEmbedding().provider.embed({
        model: 'fixture-embed',
        inputs: ['one'],
      }),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('maps OpenAI capability differences, max_completion_tokens, structured output, timeouts, and Retry-After', async () => {
    const bodies: Record<string, unknown>[] = [];
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-5-mini',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"ok":true}' },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 5,
            total_tokens: 17,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'req-openai-chat',
          },
        },
      );
    });

    const fixedTempConfig = readConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_CHAT_MODEL: 'gpt-5-mini',
    });
    const fixedRegistry = new ProviderRegistry(fixedTempConfig, {
      openai: transport,
    });
    const { profile, provider } = fixedRegistry.resolveChat('chat');
    expect(profile.capabilities).toMatchObject({
      chat: true,
      embeddings: false,
      structuredOutput: true,
      temperature: false,
      maxTemperature: null,
      maxTokens: true,
      requiresMaxTokens: false,
    });

    await expect(
      provider.chat({
        model: profile.model,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.2,
      }),
    ).rejects.toMatchObject({ code: 'missing_capability' });
    expect(transport).not.toHaveBeenCalled();

    const chatRes = await provider.chat({
      model: profile.model,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      maxTokens: 256,
      responseFormat: {
        type: 'json_schema',
        name: 'probe',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    });
    expect(chatRes).toMatchObject({
      content: '{"ok":true}',
      provider: 'openai',
      requestId: 'req-openai-chat',
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        cacheReadTokens: 4,
      },
      effectiveParams: { maxTokens: 256, structuredOutput: true },
    });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]).toMatchObject({
      max_completion_tokens: 256,
      response_format: { type: 'json_schema' },
    });

    const timeoutRegistry = new ProviderRegistry(fixedTempConfig, {
      openai: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        }),
    });
    await expect(
      timeoutRegistry.resolveChat('chat').provider.chat({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: 'slow' }],
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });

    const throttledRegistry = new ProviderRegistry(fixedTempConfig, {
      openai: async () =>
        new Response(JSON.stringify({ error: { message: 'rate limit' } }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '4',
          },
        }),
    });
    await expect(
      throttledRegistry.resolveChat('chat').provider.chat({
        model: 'gpt-5-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({
      code: 'upstream_failure',
      status: 429,
      retryable: true,
      retryAfterMs: 4000,
    });
  });
});

describe('Anthropic provider adapter', () => {
  it('exposes Anthropic capability flags, rejects embeddings, uses output_config structured output, and validates temperature', async () => {
    const config = readConfig({
      ANTHROPIC_API_KEY: 'fixture-anthropic-key',
      ANTHROPIC_CHAT_MODEL: 'claude-sonnet-5-5',
      LOCAL_EMBED_BASE_URL: 'http://local.invalid/v1',
      LOCAL_EMBED_MODEL: 'local-embed',
    });
    const bodies: Record<string, unknown>[] = [];
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: '{"answer":"yes"}' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 18,
            output_tokens: 7,
            cache_read_input_tokens: 6,
            cache_creation_input_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'request-id': 'req-anthropic-1',
          },
        },
      );
    });

    const registry = new ProviderRegistry(config, { anthropic: transport });
    const { profile, provider } = registry.resolveChat('chat');
    expect(profile.provider).toBe('anthropic');
    expect(profile.capabilities).toEqual({
      chat: true,
      embeddings: false,
      rerank: false,
      structuredOutput: true,
      temperature: false,
      maxTemperature: null,
      maxTokens: true,
      requiresMaxTokens: true,
    });
    // An Anthropic chat pipeline can pair with a local embedding profile.
    expect(registry.resolveEmbedding().profile.provider).toBe(
      'openai-compatible',
    );
    expect(
      () =>
        new AnthropicProvider({
          apiKey: 'k',
          capabilities: { ...profile.capabilities, embeddings: true },
        }),
    ).toThrow(ProviderError);

    // Default Anthropic profile in SDK 1.13 rejects non-default temperature.
    await expect(
      provider.chat({
        model: profile.model,
        messages: [{ role: 'user', content: 'Question' }],
        temperature: 0.3,
        maxTokens: 200,
      }),
    ).rejects.toMatchObject({ code: 'missing_capability' });

    const res = await provider.chat({
      model: profile.model,
      messages: [
        { role: 'system', content: 'Be grounded.' },
        { role: 'user', content: 'Answer?' },
      ],
      maxTokens: 300,
      responseFormat: {
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      },
    });
    expect(res).toMatchObject({
      content: '{"answer":"yes"}',
      provider: 'anthropic',
      requestId: 'req-anthropic-1',
      usage: {
        inputTokens: 18,
        outputTokens: 7,
        totalTokens: 25,
        cacheReadTokens: 6,
        cacheCreationTokens: 2,
      },
      effectiveParams: { maxTokens: 300, structuredOutput: true },
    });
    expect(bodies[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: 'Be grounded.',
      max_tokens: 300,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
          },
        },
      },
    });
    expect(bodies[0]).not.toHaveProperty('temperature');

    // Explicit temperature opt-in enforces Anthropic's maxTemperature of 1.
    const tempConfig = readConfig({
      ANTHROPIC_API_KEY: 'fixture-anthropic-key',
      ANTHROPIC_CHAT_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_CHAT_SUPPORTS_TEMPERATURE: 'true',
    });
    const tempRegistry = new ProviderRegistry(tempConfig, {
      anthropic: transport,
    });
    const tempChat = tempRegistry.resolveChat('chat');
    expect(tempChat.profile.capabilities.maxTemperature).toBe(1);
    await expect(
      tempChat.provider.chat({
        model: tempChat.profile.model,
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 1.5,
        maxTokens: 100,
      }),
    ).rejects.toMatchObject({ code: 'missing_capability' });
    await tempChat.provider.chat({
      model: tempChat.profile.model,
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0.7,
      maxTokens: 100,
    });
    expect(bodies[1]).toMatchObject({ temperature: 0.7, max_tokens: 100 });

    // Timeout mapping for Anthropic.
    const slowRegistry = new ProviderRegistry(config, {
      anthropic: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('timeout');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        }),
    });
    await expect(
      slowRegistry.resolveChat('chat').provider.chat({
        model: 'claude-sonnet-5-5',
        messages: [{ role: 'user', content: 'slow' }],
        maxTokens: 100,
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});

describe('OpenAI-compatible (local) capability differences', () => {
  it('omits auth headers and response_format when unconfigured, and respects capability flags', async () => {
    const config = readConfig({
      LOCAL_CHAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      LOCAL_CHAT_MODEL: 'local-llama',
      LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT: 'false',
      LOCAL_CHAT_SUPPORTS_TEMPERATURE: 'true',
    });
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const registry = new ProviderRegistry(config, {
      openaiCompatible: async (_url, init) => {
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return Response.json({
          id: 'local-1',
          object: 'chat.completion',
          created: 1,
          model: 'local-llama',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content:
                  '{"answer":"Local answer","citations":[],"abstained":false}',
              },
            },
          ],
        });
      },
    });
    const { profile, provider } = registry.resolveChat('chat');
    expect(profile.provider).toBe('openai-compatible');
    expect(profile.capabilities.structuredOutput).toBe(false);
    expect(profile.capabilities.temperature).toBe(true);

    const res = await provider.chat({
      model: profile.model,
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.4,
      maxTokens: 150,
      responseFormat: {
        type: 'json_schema',
        name: 'grounded',
        schema: { type: 'object' },
      },
    });
    expect(capturedHeaders?.get('authorization')).toBeNull();
    expect(capturedBody).not.toHaveProperty('response_format');
    expect(capturedBody).toMatchObject({ temperature: 0.4, max_tokens: 150 });
    expect(res.effectiveParams).toEqual({
      temperature: 0.4,
      maxTokens: 150,
      structuredOutput: false,
    });
  });
});

describe('HTTP reranker adapter', () => {
  it('returns validated scores and rejects malformed, out-of-range, duplicate, and timed-out outputs', async () => {
    const valid = new HttpRerankProvider({
      baseURL: 'http://rerank.invalid/rerank',
      apiKey: 'secret-rerank',
      fetch: async (url, init) => {
        expect(String(url)).toBe('http://rerank.invalid/rerank');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer secret-rerank',
        );
        return new Response(
          JSON.stringify({
            id: 'rr-1',
            results: [
              { index: 1, relevance_score: 0.91 },
              { index: 0, score: 0.42 },
            ],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'hdr-rr-1',
            },
          },
        );
      },
    });
    await expect(
      valid.rerank({
        model: 'fixture-reranker',
        query: 'q',
        documents: ['doc A', 'doc B'],
        topN: 2,
      }),
    ).resolves.toEqual({
      model: 'fixture-reranker',
      requestId: 'hdr-rr-1',
      results: [
        { index: 1, score: 0.91 },
        { index: 0, score: 0.42 },
      ],
    });

    const malformedPayloads = [
      'not-json',
      JSON.stringify({ wrong: [] }),
      JSON.stringify({ results: [] }),
      JSON.stringify({ results: [{ index: 99, relevance_score: 0.9 }] }),
      JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.8 },
        ],
      }),
      JSON.stringify({ results: [{ index: 0 }] }),
    ];
    for (const payload of malformedPayloads) {
      const bad = new HttpRerankProvider({
        baseURL: 'http://rerank.invalid/rerank',
        fetch: async () =>
          new Response(payload, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      });
      await expect(
        bad.rerank({
          model: 'fixture-reranker',
          query: 'q',
          documents: ['doc A', 'doc B'],
        }),
      ).rejects.toMatchObject({ code: 'malformed_response' });
    }

    const slow = new HttpRerankProvider({
      baseURL: 'http://rerank.invalid/rerank',
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const err = new Error('timed out');
              err.name = 'TimeoutError';
              reject(err);
            },
            { once: true },
          );
        }),
    });
    await expect(
      slow.rerank({
        model: 'fixture-reranker',
        query: 'q',
        documents: ['doc A'],
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });
});

describe('Grounded answer generation, bounded context, citations, and abstention', () => {
  const sampleItems = [
    {
      chunkId: chunkA,
      documentId: docA,
      documentName: 'guide.txt',
      page: 1,
      start: 0,
      end: 180,
      content: 'A'.repeat(180),
    },
    {
      chunkId: chunkB,
      documentId: docA,
      documentName: 'guide.txt',
      page: 2,
      start: 180,
      end: 360,
      content: 'B'.repeat(180),
    },
  ];

  it('bounds recorded context and truncates cleanly within budget', () => {
    const context = buildBoundedContext(sampleItems, {
      contextBudgetChars: 240,
    });
    expect(context).toHaveLength(2);
    expect(context[0]).toMatchObject({
      index: 1,
      chunkId: chunkA,
      truncated: false,
    });
    expect(context[1]).toMatchObject({
      index: 2,
      chunkId: chunkB,
      truncated: true,
    });
    expect(context[1].content).toHaveLength(60);
  });

  it('validates citations against recorded context and rejects invented IDs', async () => {
    const context = buildBoundedContext(sampleItems, {
      contextBudgetChars: 1000,
    });
    expect(
      validateCitations([chunkA, '[2]', 'invented-id', chunkA], context),
    ).toEqual({
      valid: [chunkA, chunkB],
      invalid: ['invented-id'],
    });

    const grounded = await generateGroundedAnswer({
      question: 'What is in the guide?',
      items: sampleItems,
      model: 'fixture-chat',
      provider: {
        kind: 'openai',
        capabilities: {
          chat: true,
          embeddings: false,
          rerank: false,
          structuredOutput: true,
          temperature: true,
          maxTemperature: 2,
          maxTokens: true,
          requiresMaxTokens: false,
        },
        chat: async () => ({
          content: JSON.stringify({
            answer: 'Grounded response.',
            citations: [chunkA, '99999999-9999-4999-8999-999999999999'],
            abstained: false,
          }),
          model: 'fixture-chat',
          provider: 'openai',
          requestId: 'req-ans',
          effectiveParams: { structuredOutput: true },
        }),
      },
    });
    expect(grounded.abstained).toBe(false);
    expect(grounded.citations).toEqual([chunkA]);
    expect(grounded.invalidCitations).toEqual([
      '99999999-9999-4999-8999-999999999999',
    ]);
    expect(grounded.context).toHaveLength(2);
  });

  it('exposes explicit abstention and strips citations when abstaining', async () => {
    const abstained = await generateGroundedAnswer({
      question: 'What is the unstated numeric parameter?',
      items: sampleItems,
      model: 'fixture-chat',
      provider: {
        kind: 'anthropic',
        capabilities: {
          chat: true,
          embeddings: false,
          rerank: false,
          structuredOutput: true,
          temperature: false,
          maxTemperature: null,
          maxTokens: true,
          requiresMaxTokens: true,
        },
        chat: async () => ({
          content: JSON.stringify({
            answer:
              'The provided context does not specify that numeric parameter.',
            citations: [chunkA],
            abstained: true,
          }),
          model: 'fixture-chat',
          provider: 'anthropic',
          requestId: 'req-abs',
          effectiveParams: { maxTokens: 200, structuredOutput: true },
        }),
      },
    });
    expect(abstained.abstained).toBe(true);
    expect(abstained.citations).toEqual([]);
    expect(abstained.invalidCitations).toEqual([chunkA]);
  });

  it('rejects malformed structured output and removes empty-context abstention shortcut in plaintext mode', async () => {
    const structuredCapabilities = {
      chat: true,
      embeddings: false,
      rerank: false,
      structuredOutput: true,
      temperature: true,
      maxTemperature: 2,
      maxTokens: true,
      requiresMaxTokens: false,
    };

    // Malformed structured output ("Mars.") with empty context MUST reject rather than mark abstained=true.
    await expect(
      generateGroundedAnswer({
        question: 'Which planet is fourth from the Sun?',
        items: [],
        model: 'fixture-chat',
        provider: {
          kind: 'openai',
          capabilities: structuredCapabilities,
          chat: async () => ({
            content: 'Mars.',
            model: 'fixture-chat',
            provider: 'openai',
            requestId: 'req-bad-struct-1',
            usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14 },
            effectiveParams: { structuredOutput: true },
          }),
        },
      }),
    ).rejects.toMatchObject({ code: 'malformed_response' });

    // Missing required `citations` field in structured mode MUST reject rather than defaulting to [].
    await expect(
      generateGroundedAnswer({
        question: 'Which planet is fourth from the Sun?',
        items: [],
        model: 'fixture-chat',
        provider: {
          kind: 'openai',
          capabilities: structuredCapabilities,
          chat: async () => ({
            content: JSON.stringify({ answer: 'Mars.', abstained: true }),
            model: 'fixture-chat',
            provider: 'openai',
            requestId: 'req-missing-citations',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            effectiveParams: { structuredOutput: true },
          }),
        },
      }),
    ).rejects.toMatchObject({
      code: 'malformed_response',
      callMeta: {
        requestId: 'req-missing-citations',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    });

    // Invalid JSON schema object under structuredOutput MUST also reject.
    await expect(
      generateGroundedAnswer({
        question: 'Which planet?',
        items: sampleItems,
        model: 'fixture-chat',
        provider: {
          kind: 'openai',
          capabilities: structuredCapabilities,
          chat: async () => ({
            content: JSON.stringify({ wrong: true }),
            model: 'fixture-chat',
            provider: 'openai',
            requestId: 'req-bad-struct-2',
            effectiveParams: { structuredOutput: true },
          }),
        },
      }),
    ).rejects.toMatchObject({ code: 'malformed_response' });

    // Plaintext mode (structuredOutput=false) with empty context MUST NOT treat "Mars." as abstention.
    const plaintextAnswer = await generateGroundedAnswer({
      question: 'Which planet is fourth from the Sun?',
      items: [],
      model: 'local-chat',
      provider: {
        kind: 'openai-compatible',
        capabilities: { ...structuredCapabilities, structuredOutput: false },
        chat: async () => ({
          content: 'Mars.',
          model: 'local-chat',
          provider: 'openai-compatible',
          requestId: 'req-plain-1',
          effectiveParams: { structuredOutput: false },
        }),
      },
    });
    expect(plaintextAnswer.answer).toBe('Mars.');
    expect(plaintextAnswer.abstained).toBe(false);
    expect(plaintextAnswer.citations).toEqual([]);

    // Plaintext mode still recognizes explicit abstention wording.
    const plaintextAbstain = await generateGroundedAnswer({
      question: 'Which planet is fourth from the Sun?',
      items: [],
      model: 'local-chat',
      provider: {
        kind: 'openai-compatible',
        capabilities: { ...structuredCapabilities, structuredOutput: false },
        chat: async () => ({
          content:
            'The provided context does not contain enough information to answer.',
          model: 'local-chat',
          provider: 'openai-compatible',
          requestId: 'req-plain-2',
          effectiveParams: { structuredOutput: false },
        }),
      },
    });
    expect(plaintextAbstain.abstained).toBe(true);
  });

  it('omits aggregate embedding usage when any HTTP batch omits usage', async () => {
    const config = readConfig({
      OPENAI_API_KEY: 'fixture-key',
      OPENAI_EMBED_MODEL: 'fixture-embed',
      EMBED_BATCH_SIZE: '2',
    });
    let batchNum = 0;
    const registry = new ProviderRegistry(config, {
      openai: async (_url, init) => {
        batchNum += 1;
        const parsed = JSON.parse(String(init?.body)) as { input: string[] };
        return Response.json({
          object: 'list',
          model: 'fixture-embed',
          data: parsed.input.map((_t, idx) => ({
            object: 'embedding',
            index: idx,
            embedding: [0.1, 0.2, 0.3],
          })),
          ...(batchNum === 1
            ? { usage: { prompt_tokens: 8, total_tokens: 8 } }
            : {}),
        });
      },
    });
    const res = await registry.resolveEmbedding().provider.embed({
      model: 'fixture-embed',
      inputs: ['one', 'two', 'three'],
    });
    expect(res.vectors).toHaveLength(3);
    expect(res.usage).toBeUndefined();
  });
});
