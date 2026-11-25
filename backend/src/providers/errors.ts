import { ApiError } from '../errors.js';

export type ProviderErrorCode =
  | 'missing_capability'
  | 'invalid_input'
  | 'timeout'
  | 'upstream_failure'
  | 'dimension_mismatch'
  | 'malformed_response'
  | 'partial_batch';

export interface ProviderErrorOptions {
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }

  toApiError(): ApiError {
    if (this.code === 'missing_capability')
      return new ApiError(422, 'missing_capability', this.message);
    if (this.code === 'invalid_input')
      return new ApiError(400, 'invalid_input', this.message);
    if (this.code === 'timeout')
      return new ApiError(504, 'upstream_failure', this.message);
    return new ApiError(502, 'upstream_failure', this.message);
  }
}

export function parseRetryAfterMs(header: string | null | undefined) {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return Math.max(0, parsed - Date.now());
  return undefined;
}

export function isAbortOrTimeout(err: unknown) {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'AbortError' ||
    err.name === 'TimeoutError' ||
    err.name === 'APIConnectionTimeoutError' ||
    err.name === 'APIUserAbortError'
  );
}
