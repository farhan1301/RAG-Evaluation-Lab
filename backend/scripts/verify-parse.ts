import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from '../src/lib/config.js';
import { LlamaParseClient } from '../src/lib/llamaParseClient.js';

const defaultSamplePath = fileURLToPath(
  new URL('../sample-data/llamaparse-demo.txt', import.meta.url)
);

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

  const [, , inputPath] = process.argv;
  const filePath = inputPath ?? defaultSamplePath;
  const resolvedPath = path.resolve(filePath);

  const fileBuffer = await readFile(resolvedPath);
  const config = loadConfig();

  if (!config.llamaParseApiKey) {
    throw new Error('LlamaParse API key is not configured. Set LLAMA_CLOUD_API_KEY in your environment.');
  }

  const client = new LlamaParseClient(config);
  const parsed = await client.parseDocument({
    buffer: fileBuffer,
    filename: path.basename(resolvedPath),
    mimeType: path.extname(resolvedPath).toLowerCase() === '.pdf' ? 'application/pdf' : 'text/plain',
  });

  console.log('✅ LlamaParse verification succeeded');
  console.log(`Job ID: ${parsed.jobId}`);
  console.log(`Page count: ${parsed.pageCount}`);
  console.log('--- Parsed Text Preview ---');
  console.log(parsed.text.slice(0, 500));
  if (parsed.text.length > 500) {
    console.log('... (truncated)');
  }
}

main().catch((error) => {
  console.error('❌ LlamaParse verification failed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
