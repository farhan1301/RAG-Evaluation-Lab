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

  it('aligns root engines.node and setup docs with locked runtime and Vitest Node ranges', () => {
    const parseFloor = (range: string): [number, number, number] | null => {
      const m = range.match(/(?:>=|\^)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
      if (!m) return null;
      return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
    };
    const compareSemver = (
      a: [number, number, number],
      b: [number, number, number],
    ) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const satisfiesComparator = (
      version: [number, number, number],
      comp: string,
    ): boolean => {
      const caret = comp.match(/^\^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
      if (caret) {
        const floor: [number, number, number] = [
          Number(caret[1]),
          Number(caret[2] ?? 0),
          Number(caret[3] ?? 0),
        ];
        return version[0] === floor[0] && compareSemver(version, floor) >= 0;
      }
      const gte = comp.match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
      if (gte) {
        const floor: [number, number, number] = [
          Number(gte[1]),
          Number(gte[2] ?? 0),
          Number(gte[3] ?? 0),
        ];
        return compareSemver(version, floor) >= 0;
      }
      return false;
    };
    const satisfiesRange = (
      version: [number, number, number],
      range: string,
    ): boolean =>
      range
        .split('||')
        .map((part) => part.trim())
        .some((branch) =>
          branch
            .split(/\s+/)
            .filter(Boolean)
            .every((comp) => satisfiesComparator(version, comp)),
        );

    const expectedRange = '^22.22.0 || ^24.0.0 || >=26.0.0';
    const rootPkg = JSON.parse(
      readFileSync(resolve('package.json'), 'utf8'),
    ) as { engines?: { node?: string } };
    const rootRange = rootPkg.engines?.node ?? '';
    const rootFloor = parseFloor(rootRange);
    expect(rootFloor).not.toBeNull();

    // Excludes odd Node majors 23 and 25 rejected by locked Vitest while allowing 22.22+, 24+, and 26+.
    expect(satisfiesRange([22, 22, 0], rootRange)).toBe(true);
    expect(satisfiesRange([23, 0, 0], rootRange)).toBe(false);
    expect(satisfiesRange([24, 0, 0], rootRange)).toBe(true);
    expect(satisfiesRange([25, 0, 0], rootRange)).toBe(false);
    expect(satisfiesRange([26, 0, 0], rootRange)).toBe(true);

    const lock = JSON.parse(
      readFileSync(resolve('package-lock.json'), 'utf8'),
    ) as {
      packages: Record<string, { dev?: boolean; engines?: { node?: string } }>;
    };
    for (const [pkgPath, meta] of Object.entries(lock.packages)) {
      if (!pkgPath || meta.dev || !meta.engines?.node) continue;
      const depFloor = parseFloor(meta.engines.node);
      if (!depFloor || !rootFloor) continue;
      expect(
        compareSemver(rootFloor, depFloor),
        `root engines.node (${rootRange}) must satisfy runtime dep ${pkgPath} (${meta.engines.node})`,
      ).toBeGreaterThanOrEqual(0);
    }

    expect(rootRange).toBe(expectedRange);
    const readme = readFileSync(resolve('README.md'), 'utf8');
    const contributing = readFileSync(resolve('CONTRIBUTING.md'), 'utf8');
    expect(readme).toContain(expectedRange);
    expect(readme).not.toContain('>=22.18');
    expect(contributing).toContain(expectedRange);
    expect(contributing).not.toContain('>=22.18');
  });

  it('documents working native production startup and loopback-published native Qdrant setup', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8');
    expect(readme).toContain(
      'NODE_ENV=production npm start -w rag-eval-backend',
    );
    expect(readme).not.toContain(
      'STATIC_DIR=frontend/build npm start -w rag-eval-backend',
    );

    // The built-in asset resolution in backend/dist/index.js resolves ../../frontend/build -> <repo>/frontend/build.
    const resolvedFromBackendDist = resolve(
      'backend',
      'dist',
      '../../frontend/build',
    );
    expect(resolvedFromBackendDist).toBe(resolve('frontend/build'));

    // Native Qdrant troubleshooting must not rely on Compose's unpublished qdrant service for 127.0.0.1:6333.
    const troubleshootingLine =
      readme
        .split('\n')
        .find((line) => line.includes('Qdrant missing or unreachable')) ?? '';
    expect(troubleshootingLine).toContain('127.0.0.1:6333:6333');
    expect(troubleshootingLine).toContain('CONTRIBUTING.md');
  });
});
