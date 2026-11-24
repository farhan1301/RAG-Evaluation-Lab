// Build with source maps in an isolated directory so the shipping build stays intact.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const sentinel = `synthetic-credential-${randomUUID()}`;
for (const key of [
  'OPENAI_API_KEY',
  'QDRANT_API_KEY',
  'LLAMA_CLOUD_API_KEY',
  'LLAMA_PARSE_API_KEY',
  'VITE_LLAMA_CLOUD_API_KEY',
  'VITE_LLAMA_PARSE_API_KEY',
]) {
  process.env[key] = sentinel;
}

const outDir = await mkdtemp(join(tmpdir(), 'rag-browser-'));
try {
  await build({
    root: 'frontend',
    build: { outDir, sourcemap: true, emptyOutDir: true },
    plugins: [
      {
        name: 'verify-browser-config',
        configResolved(config) {
          assert.equal(config.envDir, resolve('frontend'));
          assert(
            !JSON.stringify([config.env, config.define]).includes(sentinel),
            'Credential exposed in browser configuration',
          );
        },
      },
    ],
  });
  const files = await readdir(outDir, { recursive: true, withFileTypes: true });
  const outputs = files.filter((entry) => entry.isFile());
  assert(outputs.some((entry) => entry.name.endsWith('.js')));
  assert(outputs.some((entry) => entry.name.endsWith('.js.map')));
  for (const entry of outputs) {
    const bytes = await readFile(join(entry.parentPath, entry.name));
    assert(
      !bytes.includes(sentinel),
      `Synthetic credential found in ${entry.name}`,
    );
  }
  console.log(
    `Checked ${outputs.length} browser assets, including source maps.`,
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
