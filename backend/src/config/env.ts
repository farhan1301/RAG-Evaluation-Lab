import { fileURLToPath } from 'node:url';
import {
  capabilities,
  profile,
  z,
  type Role,
  type Capabilities,
} from '@rag-eval/contracts';

import { supportsTemperature } from './modelOptions.js';

export function loadEnvironment() {
  for (const filename of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(new URL(`../../../${filename}`, import.meta.url));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

const endpoint = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = URL.parse(value);
  return !!url && !url.username && !url.password && !url.search && !url.hash;
}, 'Expected an HTTP endpoint without credentials or query parameters.');
const model = z.string().trim().min(1).max(200);
const positive = z.coerce.number().int().min(1);
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(7070),
    DATABASE_PATH: z
      .string()
      .min(1)
      .default(
        fileURLToPath(new URL('../../data/workspace.sqlite', import.meta.url)),
      ),
    CORS_ORIGINS: csv
      .pipe(
        z.array(
          endpoint.refine(
            (value) => URL.parse(value)?.origin === value,
            'Expected an exact origin.',
          ),
        ),
      )
      .prefault(''),
    TRUSTED_HOSTS: csv
      .pipe(z.array(z.string().regex(/^(?:[a-zA-Z0-9.-]+|\[::1\])$/)).min(1))
      .prefault('localhost,127.0.0.1,[::1]'),
    TRUSTED_PROXIES: csv
      .pipe(z.array(z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])))
      .prefault(''),
    JSON_LIMIT_BYTES: positive.max(16777216).default(256 * 1024),
    DOCUMENT_LIMIT_BYTES: positive.max(16777216).default(12 * 1024 * 1024),
    RATE_LIMIT: positive.default(600),
    RATE_WINDOW_MS: positive.max(3600000).default(60000),
    SHUTDOWN_TIMEOUT_MS: positive.max(120000).default(10000),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_CHAT_MODEL: model.optional(),
    OPENAI_EMBED_MODEL: model.optional(),
    OPENAI_JUDGE_MODEL: model.optional(),
    LOCAL_EMBED_MODEL: model.optional(),
    LOCAL_EMBED_BASE_URL: endpoint.optional(),
    QDRANT_URL: endpoint.optional(),
    QDRANT_API_KEY: z.string().optional(),
    QDRANT_COLLECTION: model.default('rag-eval-chunks'),
    QDRANT_COLLECTION_1536: model.optional(),
    QDRANT_COLLECTION_3072: model.optional(),
    QDRANT_REQUIRED: z.enum(['true', 'false']).default('false'),
    LLAMA_CLOUD_API_KEY: z.string().optional(),
    LLAMA_PARSE_API_KEY: z.string().optional(),
    LLAMA_CLOUD_BASE_URL: endpoint.default(
      'https://api.cloud.llamaindex.ai/api',
    ),
  })
  .superRefine((env, ctx) => {
    const require = (field: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });
    if (
      (env.OPENAI_CHAT_MODEL ||
        env.OPENAI_JUDGE_MODEL ||
        env.OPENAI_EMBED_MODEL) &&
      !env.OPENAI_API_KEY
    )
      require('OPENAI_API_KEY', 'An enabled OpenAI role requires a key.');
    if (Boolean(env.LOCAL_EMBED_MODEL) !== Boolean(env.LOCAL_EMBED_BASE_URL))
      require('LOCAL_EMBED_MODEL', 'Configure a local embedding model and base URL together.');
    if (
      env.LOCAL_EMBED_MODEL &&
      env.LOCAL_EMBED_MODEL === env.OPENAI_EMBED_MODEL
    )
      require('LOCAL_EMBED_MODEL', 'Embedding profiles must have distinct model names.');
    if (
      (env.QDRANT_REQUIRED === 'true' || env.QDRANT_API_KEY) &&
      !env.QDRANT_URL
    )
      require('QDRANT_URL', 'A configured Qdrant deployment requires an endpoint.');
  });

export function readConfig(input: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(
    Object.fromEntries(Object.entries(input).filter(([, v]) => v?.trim())),
  );
  if (!result.success)
    throw new Error(
      `Invalid environment settings: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const env = result.data;
  const profiles: Capabilities['profiles'] = [];
  const add = (
    role: Role,
    model: string | undefined,
    provider: 'openai' | 'openai-compatible',
  ) => {
    if (model)
      profiles.push(
        profile.parse({
          role,
          name: model,
          model,
          provider,
          options:
            role === 'chat'
              ? supportsTemperature(model)
                ? ['temperature', 'maxTokens']
                : ['maxTokens']
              : [],
        }),
      );
  };
  add('embedding', env.OPENAI_EMBED_MODEL, 'openai');
  add('embedding', env.LOCAL_EMBED_MODEL, 'openai-compatible');
  add('chat', env.OPENAI_CHAT_MODEL, 'openai');
  add('judge', env.OPENAI_JUDGE_MODEL ?? env.OPENAI_CHAT_MODEL, 'openai');
  const llamaParseApiKey = env.LLAMA_CLOUD_API_KEY ?? env.LLAMA_PARSE_API_KEY;
  return {
    env,
    capabilities: capabilities.parse({
      profiles,
      cloudParser: Boolean(llamaParseApiKey),
      denseStore: Boolean(env.QDRANT_URL),
    }),
    legacy: {
      openaiApiKey: env.OPENAI_API_KEY ?? '',
      openaiEmbeddingModel:
        env.OPENAI_EMBED_MODEL ?? env.LOCAL_EMBED_MODEL ?? '',
      openaiChatModel: env.OPENAI_CHAT_MODEL ?? '',
      qdrantUrl: env.QDRANT_URL?.replace(/\/$/, '') ?? '',
      qdrantApiKey: env.QDRANT_API_KEY,
      qdrantCollection: env.QDRANT_COLLECTION,
      qdrantCollections: Object.fromEntries(
        [
          ['1536', env.QDRANT_COLLECTION_1536],
          ['3072', env.QDRANT_COLLECTION_3072],
        ].filter(([, v]) => v),
      ) as Record<number, string>,
      llamaParseApiKey,
      llamaParseBaseUrl: env.LLAMA_CLOUD_BASE_URL,
      localEmbedModel: env.LOCAL_EMBED_MODEL,
      localEmbedBaseUrl: env.LOCAL_EMBED_BASE_URL,
    },
  };
}
export type Config = ReturnType<typeof readConfig>;
