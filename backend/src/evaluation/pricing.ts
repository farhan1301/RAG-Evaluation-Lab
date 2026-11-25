import type {
  CostBreakdown,
  CostBucket,
  PriceSchedule,
  PriceScheduleEntry,
  ProviderKind,
  ProviderOperation,
  ProviderUsage,
  TokenBreakdown,
} from '@rag-eval/contracts';

export interface PricedCallResult {
  usageStatus: 'known' | 'missing';
  priceVersion: string;
  costStatus: 'known' | 'unknown';
  costUsd: number | null;
}

function findEntry(
  schedule: PriceSchedule,
  provider: ProviderKind,
  model: string,
): PriceScheduleEntry | undefined {
  const normalized = model.trim().toLowerCase();
  const exactProvider = schedule.entries.find(
    (entry) =>
      entry.provider === provider &&
      entry.model.trim().toLowerCase() === normalized,
  );
  if (exactProvider) return exactProvider;
  return schedule.entries.find(
    (entry) =>
      entry.provider === undefined &&
      entry.model.trim().toLowerCase() === normalized,
  );
}

/**
 * Computes USD cost for a single provider call from an explicit operator-configured price table.
 * A model without a configured price entry (or missing usage / unconfigured billable token rate)
 * always yields `costStatus: 'unknown'` and `costUsd: null` — never estimated.
 */
export function priceProviderCall(
  schedule: PriceSchedule,
  input: {
    provider: ProviderKind;
    model: string;
    usage?: ProviderUsage;
    succeeded?: boolean;
  },
): PricedCallResult {
  const entry = findEntry(schedule, input.provider, input.model);
  const usageStatus: 'known' | 'missing' = input.usage ? 'known' : 'missing';

  if (!entry) {
    return {
      usageStatus,
      priceVersion: schedule.version,
      costStatus: 'unknown',
      costUsd: null,
    };
  }

  if (entry.unit === 'per_request') {
    if (entry.requestUsd === undefined) {
      return {
        usageStatus,
        priceVersion: schedule.version,
        costStatus: 'unknown',
        costUsd: null,
      };
    }
    return {
      usageStatus,
      priceVersion: schedule.version,
      costStatus: 'known',
      costUsd: entry.requestUsd,
    };
  }

  if (!input.usage) {
    return {
      usageStatus: 'missing',
      priceVersion: schedule.version,
      costStatus: 'unknown',
      costUsd: null,
    };
  }

  const divisor = entry.unit === 'per_1m_tokens' ? 1_000_000 : 1_000;
  const inputTokens = input.usage.inputTokens;
  const outputTokens = input.usage.outputTokens;
  const cacheReadTokens = input.usage.cacheReadTokens ?? 0;
  const cacheCreationTokens = input.usage.cacheCreationTokens ?? 0;

  if (inputTokens > 0 && entry.inputUsd === undefined) {
    return {
      usageStatus: 'known',
      priceVersion: schedule.version,
      costStatus: 'unknown',
      costUsd: null,
    };
  }
  if (outputTokens > 0 && entry.outputUsd === undefined) {
    return {
      usageStatus: 'known',
      priceVersion: schedule.version,
      costStatus: 'unknown',
      costUsd: null,
    };
  }
  if (cacheReadTokens > 0 && entry.cacheReadUsd === undefined) {
    return {
      usageStatus: 'known',
      priceVersion: schedule.version,
      costStatus: 'unknown',
      costUsd: null,
    };
  }
  if (cacheCreationTokens > 0 && entry.cacheCreationUsd === undefined) {
    return {
      usageStatus: 'known',
      priceVersion: schedule.version,
      costStatus: 'unknown',
      costUsd: null,
    };
  }

  let totalUsd = 0;
  if (input.provider === 'anthropic') {
    // Anthropic reports input_tokens excluding cache_read and cache_creation tokens.
    totalUsd += (inputTokens / divisor) * (entry.inputUsd ?? 0);
    totalUsd += (cacheReadTokens / divisor) * (entry.cacheReadUsd ?? 0);
    totalUsd += (cacheCreationTokens / divisor) * (entry.cacheCreationUsd ?? 0);
  } else {
    // OpenAI and OpenAI-compatible report prompt_tokens including cached_tokens.
    const cached = Math.min(inputTokens, cacheReadTokens);
    const nonCached = inputTokens - cached;
    totalUsd += (nonCached / divisor) * (entry.inputUsd ?? 0);
    totalUsd += (cached / divisor) * (entry.cacheReadUsd ?? 0);
    totalUsd += (cacheCreationTokens / divisor) * (entry.cacheCreationUsd ?? 0);
  }
  totalUsd += (outputTokens / divisor) * (entry.outputUsd ?? 0);

  return {
    usageStatus: 'known',
    priceVersion: schedule.version,
    costStatus: 'known',
    costUsd: totalUsd,
  };
}

