import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const TSX_CLI = resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');
const VITE_BIN = resolve(REPO_ROOT, 'node_modules/vite/bin/vite.js');

export async function getFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') {
        srv.close(() => rej(new Error('Could not determine ephemeral port.')));
        return;
      }
      const { port } = address;
      srv.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastErr = new Error(`HTTP ${response.status} from ${url}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `Timed out waiting for ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function cleanBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      /^(OPENAI_|ANTHROPIC_|LOCAL_EMBED_|LOCAL_CHAT_|LOCAL_JUDGE_|RERANK_|QDRANT_|LLAMA_|PRICE_SCHEDULE_|RUN_MAX_)/.test(
        key,
      )
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export interface FixtureProviderOptions {
  delayMs?: number;
}

export interface OpenAIFixtureHandle {
  baseURL: string;
  setDelayMs: (ms: number) => void;
  getCallCount: () => number;
  close: () => Promise<void>;
}

/**
 * Local OpenAI-compatible HTTP server acting as chat and judge endpoints for
 * browser E2E testing with zero external network calls and zero API keys.
 */
export async function startOpenAIFixtureServer(
  options: FixtureProviderOptions = {},
): Promise<OpenAIFixtureHandle> {
  let delayMs = options.delayMs ?? 0;
  let callCount = 0;

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const buildResponseContent = (body: {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: { json_schema?: { name?: string } };
  }): string => {
    const schemaName = body.response_format?.json_schema?.name ?? '';
    const userText = body.messages[1]?.content ?? '';
    const chunkIds = Array.from(
      userText.matchAll(/(?:\(id=|chunkId=)([a-f0-9-]{36})/g),
    ).map((m) => m[1]);
    const uniqueChunkIds = Array.from(new Set(chunkIds));
    const lowerUser = userText.toLowerCase();

    if (schemaName === 'grounded_answer') {
      if (lowerUser.includes('numeric chunk size')) {
        return JSON.stringify({
          answer:
            'The provided passages do not specify a numeric chunk size for dense documents.',
          citations: [],
          abstained: true,
        });
      }
      const parts: string[] = [];
      if (lowerUser.includes('text-embedding-3-small')) {
        parts.push(
          'text-embedding-3-small balances cost and performance for many workloads.',
        );
      }
      if (lowerUser.includes('up-to-date embeddings')) {
        parts.push(
          'Best practices include chunking thresholds, overlap configuration, and maintaining up-to-date embeddings.',
        );
      }
      if (lowerUser.includes('similarity search')) {
        parts.push(
          'Vector databases support similarity search; selection factors include latency, scalability, filtering, and ecosystem tooling.',
        );
      }
      if (parts.length === 0) {
        parts.push('Grounded response synthesized from retrieved passages.');
      }
      return JSON.stringify({
        answer: parts.join(' '),
        citations: uniqueChunkIds.slice(0, 2),
        abstained: false,
      });
    }

    if (schemaName === 'judge_faithfulness') {
      const firstId = uniqueChunkIds[0];
      return JSON.stringify({
        refused: false,
        reason: '',
        claims: [
          {
            claim: 'The answer accurately summarizes the retrieved passages.',
            verdict: firstId ? 'supported' : 'unsupported',
            evidenceChunkIds: firstId ? [firstId] : [],
            quote: '',
          },
        ],
      });
    }

    if (schemaName === 'judge_answer_relevance') {
      return JSON.stringify({
        refused: false,
        grade: 4,
        rationale:
          'Directly addresses the user question using retrieved facts.',
      });
    }

    if (schemaName === 'judge_context_precision') {
      return JSON.stringify({
        refused: false,
        reason: '',
        passages: uniqueChunkIds.map((chunkId) => ({
          chunkId,
          useful: true,
          rationale: 'Passage contains facts relevant to the question.',
        })),
      });
    }

    if (schemaName === 'judge_context_recall') {
      const factMatches = Array.from(
        userText.matchAll(/^(\d+)\.\s+"""([^"]+)"""/gm),
      );
      const firstId = uniqueChunkIds[0];
      return JSON.stringify({
        refused: false,
        reason: '',
        facts: factMatches.map((match) => {
          const factIndex = Number(match[1]);
          const factText = match[2].toLowerCase();
          const passageSection =
            userText.split('Supplied Context Passages:')[1]?.toLowerCase() ??
            '';
          const supported =
            Boolean(firstId) &&
            factText
              .split(/\s+/)
              .filter((w) => w.length > 4)
              .some((word) => passageSection.includes(word));
          return {
            factIndex,
            supported,
            evidenceChunkIds: supported && firstId ? [firstId] : [],
            rationale: supported
              ? 'Supported by retrieved context passage.'
              : 'Fact was not present in the retrieved passages.',
          };
        }),
      });
    }

    // judge_answer_correctness
    const factMatches = Array.from(
      userText.matchAll(/^(\d+)\.\s+"""([^"]+)"""/gm),
    );
    const answerMatch = userText.match(/Answer:\n"""\n([\s\S]*?)\n"""/);
    const answerLower = (answerMatch?.[1] ?? '').toLowerCase();
    const facts = factMatches.map((match) => {
      const factIndex = Number(match[1]);
      const factText = match[2].toLowerCase();
      const satisfied = factText
        .split(/\s+/)
        .filter((w) => w.length > 4)
        .some((word) => answerLower.includes(word));
      return {
        factIndex,
        status: satisfied ? 'satisfied' : 'omitted',
        rationale: satisfied
          ? 'Fact covered in the generated answer.'
          : 'Fact omitted from the generated answer.',
      };
    });
    return JSON.stringify({
      refused: false,
      facts,
      criticalContradiction: false,
      acceptanceCriteriaMet: facts.every((f) => f.status === 'satisfied'),
      rationale: facts.every((f) => f.status === 'satisfied')
        ? 'All reviewed reference facts were satisfied without contradiction.'
        : 'Some reference facts were omitted due to incomplete retrieval.',
    });
  };

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        callCount += 1;
        try {
          const body = (await readJson(req)) as {
            model: string;
            messages: Array<{ role: string; content: string }>;
            response_format?: { json_schema?: { name?: string } };
          };
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          const content = buildResponseContent(body);
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': `fixture-req-${callCount}`,
          });
          res.end(
            JSON.stringify({
              id: `chatcmpl-fixture-${callCount}`,
              object: 'chat.completion',
              created: 1700000000,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 45,
                total_tokens: 165,
              },
            }),
          );
        } catch (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: err instanceof Error ? err.message : 'Bad request',
              },
            }),
          );
        }
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
    },
  );

  const port = await getFreePort();
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, '127.0.0.1', () => res());
  });

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    setDelayMs: (ms: number) => {
      delayMs = ms;
    },
    getCallCount: () => callCount,
    close: () =>
      new Promise<void>((res) => {
        server.close(() => res());
      }),
  };
}

