import { defineConfig } from 'vitest/config';
import frontend from './frontend/vite.config';

export default defineConfig({
  resolve: frontend.resolve,
  esbuild: { jsx: 'automatic' },
  test: { include: ['tests/**/*.test.{ts,jsx}'] },
});
