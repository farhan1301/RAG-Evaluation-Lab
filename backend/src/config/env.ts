import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  capabilities,
  priceSchedule,
  profile,
  z,
  type Capabilities,
  type PriceSchedule,
  type Profile,
  type ProviderCapabilities,
  type ProviderKind,
  type Role,
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
const flag = z.enum(['true', 'false']);
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
    BLOB_DIRECTORY: z.string().min(1).optional(),
    WORKER_LEASE_MS: positive.min(300).max(120000).default(30000),
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
    PROVIDER_TIMEOUT_MS: positive.max(300000).default(30000),
    EMBED_BATCH_SIZE: positive.max(2048).default(64),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: endpoint.optional(),
    OPENAI_CHAT_MODEL: model.optional(),
    OPENAI_EMBED_MODEL: model.optional(),
    OPENAI_EMBED_DIMENSIONS: positive.max(16384).optional(),
    OPENAI_JUDGE_MODEL: model.optional(),
    OPENAI_CHAT_SUPPORTS_TEMPERATURE: flag.optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_BASE_URL: endpoint.optional(),
    ANTHROPIC_CHAT_MODEL: model.optional(),
    ANTHROPIC_JUDGE_MODEL: model.optional(),
    ANTHROPIC_CHAT_SUPPORTS_TEMPERATURE: flag.optional(),
    LOCAL_EMBED_MODEL: model.optional(),
    LOCAL_EMBED_BASE_URL: endpoint.optional(),
    LOCAL_EMBED_API_KEY: z.string().optional(),
    LOCAL_EMBED_DIMENSIONS: positive.max(16384).optional(),
    LOCAL_CHAT_MODEL: model.optional(),
    LOCAL_JUDGE_MODEL: model.optional(),
    LOCAL_CHAT_BASE_URL: endpoint.optional(),
    LOCAL_CHAT_API_KEY: z.string().optional(),
    LOCAL_CHAT_SUPPORTS_TEMPERATURE: flag.default('true'),
    LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT: flag.default('false'),
    RERANK_BASE_URL: endpoint.optional(),
    RERANK_MODEL: model.optional(),
    RERANK_API_KEY: z.string().optional(),
    QDRANT_URL: endpoint.optional(),
    QDRANT_API_KEY: z.string().optional(),
    QDRANT_COLLECTION: model.default('rag-eval-chunks'),
    QDRANT_REQUIRED: flag.default('false'),
    LLAMA_CLOUD_API_KEY: z.string().optional(),
    LLAMA_PARSE_API_KEY: z.string().optional(),
    LLAMA_CLOUD_BASE_URL: endpoint.default(
      'https://api.cloud.llamaindex.ai/api',
    ),
    PRICE_SCHEDULE_JSON: z.string().optional(),
    PRICE_SCHEDULE_PATH: z.string().min(1).optional(),
    RUN_MAX_TOKENS: positive.max(100_000_000).optional(),
    RUN_MAX_COST_USD: z.coerce.number().positive().finite().optional(),
  })
  .superRefine((env, ctx) => {
    const require = (field: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });
    if (env.PRICE_SCHEDULE_JSON && env.PRICE_SCHEDULE_PATH)
      require('PRICE_SCHEDULE_JSON', 'Set either PRICE_SCHEDULE_JSON or PRICE_SCHEDULE_PATH, not both.');
    if (
      (env.OPENAI_CHAT_MODEL ||
        env.OPENAI_JUDGE_MODEL ||
        env.OPENAI_EMBED_MODEL) &&
      !env.OPENAI_API_KEY
    )
      require('OPENAI_API_KEY', 'An enabled OpenAI role requires a key.');
    if (
      (env.ANTHROPIC_CHAT_MODEL || env.ANTHROPIC_JUDGE_MODEL) &&
      !env.ANTHROPIC_API_KEY
    )
      require('ANTHROPIC_API_KEY', 'An enabled Anthropic role requires a key.');
    if (Boolean(env.LOCAL_EMBED_MODEL) !== Boolean(env.LOCAL_EMBED_BASE_URL))
      require('LOCAL_EMBED_MODEL', 'Configure a local embedding model and base URL together.');
    const hasLocalChat = Boolean(env.LOCAL_CHAT_MODEL || env.LOCAL_JUDGE_MODEL);
    if (hasLocalChat !== Boolean(env.LOCAL_CHAT_BASE_URL))
      require('LOCAL_CHAT_MODEL', 'Configure a local chat or judge model and base URL together.');
    if (Boolean(env.RERANK_MODEL) !== Boolean(env.RERANK_BASE_URL))
      require('RERANK_MODEL', 'Configure a reranker model and base URL together.');
    if (env.RERANK_API_KEY && !env.RERANK_BASE_URL)
      require('RERANK_BASE_URL', 'A reranker API key requires a base URL.');
    if (
      (env.QDRANT_REQUIRED === 'true' || env.QDRANT_API_KEY) &&
      !env.QDRANT_URL
    )
      require('QDRANT_URL', 'A configured Qdrant deployment requires an endpoint.');
    const seen = new Set<string>();
    const checkUnique = (
      role: Role,
      modelName: string | undefined,
      field: string,
    ) => {
      if (!modelName) return;
      const key = `${role}:${modelName}`;
      if (seen.has(key))
        require(field, `Duplicate ${role} profile model name.`);
      seen.add(key);
    };
    checkUnique('embedding', env.OPENAI_EMBED_MODEL, 'OPENAI_EMBED_MODEL');
    checkUnique('embedding', env.LOCAL_EMBED_MODEL, 'LOCAL_EMBED_MODEL');
    checkUnique('chat', env.OPENAI_CHAT_MODEL, 'OPENAI_CHAT_MODEL');
    checkUnique('chat', env.ANTHROPIC_CHAT_MODEL, 'ANTHROPIC_CHAT_MODEL');
    checkUnique('chat', env.LOCAL_CHAT_MODEL, 'LOCAL_CHAT_MODEL');
    checkUnique(
      'judge',
      env.OPENAI_JUDGE_MODEL ?? env.OPENAI_CHAT_MODEL,
      'OPENAI_JUDGE_MODEL',
    );
    checkUnique(
      'judge',
      env.ANTHROPIC_JUDGE_MODEL ?? env.ANTHROPIC_CHAT_MODEL,
      'ANTHROPIC_JUDGE_MODEL',
    );
    checkUnique(
      'judge',
      env.LOCAL_JUDGE_MODEL ?? env.LOCAL_CHAT_MODEL,
      'LOCAL_JUDGE_MODEL',
    );
    checkUnique('rerank', env.RERANK_MODEL, 'RERANK_MODEL');
  });