export interface IsolatedStackHandle {
  frontendUrl: string;
  backendUrl: string;
  dataDir: string;
  stop: () => Promise<void>;
}

export async function startIsolatedStack(
  options: { extraEnv?: Record<string, string>; withWorker?: boolean } = {},
): Promise<IsolatedStackHandle> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rag-eval-e2e-isolated-'));
  const backendPort = await getFreePort();
  const frontendPort = await getFreePort();
  const baseEnv = cleanBaseEnv();
  const sharedEnv: Record<string, string> = {
    ...baseEnv,
    NODE_ENV: 'test',
    PORT: String(backendPort),
    DATABASE_PATH: join(dataDir, 'workspace.sqlite'),
    BLOB_DIRECTORY: join(dataDir, 'blobs'),
    WORKER_LEASE_MS: '5000',
    CORS_ORIGINS: `http://127.0.0.1:${frontendPort}`,
    ...(options.extraEnv ?? {}),
  };

  const children: ChildProcess[] = [];
  const spawnLogged = (
    cmd: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    return child;
  };

  const backend = spawnLogged(
    process.execPath,
    [TSX_CLI, 'src/index.ts'],
    resolve(REPO_ROOT, 'backend'),
    sharedEnv,
  );
  const backendLogs: string[] = [];
  backend.stderr?.on('data', (d) => backendLogs.push(String(d)));

  let worker: ChildProcess | null = null;
  if (options.withWorker !== false) {
    worker = spawnLogged(
      process.execPath,
      [TSX_CLI, 'src/jobs/worker.ts'],
      resolve(REPO_ROOT, 'backend'),
      sharedEnv,
    );
  }

  const frontend = spawnLogged(
    process.execPath,
    [VITE_BIN, '--port', String(frontendPort), '--strictPort'],
    resolve(REPO_ROOT, 'frontend'),
    {
      ...baseEnv,
      BACKEND_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
    },
  );

  const stop = async () => {
    for (const child of [frontend, worker, backend]) {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
    }
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((res) => {
            if (child.exitCode !== null) return res();
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              res();
            }, 5000);
            child.once('exit', () => {
              clearTimeout(timer);
              res();
            });
          }),
      ),
    );
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    await waitForUrl(
      `http://127.0.0.1:${backendPort}/${options.withWorker === false ? 'health/live' : 'health/ready'}`,
      30_000,
    );
    await waitForUrl(`http://127.0.0.1:${frontendPort}`, 30_000);
  } catch (err) {
    await stop();
    throw new Error(
      `Failed starting isolated stack: ${err instanceof Error ? err.message : String(err)}\n${backendLogs.join('')}`,
    );
  }

  return {
    frontendUrl: `http://127.0.0.1:${frontendPort}`,
    backendUrl: `http://127.0.0.1:${backendPort}`,
    dataDir,
    stop,
  };
}

