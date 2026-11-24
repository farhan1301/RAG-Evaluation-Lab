import { expect, it } from 'vitest';
import {
  chunkDocumentWithConfig,
  summarizeChunkGroups,
} from '../frontend/src/lib/chunking';
import type { ChunkingStrategy } from '../frontend/src/types/pipeline';

function chunk(strategy: ChunkingStrategy, content: string) {
  return chunkDocumentWithConfig(
    { id: 'doc', content },
    { strategy, chunkSize: 50, overlap: 5 },
  );
}

it('preserves character-window overlap, document identity and chunk statistics', () => {
  const input = '0123456789'.repeat(8);
  const group = chunk('recursive', input);
  expect(group.chunks.map((item) => item.content)).toEqual([
    input.slice(0, 50),
    input.slice(45),
  ]);
  expect(group.chunks[1]).toMatchObject({
    documentId: 'doc',
    index: 1,
    charCount: 35,
    tokenEstimate: 9,
  });
  expect(summarizeChunkGroups([group])).toEqual({
    totalChunks: 2,
    averageChars: 43,
    averageTokens: 11,
    maxChunkSize: 50,
    minChunkSize: 35,
  });
});

it.each([
  [
    'semantic',
    'First sentence ends here. Second sentence. Third sentence ends here.',
    ['First sentence ends here. Second sentence.', 'Third sentence ends here.'],
  ],
  [
    'layout',
    '# One\r\nfirst\r\n# Two\r\nsecond',
    ['# One\nfirst', '# Two\nsecond'],
  ],
  [
    'table',
    'Above\n| A | B |\n| 1 | 2 |\nBelow',
    ['Above', '| A | B |\n| 1 | 2 |', 'Below'],
  ],
  ['recursive', ' \r\n ', []],
] as const)(
  'characterizes %s chunk boundaries',
  (strategy, input, expected) => {
    expect(chunk(strategy, input).chunks.map((item) => item.content)).toEqual(
      expected,
    );
  },
);
