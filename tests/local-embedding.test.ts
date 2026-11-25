import { expect, it, vi } from 'vitest';
import { readConfig } from '../backend/src/config/env';
import { ProviderRegistry } from '../backend/src/providers/registry';

it('uses the configured local embeddings operation without sending the cloud key', async () => {
  const config = readConfig({
    LOCAL_EMBED_MODEL: 'fixture-local',
    LOCAL_EMBED_BASE_URL: 'http://local.invalid/v1/',
    OPENAI_API_KEY: 'cloud-secret',
  });
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({
      object: 'list',
      model: 'fixture-local',
      data: [{ object: 'embedding', index: 0, embedding: [0.25, 0.75] }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }),
  );
  const registry = new ProviderRegistry(config, {
    openaiCompatible: transport,
  });
  const { profile, provider } = registry.resolveEmbedding('fixture-local');
  expect(profile.provider).toBe('openai-compatible');

  const result = await provider.embed({
    model: profile.model,
    inputs: ['fixture'],
  });
  expect(result).toMatchObject({
    vectors: [[0.25, 0.75]],
    dimensions: 2,
    model: 'fixture-local',
    provider: 'openai-compatible',
    usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 },
  });

  expect(transport).toHaveBeenCalledTimes(1);
  const [url, init] = transport.mock.calls[0];
  expect(String(url)).toBe('http://local.invalid/v1/embeddings');
  const headers = new Headers(init?.headers);
  expect(headers.get('authorization')).toBeNull();
  expect(JSON.parse(String(init?.body))).toEqual({
    model: 'fixture-local',
    input: ['fixture'],
    encoding_format: 'float',
  });
});
