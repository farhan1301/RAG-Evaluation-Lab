import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backendTarget =
  process.env.BACKEND_PROXY_TARGET || 'http://127.0.0.1:7070';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envPrefix: [],
  publicDir: fileURLToPath(new URL('../favicon/', import.meta.url)),
  build: { outDir: 'build' },
  server: {
    host: '127.0.0.1',
    port: 3000,
    proxy: {
      // The dev server stands in for the single origin used in production, so
      // present proxied requests to the backend as same-origin.
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (proxyReq.getHeader('origin')) {
              proxyReq.setHeader('origin', new URL(backendTarget).origin);
            }
          });
        },
      },
    },
  },
});
