import type { BootstrapInterval, ResamplingRule } from '@rag-eval/contracts';

export const DEFAULT_BOOTSTRAP_SAMPLES = 1000;
export const DEFAULT_BOOTSTRAP_SEED = 42;
export const DEFAULT_BOOTSTRAP_CONFIDENCE = 0.95;
export const DEFAULT_BOOTSTRAP_MIN_PAIRS = 5;

export interface BootstrapOptions {
  samples?: number;
  seed?: number;
  confidenceLevel?: number;
  minPairs?: number;
}

/**
 * Deterministic 32-bit PRNG (Mulberry32) used for reproducible paired bootstrap intervals.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = probability * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function describeResamplingRule(
  options: BootstrapOptions = {},
): ResamplingRule {
  const samples = options.samples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const confidenceLevel =
    options.confidenceLevel ?? DEFAULT_BOOTSTRAP_CONFIDENCE;
  const minPairs = options.minPairs ?? DEFAULT_BOOTSTRAP_MIN_PAIRS;
  const pct = Math.round(confidenceLevel * 100);
  return {
    method: 'seeded_task_paired_bootstrap',
    seed,
    samples,
    confidenceLevel,
    minPairs,
    description: `Task-level paired percentile bootstrap resampling with replacement over tasks scored in both runs (seed=${seed}, B=${samples} resamples, ${pct}% CI, minimum ${minPairs} paired tasks).`,
  };
}

export function pairedBootstrapInterval(
  deltas: number[],
  options: BootstrapOptions = {},
): { interval: BootstrapInterval | null; note: string | null } {
  const samples = options.samples ?? DEFAULT_BOOTSTRAP_SAMPLES;
  const seed = options.seed ?? DEFAULT_BOOTSTRAP_SEED;
  const confidenceLevel =
    options.confidenceLevel ?? DEFAULT_BOOTSTRAP_CONFIDENCE;
  const minPairs = options.minPairs ?? DEFAULT_BOOTSTRAP_MIN_PAIRS;

  if (samples <= 0) {
    return {
      interval: null,
      note: 'Paired bootstrap resampling was disabled (samples=0).',
    };
  }
  if (deltas.length < minPairs) {
    return {
      interval: null,
      note: `Requires at least ${minPairs} paired tasks for a bootstrap interval (found ${deltas.length}).`,
    };
  }

  const nextRand = mulberry32(seed);
  const n = deltas.length;
  const resampleMeans = new Array<number>(samples);
  for (let b = 0; b < samples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(nextRand() * n);
      sum += deltas[idx];
    }
    resampleMeans[b] = sum / n;
  }
  resampleMeans.sort((a, b) => a - b);

  const alpha = 1 - confidenceLevel;
  const lower = quantile(resampleMeans, alpha / 2);
  const upper = quantile(resampleMeans, 1 - alpha / 2);
  return {
    interval: {
      lower: Math.min(lower, upper),
      upper: Math.max(lower, upper),
      confidenceLevel,
      samples,
      seed,
    },
    note: null,
  };
}
