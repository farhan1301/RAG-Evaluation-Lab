import type { ErrorCode } from '@rag-eval/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function missing(): never {
  throw new ApiError(404, 'not_found', 'Resource not found.');
}
