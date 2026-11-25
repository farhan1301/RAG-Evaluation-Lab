import type { FusionWeights, GenerationChunk } from '@rag-eval/contracts';

export const RRF_CONSTANT = 60;

export interface RankedCandidate {
  chunk: GenerationChunk;
  rank: number;
  score: number;
}

export interface FusedCandidate {
  chunk: GenerationChunk;
  keywordRank: number | null;
  keywordScore: number | null;
  denseRank: number | null;
  denseScore: number | null;
  fusedRank: number;
  fusedScore: number;
}

export function compareStableId(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Reciprocal Rank Fusion: score(d) = sum_s weight_s / (60 + rank_s(d)),
 * with deterministic tie-breaking by stable chunkId.
 */
export function reciprocalRankFuse(
  keyword: RankedCandidate[],
  dense: RankedCandidate[],
  weights: FusionWeights = { keyword: 1, dense: 1 },
): FusedCandidate[] {
  const map = new Map<
    string,
    {
      chunk: GenerationChunk;
      keywordRank: number | null;
      keywordScore: number | null;
      denseRank: number | null;
      denseScore: number | null;
      fusedScore: number;
    }
  >();

  for (const hit of keyword) {
    const contribution = weights.keyword / (RRF_CONSTANT + hit.rank);
    map.set(hit.chunk.chunkId, {
      chunk: hit.chunk,
      keywordRank: hit.rank,
      keywordScore: hit.score,
      denseRank: null,
      denseScore: null,
      fusedScore: contribution,
    });
  }

  for (const hit of dense) {
    const contribution = weights.dense / (RRF_CONSTANT + hit.rank);
    const existing = map.get(hit.chunk.chunkId);
    if (existing) {
      existing.denseRank = hit.rank;
      existing.denseScore = hit.score;
      existing.fusedScore += contribution;
    } else {
      map.set(hit.chunk.chunkId, {
        chunk: hit.chunk,
        keywordRank: null,
        keywordScore: null,
        denseRank: hit.rank,
        denseScore: hit.score,
        fusedScore: contribution,
      });
    }
  }

  const ordered = Array.from(map.values()).sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    return compareStableId(a.chunk.chunkId, b.chunk.chunkId);
  });

  return ordered.map((entry, idx) => ({
    ...entry,
    fusedRank: idx + 1,
  }));
}
