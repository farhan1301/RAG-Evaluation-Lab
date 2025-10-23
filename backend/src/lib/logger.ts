import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.resolve(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const serializeContext = (context?: Record<string, unknown>) => {
  if (!context) {
    return '';
  }

  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ' [unserializable context]';
  }
};

const writeToFile = (level: string, message: string, context?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${serializeContext(context)}\n`;

  fs.appendFile(LOG_FILE, line, (error) => {
    if (error) {
      // Fallback to console error if file append fails.
      console.error('[logger] failed to write log entry', error);
    }
  });
};

const log = (level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>) => {
  const logger = console[level] ?? console.log;
  logger(`[${level}] ${message}`, context ?? '');
  writeToFile(level, message, context);
};

export const logInfo = (message: string, context?: Record<string, unknown>) =>
  log('info', message, context);

export const logWarn = (message: string, context?: Record<string, unknown>) =>
  log('warn', message, context);

export const logError = (message: string, context?: Record<string, unknown>) =>
  log('error', message, context);
