import pino, { type DestinationStream } from 'pino';

export function createLogger(destination?: DestinationStream) {
  return pino(
    {
      redact: {
        paths: [
          'authorization',
          'req.headers.authorization',
          'req.headers.cookie',
          '*.apiKey',
          'apiKey',
          'body',
          'req.body',
          'prompt',
          'text',
          'content',
          'fileBase64',
          'error',
          'err',
        ],
        remove: true,
      },
    },
    destination,
  );
}
const logger = createLogger();
// Legacy parser diagnostics can include upstream bodies. Only forward local counters and IDs.
function log(
  level: 'info' | 'warn' | 'error',
  event: string,
  context?: Record<string, unknown>,
) {
  const { requestId, attempt, pageCount } = context ?? {};
  logger[level]({ requestId, attempt, pageCount }, event);
}
export const logInfo = (event: string, context?: Record<string, unknown>) =>
  log('info', event, context);
export const logWarn = (event: string, context?: Record<string, unknown>) =>
  log('warn', event, context);
export const logError = (event: string, context?: Record<string, unknown>) =>
  log('error', event, context);
