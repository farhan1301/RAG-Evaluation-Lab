import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const devHost = '127.0.0.1';
const devPort = 3000;
const backendTarget =
  process.env.BACKEND_PROXY_TARGET || 'http://127.0.0.1:7070';

export function resolveProxyOrigin(
  incomingOrigin: string | string[] | number | undefined,
  options: { host?: string; port?: number; target?: string } = {},
): string | undefined {
  if (typeof incomingOrigin !== 'string' || !incomingOrigin) return undefined;
  const host = options.host ?? devHost;
  const port = options.port ?? devPort;
  const target = options.target ?? backendTarget;
  const allowedHosts = new Set([host]);
  if (host === '127.0.0.1' || host === 'localhost') {
    allowedHosts.add('127.0.0.1');
    allowedHosts.add('localhost');
  }
  const allowedOrigins = new Set(
    Array.from(allowedHosts, (h) => {
      const formatted = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
      return `http://${formatted}:${port}`;
    }),
  );
  if (allowedOrigins.has(incomingOrigin)) {
    return new URL(target).origin;
  }
  return incomingOrigin;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envPrefix: [],
  publicDir: fileURLToPath(new URL('../favicon/', import.meta.url)),
  build: { outDir: 'build' },
  server: {
    host: devHost,
    port: devPort,
    proxy: {
      // The dev server stands in for the single origin used in production, so
      // rewrite ONLY the dev server's own origin to the backend origin and
      // preserve every other Origin header unchanged so the backend denies it.
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const incoming = proxyReq.getHeader('origin');
            const resolved = resolveProxyOrigin(incoming, {
              host: devHost,
              port: devPort,
              target: backendTarget,
            });
            if (resolved !== undefined && resolved !== incoming) {
              proxyReq.setHeader('origin', resolved);
            }
          });
        },
      },
    },
  },
});