export interface ProviderCallCostRow {
  operation: ProviderOperation;
  model: string;
  isRetry: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalTokens: number | null;
  usageStatus: 'known' | 'missing';
  costStatus: 'known' | 'unknown';
  costUsd: number | null;
}

function summarizeBucket(rows: ProviderCallCostRow[]): CostBucket {
  if (rows.length === 0) {
    return {
      status: 'zero',
      totalUsd: 0,
      knownUsd: 0,
      pricedCalls: 0,
      totalCalls: 0,
      unpricedModels: [],
    };
  }
  let knownUsd = 0;
  let pricedCalls = 0;
  const unpriced = new Set<string>();
  for (const row of rows) {
    if (row.costStatus === 'known' && typeof row.costUsd === 'number') {
      knownUsd += row.costUsd;
      pricedCalls += 1;
    } else {
      unpriced.add(row.model);
    }
  }
  const unpricedModels = Array.from(unpriced).sort();
  if (pricedCalls === rows.length) {
    return {
      status: 'known',
      totalUsd: knownUsd,
      knownUsd,
      pricedCalls,
      totalCalls: rows.length,
      unpricedModels: [],
    };
  }
  if (pricedCalls > 0) {
    return {
      status: 'partial',
      totalUsd: null,
      knownUsd,
      pricedCalls,
      totalCalls: rows.length,
      unpricedModels,
    };
  }
  return {
    status: 'unknown',
    totalUsd: null,
    knownUsd: 0,
    pricedCalls: 0,
    totalCalls: rows.length,
    unpricedModels,
  };
}

/**
 * Aggregates provider call spend into indexing, serving, per-query serving,
 * judging, retry, and total run spend, plus token totals with retry tokens separated.
 */
export function aggregateCostAndTokens(
  rows: ProviderCallCostRow[],
  priceVersion: string,
  queryCount: number,
): { cost: CostBreakdown; tokens: TokenBreakdown } {
  const indexingRows = rows.filter(
    (r) => !r.isRetry && r.operation === 'corpus_embed',
  );
  const servingRows = rows.filter(
    (r) =>
      !r.isRetry &&
      (r.operation === 'query_embed' ||
        r.operation === 'rerank' ||
        r.operation === 'generate'),
  );
  const judgingRows = rows.filter((r) => !r.isRetry && r.operation === 'judge');
  const retryRows = rows.filter((r) => r.isRetry);

  const indexing = summarizeBucket(indexingRows);
  const serving = summarizeBucket(servingRows);
  const judging = summarizeBucket(judgingRows);
  const retry = summarizeBucket(retryRows);
  const total = summarizeBucket(rows);

  const perQueryServing = {
    status: serving.status,
    usdPerQuery:
      queryCount > 0 && serving.totalUsd !== null
        ? serving.totalUsd / queryCount
        : serving.status === 'zero'
          ? 0
          : null,
    knownUsdPerQuery: queryCount > 0 ? serving.knownUsd / queryCount : null,
    queryCount,
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalTokens = 0;
  let retryTokens = 0;
  let callsWithUsage = 0;

  for (const row of rows) {
    if (row.usageStatus === 'known') {
      callsWithUsage += 1;
      const inTok = row.inputTokens ?? 0;
      const outTok = row.outputTokens ?? 0;
      const crTok = row.cacheReadTokens ?? 0;
      const ccTok = row.cacheCreationTokens ?? 0;
      const totTok = row.totalTokens ?? inTok + outTok;
      inputTokens += inTok;
      outputTokens += outTok;
      cacheReadTokens += crTok;
      cacheCreationTokens += ccTok;
      totalTokens += totTok;
      if (row.isRetry) retryTokens += totTok;
    }
  }

  return {
    cost: {
      priceVersion,
      currency: 'USD',
      indexing,
      serving,
      perQueryServing,
      judging,
      retry,
      total,
    },
    tokens: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
      retryTokens,
      callsWithUsage,
      totalCalls: rows.length,
    },
  };
}
