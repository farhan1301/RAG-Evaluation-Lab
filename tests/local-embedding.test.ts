import { expect, it, vi } from 'vitest';
import { readConfig } from '../backend/src/config/env';
import { OpenAIClient } from '../backend/src/lib/openaiClient';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('node-fetch', () => ({ default: transport }));
it('uses the configured local embeddings operation without sending the cloud key', async () => {
  const config = readConfig({
    LOCAL_EMBED_MODEL: 'fixture-local',
    LOCAL_EMBED_BASE_URL: 'http://local.invalid/v1/',
    OPENAI_API_KEY: 'cloud-secret',
  });
  const client = new OpenAIClient(config.legacy);
  transport.mockResolvedValue(
    Response.json({ data: [{ index: 0, embedding: [0.25, 0.75] }] }),
  );
  await expect(client.createEmbeddings(['fixture'])).resolves.toEqual({
    vectors: [[0.25, 0.75]],
  });
  expect(transport).toHaveBeenCalledWith(
    'http://local.invalid/v1/embeddings',
    expect.objectContaining({
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fixture-local', input: ['fixture'] }),
    }),
  );
});
