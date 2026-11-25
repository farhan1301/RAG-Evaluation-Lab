import { expect, it } from 'vitest';
import {
  chunkArtifact,
  type ChunkOptions,
} from '../backend/src/ingestion/chunks';
import { fromPages } from '../backend/src/ingestion/local';
import { legacyStrategies } from '@rag-eval/contracts';
import { summarizeChunkGroups } from '../frontend/src/lib/chunking';

function chunk(
  strategy: ChunkOptions['strategy'],
  pages: string[],
  size = 50,
  overlap = 0,
) {
  const artifact = fromPages(pages);
  return [
    ...chunkArtifact('fixture', artifact, {
      strategy,
      chunkSize: size,
      overlap,
    }),
  ];
}
it('preserves character-window overlap and statistics', () => {
  const text = '0123456789'.repeat(8);
  const chunks = chunk('recursive', [text], 50, 5);
  expect(chunks.map((c) => c.content)).toEqual([
    text.slice(0, 50),
    text.slice(45),
  ]);
  expect(
    summarizeChunkGroups([
      {
        documentId: 'doc',
        strategy: 'character-window',
        chunks: chunks.map((c) => ({
          ...c,
          documentId: 'doc',
          index: c.ordinal,
          charCount: c.content.length,
          tokenEstimate: Math.round(c.content.length / 4),
        })),
      },
    ]),
  ).toEqual({
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
] as const)('retains %s structural boundaries', (strategy, text, expected) => {
  expect(chunk(strategy, [text]).map((c) => c.content.trim())).toEqual(
    expected,
  );
});
it.each(Object.entries(legacyStrategies))(
  'reproduces %s IDs, offsets and pages with Unicode, oversized sentences and rows',
  (legacy, strategy) => {
    const page = `# Title\r\n${'😀'.repeat(65)}.\n| A | ${'long'.repeat(45)} |`;
    const pages = [page, page],
      artifact = fromPages(pages);
    const first = chunk(strategy, pages, 21, 4);
    expect(chunk(strategy, pages, 21, 4)).toEqual(first);
    expect(
      chunk(legacy as keyof typeof legacyStrategies, pages, 21, 4),
    ).toEqual(first);
    expect(new Set(first.map((c) => c.id)).size).toBe(first.length);
    for (const c of first) {
      expect(c.id).toMatch(/^.{8}-.{4}-8.{3}-[89ab].{3}-.{12}$/);
      expect(c.content).toBe(artifact.text.slice(c.start, c.end));
      expect(c.content.length).toBeLessThanOrEqual(21);
      expect(c.content).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      expect(c.start).toBeGreaterThanOrEqual(artifact.pages[c.page - 1].start);
      expect(c.end).toBeLessThanOrEqual(artifact.pages[c.page - 1].end);
    }
    for (const p of artifact.pages)
      for (let i = p.start; i < p.end; i++)
        if (artifact.text[i].trim())
          expect(first.some((c) => c.start <= i && i < c.end)).toBe(true);
  },
);
