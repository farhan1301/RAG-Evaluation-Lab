import { expect, it, vi } from 'vitest';
import { createParseHandler } from '../backend/src/routes/parse';
import { invoke } from './handler';

it('sends the decoded fixture to the configured parser and returns its provenance', async () => {
  const result = { text: 'Synthetic page', pageCount: 1, jobId: 'job' };
  const parseDocument = vi.fn().mockResolvedValue(result);
  const buffer = Buffer.from('Synthetic page');
  const handler = createParseHandler({
    isConfigured: () => true,
    parseDocument,
  });
  const response = await invoke(handler, {
    filename: 'sample.txt',
    contentBase64: buffer.toString('base64'),
  });
  expect(parseDocument).toHaveBeenCalledWith({
    buffer,
    filename: 'sample.txt',
    outputFormat: 'markdown',
    mimeType: undefined,
  });
  expect(response.body).toEqual(result);
});
