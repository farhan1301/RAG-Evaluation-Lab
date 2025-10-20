import type { Request, Response } from 'express';
import type { LlamaParseClient } from '../lib/llamaParseClient.js';

interface ParseRequestBody {
  filename: string;
  mimeType?: string;
  contentBase64: string;
}

export const createParseHandler = (llamaParse: LlamaParseClient) =>
  async (req: Request<unknown, unknown, ParseRequestBody>, res: Response) => {
    if (!llamaParse.isConfigured()) {
      return res.status(503).json({
        error: 'Document parsing is not configured. Set LLAMA_CLOUD_API_KEY to enable LlamaParse.',
      });
    }

    const { filename, mimeType, contentBase64 } = req.body ?? {};

    if (!filename || !filename.trim() || !contentBase64 || !contentBase64.trim()) {
      return res
        .status(400)
        .json({ error: 'filename and contentBase64 are required to parse a document.' });
    }

    let buffer: Buffer;

    try {
      buffer = Buffer.from(contentBase64, 'base64');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to decode contentBase64 payload.';
      return res.status(400).json({ error: `Invalid base64 payload: ${message}` });
    }

    try {
      const parsed = await llamaParse.parseDocument({
        buffer,
        filename: filename.trim(),
        mimeType: mimeType?.trim(),
      });

      res.json({
        text: parsed.text,
        pageCount: parsed.pageCount,
        jobId: parsed.jobId,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected error during document parsing.';
      res.status(502).json({ error: message });
    }
  };
