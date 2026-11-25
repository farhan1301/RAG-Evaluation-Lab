import { EventEmitter } from 'node:events';
import type { ProxyOptions } from 'vite';
import { expect, it } from 'vitest';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Pipelines } from '../backend/src/db/pipelines';
import { createApp } from '../backend/src/http/app';
import { createLogger } from '../backend/src/lib/logger';
import config, { resolveProxyOrigin } from '../frontend/vite.config';
import { send } from './inProcess';

function emitProxyOrigin(incomingOrigin?: string) {
  const options = config.server?.proxy?.['/api'] as ProxyOptions;
  const proxy = new EventEmitter();
  options.configure?.(
    proxy as Parameters<NonNullable<ProxyOptions['configure']>>[0],
    options,
  );
  const headers = new Headers(
    incomingOrigin ? { origin: incomingOrigin } : undefined,
  );
  proxy.emit('proxyReq', {
    getHeader: (key: string) => headers.get(key) ?? undefined,
    setHeader: (key: string, value: string) => headers.set(key, value),
  });
  return {
    targetOrigin: new URL(String(options.target)).origin,
    forwardedOrigin: headers.get('origin'),
    changeOrigin: options.changeOrigin,
  };
}

it('presents the backend Host and Origin together for browser writes through the Vite proxy', () => {
  const loopback = emitProxyOrigin('http://127.0.0.1:3000');
  expect(loopback.changeOrigin).toBe(true);
  expect(loopback.forwardedOrigin).toBe(loopback.targetOrigin);

  const localhost = emitProxyOrigin('http://localhost:3000');
  expect(localhost.forwardedOrigin).toBe(localhost.targetOrigin);

  // Pure helper unit assertions across custom host/port/target combinations.
  expect(
    resolveProxyOrigin('http://localhost:5173', {
      host: '127.0.0.1',
      port: 5173,
      target: 'http://127.0.0.1:8080/prefix',
    }),
  ).toBe('http://127.0.0.1:8080');
  expect(
    resolveProxyOrigin('https://attacker.example', {
      host: '127.0.0.1',
      port: 5173,
      target: 'http://127.0.0.1:8080',
    }),
  ).toBe('https://attacker.example');
  expect(resolveProxyOrigin(undefined)).toBeUndefined();
});

it('preserves foreign and mismatched origins on the Vite proxy so Express denies them', async () => {
  for (const foreign of [
    'https://evil.example',
    'http://127.0.0.1:3001',
    'http://localhost:3001',
    'http://127.0.0.1:3000.evil.example',
    'https://127.0.0.1:3000',
  ]) {
    const result = emitProxyOrigin(foreign);
    expect(result.forwardedOrigin, `origin ${foreign}`).toBe(foreign);
  }

  const missing = emitProxyOrigin(undefined);
  expect(missing.forwardedOrigin).toBeNull();

  // Prove a foreign-origin bodyless POST forwarded by the proxy is denied by Express.
  const { forwardedOrigin, targetOrigin } = emitProxyOrigin(
    'https://evil.example',
  );
  const db = openDatabase(':memory:');
  try {
    const app = createApp({
      config: readConfig({}),
      datasets: new Datasets(db),
      pipelines: new Pipelines(db),
      logger: createLogger({ write: () => {} }),
      ready: () => true,
    });
    const res = await send(app, 'POST', '/api/v1/datasets/sample', undefined, {
      host: new URL(targetOrigin).host,
      ...(forwardedOrigin ? { origin: forwardedOrigin } : {}),
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'origin_denied' } });
  } finally {
    db.close();
  }
});
