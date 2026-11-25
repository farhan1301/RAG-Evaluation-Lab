import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const BACKEND_PORT = 17071;
const FRONTEND_PORT = 13001;

const dataDir =
  process.env.E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'rag-eval-e2e-'));
process.env.E2E_DATA_DIR = dataDir;

const cleanEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (
    /^(OPENAI_|ANTHROPIC_|LOCAL_EMBED_|LOCAL_CHAT_|LOCAL_JUDGE_|RERANK_|QDRANT_|LLAMA_|PRICE_SCHEDULE_|RUN_MAX_)/.test(
      key,
    )
  ) {
    continue;
  }
  cleanEnv[key] = value;
}

const serverEnv: Record<string, string> = {
  ...cleanEnv,
  NODE_ENV: 'test',
  PORT: String(BACKEND_PORT),
  DATABASE_PATH: join(dataDir, 'workspace.sqlite'),
  BLOB_DIRECTORY: join(dataDir, 'blobs'),
  WORKER_LEASE_MS: '5000',
  CORS_ORIGINS: `http://127.0.0.1:${FRONTEND_PORT}`,
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  // The sample-workflow specs share one database and run in order, so a
  // retry cannot rescue a failure there; report failures instead.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:backend',
      url: `http://127.0.0.1:${BACKEND_PORT}/health/live`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: serverEnv,
    },
    {
      command: 'npm run dev:worker',
      url: `http://127.0.0.1:${BACKEND_PORT}/health/ready`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: serverEnv,
    },
    {
      command: `npm run dev -w rag-eval-frontend -- --port ${FRONTEND_PORT} --strictPort`,
      url: `http://127.0.0.1:${FRONTEND_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...cleanEnv,
        BACKEND_PROXY_TARGET: `http://127.0.0.1:${BACKEND_PORT}`,
      },
    },
  ],
});
