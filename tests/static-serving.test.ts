import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../backend/src/config/env';
import { openDatabase } from '../backend/src/db/database';
import { Datasets } from '../backend/src/db/datasets';
import { Pipelines } from '../backend/src/db/pipelines';
import { createApp } from '../backend/src/http/app';
import { createLogger } from '../backend/src/lib/logger';
import { send } from './inProcess';

describe('production single-origin static serving, SPA fallback, and env defaults', () => {
  let dir: string;
  let staticDir: string;
  let db: ReturnType<typeof openDatabase>;
  let clock: number;

  const INDEX_HTML =
    '<!DOCTYPE html><html><head><title>RAG Evaluation Lab</title></head><body><div id="root"></div></body></html>';
  const BUNDLE_JS = 'console.log("rag-eval-bundle");';
  const BUNDLE_CSS = 'body { color: inherit; }';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rag-static-'));
    staticDir = join(dir, '.install', 'frontend-build');
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), INDEX_HTML, 'utf8');
    writeFileSync(
      join(staticDir, 'assets', 'app-abc123.js'),
      BUNDLE_JS,
      'utf8',
    );
    writeFileSync(
      join(staticDir, 'assets', 'app-abc123.css'),
      BUNDLE_CSS,
      'utf8',
    );
    writeFileSync(join(staticDir, 'favicon.ico'), 'ico-bytes', 'utf8');
    writeFileSync(join(dir, 'outside-secret.txt'), 'do-not-serve', 'utf8');
    db = openDatabase(':memory:');
    clock = 1_000;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function buildApp(env: NodeJS.ProcessEnv = {}, withStatic = true) {
    return createApp({
      config: readConfig({
        BLOB_DIRECTORY: join(dir, 'blobs'),
        ...(withStatic ? { STATIC_DIR: staticDir } : {}),
        ...env,
      }),
      datasets: new Datasets(db),
      pipelines: new Pipelines(db),
      logger: createLogger({ write: () => {} }),
      now: () => clock,
      ready: () => true,
    });
  }

  it('serves built frontend assets and SPA deep links on the same origin as /api/v1', async () => {
    const app = buildApp();

    const root = await send(app, 'GET', '/');
    expect(root.status).toBe(200);
    expect(String(root.headers['content-type'])).toContain('text/html');
    expect(root.headers['cache-control']).toBe('no-store');
    expect(root.headers['x-content-type-options']).toBe('nosniff');
    expect(root.body).toBe(INDEX_HTML);

    const js = await send(app, 'GET', '/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(String(js.headers['content-type'])).toContain('javascript');
    expect(js.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(js.headers['x-content-type-options']).toBe('nosniff');
    expect(js.body).toBe(BUNDLE_JS);

    const css = await send(app, 'GET', '/assets/app-abc123.css');
    expect(css.status).toBe(200);
    expect(String(css.headers['content-type'])).toContain('text/css');
    expect(css.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(css.body).toBe(BUNDLE_CSS);

    const icon = await send(app, 'GET', '/favicon.ico');
    expect(icon.status).toBe(200);
    expect(icon.headers['cache-control']).toBe('no-store');

    for (const route of [
      '/datasets',
      '/pipelines',
      '/experiments',
      '/reports',
      '/reports/550e8400-e29b-41d4-a716-446655440000',
      '/history',
      '/docs',
      '/settings',
    ]) {
      const page = await send(app, 'GET', route);
      expect(page.status, `SPA route ${route}`).toBe(200);
      expect(String(page.headers['content-type'])).toContain('text/html');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['x-content-type-options']).toBe('nosniff');
      expect(page.body).toBe(INDEX_HTML);
    }

    const headRoute = await send(app, 'HEAD', '/datasets');
    expect(headRoute.status).toBe(200);
    expect(String(headRoute.headers['content-type'])).toContain('text/html');

    // Same-origin API calls continue working normally alongside static routes.
    const sample = await send(
      app,
      'POST',
      '/api/v1/datasets/sample',
      {},
      { origin: 'http://localhost' },
    );
    expect(sample.status).toBe(201);
    expect(sample.headers['access-control-allow-origin']).toBe(
      'http://localhost',
    );
  });

  it('returns JSON 404 for unknown API, health, missing assets, traversal attempts, and non-GET paths', async () => {
    const app = buildApp();

    for (const [method, path] of [
      ['GET', '/api/v1/does-not-exist'],
      ['POST', '/api/parse'],
      ['GET', '/health/unknown'],
      ['GET', '/assets/missing-hash.js'],
      ['GET', '/missing-icon.png'],
      ['GET', '/../outside-secret.txt'],
      ['GET', '/%2e%2e/outside-secret.txt'],
      ['POST', '/datasets'],
    ] as const) {
      const res = await send(
        app,
        method,
        path,
        method === 'POST' ? {} : undefined,
      );
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(String(res.headers['content-type'])).toContain('application/json');
      expect(res.body).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('enforces TRUSTED_HOSTS and Origin checks on static/SPA routes without burning API rate limits', async () => {
    const app = buildApp({ RATE_LIMIT: '2', RATE_WINDOW_MS: '60000' });

    const badHost = await send(app, 'GET', '/datasets', undefined, {
      host: 'evil.example',
    });
    expect(badHost.status).toBe(403);
    expect(badHost.body).toMatchObject({ error: { code: 'origin_denied' } });

    const badOriginPage = await send(app, 'GET', '/datasets', undefined, {
      origin: 'https://evil.example',
    });
    expect(badOriginPage.status).toBe(403);
    expect(badOriginPage.body).toMatchObject({
      error: { code: 'origin_denied' },
    });

    const badOriginAsset = await send(
      app,
      'GET',
      '/assets/app-abc123.js',
      undefined,
      { origin: 'https://evil.example' },
    );
    expect(badOriginAsset.status).toBe(403);

    // Static asset requests do not consume the /api/ rate-limit bucket.
    for (let i = 0; i < 4; i++) {
      const asset = await send(app, 'GET', '/assets/app-abc123.js');
      expect(asset.status).toBe(200);
    }
    expect((await send(app, 'GET', '/api/v1/capabilities')).status).toBe(200);
    expect((await send(app, 'GET', '/api/v1/capabilities')).status).toBe(200);
    expect((await send(app, 'GET', '/api/v1/capabilities')).status).toBe(429);
  });

  it('leaves dev mode untouched when STATIC_DIR is unset and fails fast when index.html is missing', async () => {
    const devApp = buildApp({}, false);
    const root = await send(devApp, 'GET', '/');
    expect(root.status).toBe(404);
    expect(root.body).toMatchObject({ error: { code: 'not_found' } });

    const emptyDir = join(dir, 'empty-static');
    mkdirSync(emptyDir, { recursive: true });
    expect(() => buildApp({ STATIC_DIR: emptyDir }, false)).toThrow(
      /missing index\.html/i,
    );
  });

  it('validates HOST binding values and confirms .env.example boots cleanly with zero API keys', () => {
    expect(readConfig({ HOST: '0.0.0.0' }).env.HOST).toBe('0.0.0.0');
    expect(readConfig({ HOST: '127.0.0.1' }).env.HOST).toBe('127.0.0.1');
    expect(readConfig({}).env.HOST).toBe('127.0.0.1');
    expect(() => readConfig({ HOST: 'not a host' })).toThrow(
      'Invalid environment',
    );

    // Parse all active key=value lines from .env.example and verify readConfig accepts them.
    const raw = readFileSync(resolve('.env.example'), 'utf8');
    const parsedEnv: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1');
      parsedEnv[key] = val;
    }
    const config = readConfig(parsedEnv);
    expect(config.capabilities).toEqual({
      profiles: [],
      cloudParser: false,
      denseStore: false,
      workerOnline: false,
    });
  });
});
