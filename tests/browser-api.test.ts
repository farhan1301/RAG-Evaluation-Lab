import { afterEach, expect, it, vi } from 'vitest';
import {
  answerQuestion,
  judgeAnswers,
  parseDocument,
  searchMatches,
  upsertChunks,
} from '../frontend/src/lib/backend';

afterEach(() => vi.unstubAllGlobals());

it('posts runner requests relative to the current origin', async () => {
  const transport = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', transport);
  const question = { pipelineId: 'baseline', question: 'Why?' };
  const calls = [
    [
      parseDocument({ filename: 'fixture.txt', contentBase64: 'dGVzdA==' }),
      'parse',
    ],
    [upsertChunks({ pipelineId: 'baseline', chunks: [] }), 'chunks'],
    [searchMatches(question), 'search'],
    [answerQuestion(question), 'answer'],
    [judgeAnswers({ pipelineId: 'baseline', evaluations: [] }), 'judge'],
  ] as const;
  for (const [result, endpoint] of calls) {
    await result;
    expect(transport).toHaveBeenCalledWith(
      `/api/${endpoint}`,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  expect(transport).toHaveBeenCalledWith(
    '/api/answer',
    expect.objectContaining({ body: JSON.stringify(question) }),
  );
});

it('surfaces API errors and the HTTP status on proxy failures', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'Missing question' }, { status: 400 }),
      )
      .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 })),
  );
  const question = { pipelineId: 'baseline', question: '' };
  await expect(answerQuestion(question)).rejects.toThrow('Missing question');
  await expect(answerQuestion(question)).rejects.toThrow('502');
});
