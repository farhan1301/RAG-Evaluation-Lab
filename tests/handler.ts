import type { Request, Response } from 'express';
import { vi } from 'vitest';

export async function invoke<Body>(
  handler: (
    req: Request<unknown, unknown, Body>,
    res: Response,
  ) => Promise<unknown>,
  body: Body,
) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler(
    { body } as Request<unknown, unknown, Body>,
    res as unknown as Response,
  );
  return {
    status: res.status.mock.calls[0]?.[0] ?? 200,
    body: res.json.mock.calls[0][0],
  };
}
