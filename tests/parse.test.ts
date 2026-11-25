import { expect, it } from 'vitest';
import { CloudParser } from '../backend/src/ingestion/cloud';
import { parseLocal } from '../backend/src/ingestion/local';
import { readFileSync } from 'node:fs';

it.each([
  ['Plain markdown.', 'Plain markdown.'],
  [{ markdown: '## Title\r\ntext' }, '## Title\ntext'],
  [{ data: { output: [{ text: 'a' }, { text: 'b' }] } }, 'a\n\nb'],
  [
    { pages: [{ md: 'repeat' }, { md: '' }, { md: 'repeat' }] },
    'repeat\n\n\n\nrepeat',
  ],
])(
  'normalizes provider text, markdown and ordered pages',
  async (payload, expected) => {
    const cloud = new CloudParser('https://fixture.invalid', 'key', async () =>
      typeof payload === 'string'
        ? new Response(payload)
        : Response.json(payload),
    );
    expect(
      (await cloud.download('job', new AbortController().signal)).text,
    ).toBe(expected);
  },
);

it('gives an actionable result for a PDF without extractable text', async () => {
  const original = readFileSync(
    new URL('./fixtures/tiny.pdf', import.meta.url),
    'latin1',
  );
  const empty = Buffer.from(
    original.replace('Offline fixture text.', ' '.repeat(21)),
    'latin1',
  );
  await expect(parseLocal(empty, 'application/pdf')).rejects.toThrow(
    'scanned PDF',
  );
});
