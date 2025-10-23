import type { Request, Response } from 'express';
import type { LlamaParseClient, LlamaParseResultFormat } from '../lib/llamaParseClient.js';
import { logInfo, logWarn, logError } from '../lib/logger.js';

interface ParseRequestBody {
  filename: string;
  mimeType?: string;
  contentBase64: string;
  outputFormat?: LlamaParseResultFormat;
}

export const createParseHandler = (llamaParse: LlamaParseClient) =>
  async (req: Request<unknown, unknown, ParseRequestBody>, res: Response) => {
    const normalizeFormat = (value: string | undefined): LlamaParseResultFormat =>
      value && value.trim().toLowerCase() === 'text' ? 'text' : 'markdown';

    const { filename, mimeType, contentBase64 } = req.body ?? {};
    const outputFormat = normalizeFormat(req.body?.outputFormat);
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    logInfo('parse-route incoming request', {
      requestId,
      filename,
      mimeType,
      outputFormat,
      contentLength: contentBase64?.length ?? 0,
    });

    if (!llamaParse.isConfigured()) {
      logWarn('parse-route llama parse not configured', { requestId });
      return res.status(503).json({
        error: 'Document parsing is not configured. Set LLAMA_CLOUD_API_KEY to enable LlamaParse.',
      });
    }

    if (!filename || !filename.trim() || !contentBase64 || !contentBase64.trim()) {
      logWarn('parse-route missing required fields', { requestId });
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
      logWarn('parse-route invalid base64 payload', { requestId, error: message });
      return res.status(400).json({ error: `Invalid base64 payload: ${message}` });
    }

    try {
      logInfo('parse-route forwarding to llama parse', {
        requestId,
        filename,
        mimeType,
        outputFormat,
      });

      const parsed = await llamaParse.parseDocument({
        buffer,
        filename: filename.trim(),
        mimeType: mimeType?.trim(),
        outputFormat,
      });

      logInfo('parse-route llama parse succeeded', {
        requestId,
        filename,
        pageCount: parsed.pageCount,
        textLength: parsed.text.length,
        jobId: parsed.jobId,
      });

      res.json({
        text: parsed.text,
        pageCount: parsed.pageCount,
        jobId: parsed.jobId,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected error during document parsing.';
      logError('parse-route parsing failed', { requestId, error: message });
      res.status(502).json({ error: message });
    }
  };
