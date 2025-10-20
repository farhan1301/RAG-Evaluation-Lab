import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import fetch from 'node-fetch';
import { loadConfig } from '../src/lib/config.js';
import { QdrantClient } from '../src/lib/qdrantClient.js';

const sanitizeCollection = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'default';

const requestWithTimeout = async (
  url: string,
  options: Parameters<typeof fetch>[1],
  timeoutMs = 15000
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..', '..');

  const loadEnvFile = (filename: string, override = false) => {
    const result = loadEnv({ path: path.join(repoRoot, filename), override });
    if (result.error) {
      const error = result.error as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  };

  loadEnvFile('.env');
  loadEnvFile('.env.local', true);

  const config = loadConfig();
  const qdrant = new QdrantClient(config);

  const collectionName = sanitizeCollection(config.qdrantCollection);
  const fieldName = 'pipelineId';

  console.log(`Ensuring collection "${collectionName}" exists…`);
  await qdrant.ensureCollection(1536, collectionName);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.qdrantApiKey) {
    headers['api-key'] = config.qdrantApiKey;
    headers.Authorization = `Bearer ${config.qdrantApiKey}`;
  }

  const baseUrl = config.qdrantUrl;
  const endpoints: Array<{ method: 'PUT' | 'POST'; url: string }> = [
    { method: 'PUT', url: `${baseUrl}/collections/${collectionName}/index?wait=true` },
    { method: 'POST', url: `${baseUrl}/collections/${collectionName}/indexes?wait=true` },
  ];

  let lastError: { status: number; detail: string } | null = null;

  for (const { method, url } of endpoints) {
    console.log(
      `Attempting ${method} ${url} with schema {"field_name":"${fieldName}","field_schema":"keyword"} …`
    );
    try {
      const response = await requestWithTimeout(
        url,
        {
          method,
          headers,
          body: JSON.stringify({
            field_name: fieldName,
            field_schema: 'keyword',
          }),
        },
        15000
      );

      if (response.ok) {
        console.log(`✅ Index for "${fieldName}" created successfully.`);
        return;
      }

      if (response.status === 409) {
        console.log(`ℹ️ Index for "${fieldName}" already exists (409 conflict). Nothing to do.`);
        return;
      }

      const detail = await response.text();
      console.warn(`Attempt failed (${response.status}): ${detail}`);
      lastError = { status: response.status, detail };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'Request timed out.'
          : error instanceof Error
          ? error.message
          : String(error);
      console.warn(`Attempt failed: ${message}`);
      lastError = { status: 0, detail: message };
    }
  }

  if (lastError) {
    throw new Error(
      `Failed to create payload index after multiple attempts (${lastError.status}): ${lastError.detail}`
    );
  } else {
    throw new Error('Failed to create payload index for an unknown reason.');
  }
}

main().catch((error) => {
  console.error('❌ Unable to create Qdrant payload index.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
