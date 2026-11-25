import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Express } from 'express';

// Drive the real middleware, body parser and router using Node HTTP streams without a listener.
export function send(
  app: Express,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  raw?: string | Buffer,
) {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  const data = raw ?? JSON.stringify(body);
  req.headers = {
    host: 'localhost',
    ...(data !== undefined && {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(data)),
    }),
    ...headers,
  };
  if (data !== undefined) req.push(Buffer.from(data));
  req.push(null);
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  res.write = ((
    chunk: unknown,
    encoding?: BufferEncoding | (() => void),
    cb?: () => void,
  ) => {
    if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(
              String(chunk),
              typeof encoding === 'string' ? encoding : 'utf8',
            ),
      );
    }
    const callback = typeof encoding === 'function' ? encoding : cb;
    callback?.();
    return true;
  }) as typeof res.write;
  return new Promise<{
    status: number;
    headers: ReturnType<typeof res.getHeaders>;
    body: unknown;
  }>((resolve, reject) => {
    res.end = ((
      chunk?: Buffer | string | (() => void),
      encoding?: BufferEncoding | (() => void),
      cb?: () => void,
    ) => {
      if (
        chunk !== undefined &&
        chunk !== null &&
        typeof chunk !== 'function'
      ) {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(
                String(chunk),
                typeof encoding === 'string' ? encoding : 'utf8',
              ),
        );
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const contentType = String(res.getHeader('content-type') ?? '');
      try {
        const body = !text
          ? undefined
          : contentType.includes('application/json') || !contentType
            ? JSON.parse(text)
            : text;
        resolve({
          status: res.statusCode,
          headers: res.getHeaders(),
          body,
        });
      } catch (err) {
        reject(err);
      }
      const callback =
        typeof chunk === 'function'
          ? chunk
          : typeof encoding === 'function'
            ? encoding
            : cb;
      callback?.();
      res.emit('finish');
      res.emit('close');
      socket.destroy();
      return res;
    }) as typeof res.end;
    app(req, res);
  });
}