/**
 * Verifies every visible or disabled form control (input, select, textarea) on
 * the current page has a meaningful accessible name and never falls back to "on".
 */
export async function assertAllFormControlsLabeled(
  page: Page,
  context: string,
) {
  const issues = await page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >('input:not([type="hidden"]), select, textarea'),
    );
    const bad: Array<{
      tag: string;
      type: string;
      id: string;
      reason: string;
    }> = [];
    for (const el of controls) {
      const ariaLabel = el.getAttribute('aria-label')?.trim() ?? '';
      const labelledBy = el.getAttribute('aria-labelledby')?.trim() ?? '';
      let labelledByText = '';
      if (labelledBy) {
        labelledByText = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .join(' ')
          .trim();
      }
      const labelTexts = Array.from(el.labels ?? [])
        .map((label) => label.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
        .trim();

      const accessibleName = ariaLabel || labelledByText || labelTexts;
      const type =
        el instanceof HTMLInputElement ? el.type : el.tagName.toLowerCase();
      if (!accessibleName) {
        bad.push({
          tag: el.tagName.toLowerCase(),
          type,
          id: el.id || '(no id)',
          reason: 'missing accessible name',
        });
      } else if (accessibleName.toLowerCase() === 'on') {
        bad.push({
          tag: el.tagName.toLowerCase(),
          type,
          id: el.id || '(no id)',
          reason: 'accessible name resolved to "on"',
        });
      }
    }
    return bad;
  });

  expect(
    issues,
    `Form control accessibility violations on ${context}: ${JSON.stringify(issues)}`,
  ).toEqual([]);
}

/** Locates a pipeline editor card by its exact title heading. */
export function pipelineCard(page: Page, name: string) {
  return page.locator('[data-slot="card"]').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

/**
 * Opens a report task's evidence panel. The Reports page auto-expands the first
 * differing task in an effect once the comparison loads, so a one-shot
 * "read aria-expanded, then click" can race it and toggle the panel shut.
 * Retry until the toggle settles expanded (nothing in the app collapses it).
 */
export async function expandEvidence(toggle: Locator) {
  await expect(async () => {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', {
      timeout: 1_000,
    });
  }).toPass();
}
