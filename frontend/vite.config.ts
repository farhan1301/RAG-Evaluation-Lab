import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envPrefix: [],
  publicDir: fileURLToPath(new URL('../favicon/', import.meta.url)),
  build: { outDir: 'build' },
  server: {
    host: '127.0.0.1',
    port: 3000,
    proxy: {
      '/api': process.env.BACKEND_PROXY_TARGET || 'http://127.0.0.1:7070',
    },
  },
});
