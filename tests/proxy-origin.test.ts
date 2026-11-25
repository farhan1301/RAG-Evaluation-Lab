import { EventEmitter } from 'node:events';
import type { ProxyOptions } from 'vite';
import { expect, it } from 'vitest';
import config from '../frontend/vite.config';

it('presents the backend Host and Origin together for browser writes through the Vite proxy', () => {
  const options = config.server?.proxy?.['/api'] as ProxyOptions;
  expect(options.changeOrigin).toBe(true);
  const origin = new URL(String(options.target)).origin;
  const proxy = new EventEmitter();
  options.configure?.(
    proxy as Parameters<NonNullable<ProxyOptions['configure']>>[0],
    options,
  );
  const browser = new Headers({ origin: 'http://127.0.0.1:3000' });
  proxy.emit('proxyReq', {
    getHeader: (key: string) => browser.get(key),
    setHeader: (key: string, value: string) => browser.set(key, value),
  });
  expect(browser.get('origin')).toBe(origin);
});