export interface ResolvedProviderProfile extends Profile {
  apiKey?: string;
  baseURL?: string;
  expectedDimensions?: number;
}

function buildOptions(
  role: Role,
  caps: ProviderCapabilities,
): Profile['options'] {
  if (role !== 'chat' && role !== 'judge') return [];
  const list: Profile['options'] = [];
  if (caps.temperature) list.push('temperature');
  if (caps.maxTokens) list.push('maxTokens');
  if (caps.structuredOutput) list.push('structuredOutput');
  return list;
}

export function readConfig(input: NodeJS.ProcessEnv = process.env) {
  const result = envSchema.safeParse(
    Object.fromEntries(Object.entries(input).filter(([, v]) => v?.trim())),
  );
  if (!result.success)
    throw new Error(
      `Invalid environment settings: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const env = result.data;
  const providerProfiles: ResolvedProviderProfile[] = [];
  const add = (
    role: Role,
    modelName: string | undefined,
    provider: ProviderKind,
    caps: ProviderCapabilities,
    connection: {
      apiKey?: string;
      baseURL?: string;
      expectedDimensions?: number;
    },
  ) => {
    if (!modelName) return;
    const safe = profile.parse({
      role,
      name: modelName,
      model: modelName,
      provider,
      options: buildOptions(role, caps),
      capabilities: caps,
    });
    providerProfiles.push({ ...safe, ...connection });
  };

  add(
    'embedding',
    env.OPENAI_EMBED_MODEL,
    'openai',
    {
      chat: false,
      embeddings: true,
      rerank: false,
      structuredOutput: false,
      temperature: false,
      maxTemperature: null,
      maxTokens: false,
      requiresMaxTokens: false,
    },
    {
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
      expectedDimensions: env.OPENAI_EMBED_DIMENSIONS,
    },
  );
  add(
    'embedding',
    env.LOCAL_EMBED_MODEL,
    'openai-compatible',
    {
      chat: false,
      embeddings: true,
      rerank: false,
      structuredOutput: false,
      temperature: false,
      maxTemperature: null,
      maxTokens: false,
      requiresMaxTokens: false,
    },
    {
      apiKey: env.LOCAL_EMBED_API_KEY,
      baseURL: env.LOCAL_EMBED_BASE_URL,
      expectedDimensions: env.LOCAL_EMBED_DIMENSIONS,
    },
  );

  const openaiChatTemp = (modelName: string) =>
    env.OPENAI_CHAT_SUPPORTS_TEMPERATURE !== undefined
      ? env.OPENAI_CHAT_SUPPORTS_TEMPERATURE === 'true'
      : supportsTemperature(modelName);
  if (env.OPENAI_CHAT_MODEL) {
    const temp = openaiChatTemp(env.OPENAI_CHAT_MODEL);
    add(
      'chat',
      env.OPENAI_CHAT_MODEL,
      'openai',
      {
        chat: true,
        embeddings: false,
        rerank: false,
        structuredOutput: true,
        temperature: temp,
        maxTemperature: temp ? 2 : null,
        maxTokens: true,
        requiresMaxTokens: false,
      },
      { apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL },
    );
  }
  const anthropicTemp =
    env.ANTHROPIC_CHAT_SUPPORTS_TEMPERATURE !== undefined
      ? env.ANTHROPIC_CHAT_SUPPORTS_TEMPERATURE === 'true'
      : false;
  if (env.ANTHROPIC_CHAT_MODEL) {
    add(
      'chat',
      env.ANTHROPIC_CHAT_MODEL,
      'anthropic',
      {
        chat: true,
        embeddings: false,
        rerank: false,
        structuredOutput: true,
        temperature: anthropicTemp,
        maxTemperature: anthropicTemp ? 1 : null,
        maxTokens: true,
        requiresMaxTokens: true,
      },
      { apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL },
    );
  }
  const localTemp = env.LOCAL_CHAT_SUPPORTS_TEMPERATURE === 'true';
  const localStructured = env.LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT === 'true';
  if (env.LOCAL_CHAT_MODEL) {
    add(
      'chat',
      env.LOCAL_CHAT_MODEL,
      'openai-compatible',
      {
        chat: true,
        embeddings: false,
        rerank: false,
        structuredOutput: localStructured,
        temperature: localTemp,
        maxTemperature: localTemp ? 2 : null,
        maxTokens: true,
        requiresMaxTokens: false,
      },
      { apiKey: env.LOCAL_CHAT_API_KEY, baseURL: env.LOCAL_CHAT_BASE_URL },
    );
  }

  const openaiJudge = env.OPENAI_JUDGE_MODEL ?? env.OPENAI_CHAT_MODEL;
  if (openaiJudge) {
    const temp = openaiChatTemp(openaiJudge);
    add(
      'judge',
      openaiJudge,
      'openai',
      {
        chat: true,
        embeddings: false,
        rerank: false,
        structuredOutput: true,
        temperature: temp,
        maxTemperature: temp ? 2 : null,
        maxTokens: true,
        requiresMaxTokens: false,
      },
      { apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL },
    );
  }
  const anthropicJudge = env.ANTHROPIC_JUDGE_MODEL ?? env.ANTHROPIC_CHAT_MODEL;
  if (anthropicJudge) {
    add(
      'judge',
      anthropicJudge,
      'anthropic',
      {
        chat: true,
        embeddings: false,
        rerank: false,
        structuredOutput: true,
        temperature: anthropicTemp,
        maxTemperature: anthropicTemp ? 1 : null,
        maxTokens: true,
        requiresMaxTokens: true,
      },
      { apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL },
    );
  }
  const localJudge = env.LOCAL_JUDGE_MODEL ?? env.LOCAL_CHAT_MODEL;
  if (localJudge) {
    add(
      'judge',
      localJudge,
      'openai-compatible',
      {
        chat: true,
        embeddings: false,
        rerank: false,
        structuredOutput: localStructured,
        temperature: localTemp,
        maxTemperature: localTemp ? 2 : null,
        maxTokens: true,
        requiresMaxTokens: false,
      },
      { apiKey: env.LOCAL_CHAT_API_KEY, baseURL: env.LOCAL_CHAT_BASE_URL },
    );
  }

  if (env.RERANK_MODEL && env.RERANK_BASE_URL) {
    add(
      'rerank',
      env.RERANK_MODEL,
      'http',
      {
        chat: false,
        embeddings: false,
        rerank: true,
        structuredOutput: false,
        temperature: false,
        maxTemperature: null,
        maxTokens: false,
        requiresMaxTokens: false,
      },
      { apiKey: env.RERANK_API_KEY, baseURL: env.RERANK_BASE_URL },
    );
  }

  const profiles: Capabilities['profiles'] = providerProfiles.map(
    ({ apiKey: _k, baseURL: _u, expectedDimensions: _d, ...safe }) => safe,
  );
  const llamaParseApiKey = env.LLAMA_CLOUD_API_KEY ?? env.LLAMA_PARSE_API_KEY;
  let pricing: PriceSchedule = priceSchedule.parse({
    version: 'unconfigured-v1',
    currency: 'USD',
    entries: [],
  });
  if (env.PRICE_SCHEDULE_JSON || env.PRICE_SCHEDULE_PATH) {
    try {
      const raw = env.PRICE_SCHEDULE_JSON
        ? env.PRICE_SCHEDULE_JSON
        : readFileSync(env.PRICE_SCHEDULE_PATH as string, 'utf8');
      pricing = priceSchedule.parse(JSON.parse(raw));
    } catch {
      throw new Error(
        `Invalid environment settings: ${env.PRICE_SCHEDULE_JSON ? 'PRICE_SCHEDULE_JSON' : 'PRICE_SCHEDULE_PATH'}`,
      );
    }
  }
  return {
    env,
    providerProfiles,
    pricing,
    budgets: {
      maxTokens: env.RUN_MAX_TOKENS ?? null,
      maxCostUsd: env.RUN_MAX_COST_USD ?? null,
    },
    capabilities: capabilities.parse({
      profiles,
      cloudParser: Boolean(llamaParseApiKey),
      denseStore: Boolean(env.QDRANT_URL),
      workerOnline: false,
    }),
    qdrant: env.QDRANT_URL
      ? {
          url: env.QDRANT_URL.replace(/\/$/, ''),
          apiKey: env.QDRANT_API_KEY,
          collectionPrefix: env.QDRANT_COLLECTION,
        }
      : undefined,
    parser: {
      llamaParseApiKey,
      llamaParseBaseUrl: env.LLAMA_CLOUD_BASE_URL,
    },
  };
}
export type Config = ReturnType<typeof readConfig>;
