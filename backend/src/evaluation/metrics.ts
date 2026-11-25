import type {
  EvaluationUnit,
  LatencyStats,
  MetricAggregate,
  MetricId,
  ObservationStatus,
} from '@rag-eval/contracts';

export const RETRIEVAL_METRIC_VERSION = 'retrieval-v1';
export const ABSTENTION_METRIC_VERSION = 'abstention-v1';

export const METRIC_DISPLAY_LABELS: Record<MetricId, string> = {
  hit_at_k: 'Hit@k',
  precision_at_k: 'Precision@k',
  recall_at_k: 'Recall@k',
  mrr_at_k: 'MRR@k',
  mrr: 'MRR (full depth)',
  ndcg_at_k: 'nDCG@k',
  faithfulness: 'Faithfulness / groundedness',
  answer_relevance: 'Answer relevance',
  context_precision: 'Judged passage usefulness (Judged context precision)',
  context_recall: 'Judged context recall',
  answer_correctness: 'Answer correctness',
  abstention_answerable: 'Answer attempt rate (answerable)',
  abstention_unanswerable: 'Abstention accuracy (unanswerable)',
};

export function metricDisplayLabel(metricId: MetricId, cutoff: number): string {
  if (cutoff > 0) {
    switch (metricId) {
      case 'hit_at_k':
        return `Hit@${cutoff}`;
      case 'precision_at_k':
        return `Precision@${cutoff}`;
      case 'recall_at_k':
        return `Recall@${cutoff}`;
      case 'mrr_at_k':
        return `MRR@${cutoff}`;
      case 'ndcg_at_k':
        return `nDCG@${cutoff}`;
      default:
        break;
    }
  }
  return METRIC_DISPLAY_LABELS[metricId];
}

export interface RetrievalQrel {
  documentId: string;
  grade: number;
}

export interface RankedRetrievedChunk {
  chunkId: string;
  documentId: string;
  documentVersionId?: string;
}

export interface TaskRetrievalEvalInput {
  /** Whether the retrieval call itself failed (timeout, upstream failure, etc.). */
  retrievalFailed: boolean;
  /** Safe reason when retrievalFailed is true. */
  retrievalError?: string | null;
  /** Whether the task is labeled answerable. Unanswerable tasks are excluded from retrieval metrics and scored under abstention. */
  answerable: boolean;
  /** Whether the qrels pool covers all documents ('complete') or a subset ('partial'). */
  pool: 'complete' | 'partial';
  /** Graded relevance labels (0-3) per document ID for this task version. */
  qrels: RetrievalQrel[];
  /** Ordered chunk list returned by the retriever (rank 1..N). */
  retrievedChunks: RankedRetrievedChunk[];
  /** Recorded retrieval depth requested from the pipeline (topK). */
  evaluatedDepth: number;
  /** Positive cutoffs k at which to compute @k metrics. */
  cutoffs: number[];
}

export interface ComputedObservation {
  metricId: MetricId;
  metricVersion: string;
  cutoff: number;
  evaluationUnit: EvaluationUnit;
  status: ObservationStatus;
  value: number | null;
  reason: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Collapses repeated chunks belonging to the same document at first occurrence,
 * preserving retrieval rank order.
 *
 * Document-level relevance is used by default so changing chunking parameters
 * does not invalidate the task's gold relevance labels.
 */
export function collapseDocuments(
  chunks: ReadonlyArray<{ documentId: string }>,
): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const chunk of chunks) {
    if (!seen.has(chunk.documentId)) {
      seen.add(chunk.documentId);
      unique.push(chunk.documentId);
    }
  }
  return unique;
}

/** Gain function for graded nDCG: 2^g - 1. */
export function dcgGain(grade: number): number {
  return 2 ** grade - 1;
}

/** Discount function for 1-indexed rank i: log2(i + 1). */
export function dcgDiscount(rank1Based: number): number {
  return Math.log2(rank1Based + 1);
}

/**
 * Computes deterministic document-level retrieval metrics against graded qrels (0-3).
 *
 * Edge cases (documented and explicitly represented as distinct statuses):
 * 1. Failed retrieval (`retrievalFailed: true`): status `'retrieval_failed'`, value `null`.
 * 2. Unanswerable task (`answerable: false`): status `'unanswerable'`, value `null`.
 *    Abstention behavior is evaluated separately.
 * 3. Missing qrels (`qrels.length === 0` on an answerable task): status `'missing_qrels'`, value `null`.
 * 4. No relevant documents (`qrels.length > 0` but all grades are 0, so |R| = 0):
 *    status `'no_relevant_docs'`, value `null` (avoids 0/0 in Recall and IDCG).
 * 5. Eligible task with empty successful retrieval (`retrievedChunks = []`):
 *    status `'scored'`, value `0` for all retrieval metrics.
 * 6. `k` larger than returned unique documents (`|D| < k`):
 *    - Missing ranks contribute 0 gain.
 *    - Precision@k keeps `k` in the denominator (empty slots count against precision).
 *    - Recall@k divides by `|R|` (all positive gold documents, including unretrieved ones).
 *    - IDCG@k sums the ideal ordering of ALL positive gold grades through `min(k, |R|)`.
 * 7. Partially judged pool (`pool === 'partial'`):
 *    Unjudged documents receive grade 0 (zero gain), `pooledEstimate: true` is recorded,
 *    and `judgedCoverage` reports the fraction of returned top-k documents with an explicit qrel.
 * 8. Full-depth MRR (`metricId: 'mrr'`, `cutoff: 0`):
 *    Evaluated over all collapsed documents within `evaluatedDepth`, recording `evaluatedDepth`
 *    and `returnedDocs` in metadata.
 */
export function evaluateTaskRetrieval(
  input: TaskRetrievalEvalInput,
): ComputedObservation[] {
  const uniqueCutoffs = Array.from(
    new Set(input.cutoffs.filter((k) => Number.isInteger(k) && k >= 1)),
  ).sort((a, b) => a - b);

  const uniqueDocs = collapseDocuments(input.retrievedChunks);
  const gradeMap = new Map<string, number>();
  for (const row of input.qrels) {
    gradeMap.set(row.documentId, row.grade);
  }
  const positiveGrades = Array.from(gradeMap.values())
    .filter((g) => g > 0)
    .sort((a, b) => b - a);

  const baseMeta = {
    pool: input.pool,
    pooledEstimate: input.pool === 'partial',
    evaluatedDepth: input.evaluatedDepth,
    returnedChunks: input.retrievedChunks.length,
    returnedDocs: uniqueDocs.length,
    relevantCount: positiveGrades.length,
    qrelCount: gradeMap.size,
  };

  let excludedStatus: ObservationStatus | null = null;
  let excludedReason: string | null = null;

  if (input.retrievalFailed) {
    excludedStatus = 'retrieval_failed';
    excludedReason = input.retrievalError ?? 'Retrieval failed for this task.';
  } else if (!input.answerable) {
    excludedStatus = 'unanswerable';
    excludedReason =
      'Task is labeled unanswerable; retrieval relevance metrics are excluded and abstention is scored separately.';
  } else if (gradeMap.size === 0) {
    excludedStatus = 'missing_qrels';
    excludedReason = 'Task has no relevance labels (qrels).';
  } else if (positiveGrades.length === 0) {
    excludedStatus = 'no_relevant_docs';
    excludedReason =
      'Task has no positively graded relevant documents (|R|=0).';
  }

  const observations: ComputedObservation[] = [];

  const emitExcluded = (metricId: MetricId, cutoff: number) => {
    observations.push({
      metricId,
      metricVersion: RETRIEVAL_METRIC_VERSION,
      cutoff,
      evaluationUnit: 'document',
      status: excludedStatus as ObservationStatus,
      value: null,
      reason: excludedReason,
      metadata: { ...baseMeta, judgedCoverage: null },
    });
  };

  if (excludedStatus) {
    for (const k of uniqueCutoffs) {
      emitExcluded('hit_at_k', k);
      emitExcluded('precision_at_k', k);
      emitExcluded('recall_at_k', k);
      emitExcluded('mrr_at_k', k);
      emitExcluded('ndcg_at_k', k);
    }
    emitExcluded('mrr', 0);
    return observations;
  }

  const relevantCount = positiveGrades.length;

  const coverageFor = (docs: string[]) => {
    if (docs.length === 0) {
      return {
        returnedInCutoff: 0,
        judgedInCutoff: 0,
        judgedCoverage: null as number | null,
      };
    }
    let judged = 0;
    for (const docId of docs) {
      if (gradeMap.has(docId)) judged += 1;
    }
    return {
      returnedInCutoff: docs.length,
      judgedInCutoff: judged,
      judgedCoverage: judged / docs.length,
    };
  };

  for (const k of uniqueCutoffs) {
    const slice = uniqueDocs.slice(0, k);
    const cov = coverageFor(slice);
    let positiveHits = 0;
    let firstPositiveRank = 0;
    let dcg = 0;

    for (let idx = 0; idx < slice.length; idx++) {
      const rank = idx + 1;
      const grade = gradeMap.get(slice[idx]) ?? 0;
      if (grade > 0) {
        positiveHits += 1;
        if (firstPositiveRank === 0) firstPositiveRank = rank;
        dcg += dcgGain(grade) / dcgDiscount(rank);
      }
    }

    const idealLen = Math.min(k, relevantCount);
    let idcg = 0;
    for (let idx = 0; idx < idealLen; idx++) {
      idcg += dcgGain(positiveGrades[idx]) / dcgDiscount(idx + 1);
    }

    const hit = positiveHits > 0 ? 1 : 0;
    const precision = positiveHits / k;
    const recall = positiveHits / relevantCount;
    const rr = firstPositiveRank > 0 ? 1 / firstPositiveRank : 0;
    const ndcg = idcg > 0 ? dcg / idcg : 0;

    const meta = {
      ...baseMeta,
      ...cov,
      dcg,
      idcg,
      positiveHits,
      firstPositiveRank: firstPositiveRank || null,
    };

    observations.push(
      {
        metricId: 'hit_at_k',
        metricVersion: RETRIEVAL_METRIC_VERSION,
        cutoff: k,
        evaluationUnit: 'document',
        status: 'scored',
        value: hit,
        reason: null,
        metadata: meta,
      },
      {
        metricId: 'precision_at_k',
        metricVersion: RETRIEVAL_METRIC_VERSION,
        cutoff: k,
        evaluationUnit: 'document',
        status: 'scored',
        value: precision,
        reason: null,
        metadata: meta,
      },
      {
        metricId: 'recall_at_k',
        metricVersion: RETRIEVAL_METRIC_VERSION,
        cutoff: k,
        evaluationUnit: 'document',
        status: 'scored',
        value: recall,
        reason: null,
        metadata: meta,
      },
      {
        metricId: 'mrr_at_k',
        metricVersion: RETRIEVAL_METRIC_VERSION,
        cutoff: k,
        evaluationUnit: 'document',
        status: 'scored',
        value: rr,
        reason: null,
        metadata: meta,
      },
      {
        metricId: 'ndcg_at_k',
        metricVersion: RETRIEVAL_METRIC_VERSION,
        cutoff: k,
        evaluationUnit: 'document',
        status: 'scored',
        value: ndcg,
        reason: null,
        metadata: meta,
      },
    );
  }

  // Full-depth MRR across all collapsed documents returned within evaluatedDepth.
  const fullCov = coverageFor(uniqueDocs);
  let fullFirstPositiveRank = 0;
  for (let idx = 0; idx < uniqueDocs.length; idx++) {
    const grade = gradeMap.get(uniqueDocs[idx]) ?? 0;
    if (grade > 0) {
      fullFirstPositiveRank = idx + 1;
      break;
    }
  }
  observations.push({
    metricId: 'mrr',
    metricVersion: RETRIEVAL_METRIC_VERSION,
    cutoff: 0,
    evaluationUnit: 'document',
    status: 'scored',
    value: fullFirstPositiveRank > 0 ? 1 / fullFirstPositiveRank : 0,
    reason: null,
    metadata: {
      ...baseMeta,
      ...fullCov,
      firstPositiveRank: fullFirstPositiveRank || null,
    },
  });

  return observations;
}

/**
 * Evaluates abstention behavior separately for answerable vs unanswerable tasks
 * so frequent abstention can never disguise low answer coverage.
 */
export function evaluateTaskAbstention(input: {
  answerable: boolean;
  generationFailed: boolean;
  generationError?: string | null;
  abstained?: boolean;
}): ComputedObservation {
  const metricId: MetricId = input.answerable
    ? 'abstention_answerable'
    : 'abstention_unanswerable';

  if (input.generationFailed || input.abstained === undefined) {
    return {
      metricId,
      metricVersion: ABSTENTION_METRIC_VERSION,
      cutoff: 0,
      evaluationUnit: 'task',
      status: 'generation_failed',
      value: null,
      reason:
        input.generationError ?? 'Answer generation did not produce an answer.',
      metadata: {
        answerable: input.answerable,
        expectedAbstain: !input.answerable,
      },
    };
  }

  const matched = input.answerable ? !input.abstained : input.abstained;
  return {
    metricId,
    metricVersion: ABSTENTION_METRIC_VERSION,
    cutoff: 0,
    evaluationUnit: 'task',
    status: 'scored',
    value: matched ? 1 : 0,
    reason: null,
    metadata: {
      answerable: input.answerable,
      abstained: input.abstained,
      expectedAbstain: !input.answerable,
      matched,
    },
  };
}

/**
 * Computes nearest-rank p50, p95, mean, and sample size from measured durations (ms).
 */
export function computeLatencyStats(samplesMs: number[]): LatencyStats {
  const valid = samplesMs
    .filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const n = valid.length;
  if (n === 0) {
    return { sampleSize: 0, meanMs: null, p50Ms: null, p95Ms: null };
  }
  const nearestRank = (p: number) => {
    const rank1 = Math.min(n, Math.max(1, Math.ceil(p * n)));
    return valid[rank1 - 1];
  };
  const sum = valid.reduce((acc, v) => acc + v, 0);
  return {
    sampleSize: n,
    meanMs: sum / n,
    p50Ms: nearestRank(0.5),
    p95Ms: nearestRank(0.95),
  };
}

const FAILURE_STATUSES = new Set<ObservationStatus>([
  'retrieval_failed',
  'generation_failed',
  'judge_malformed',
  'judge_refused',
  'judge_timeout',
  'judge_failed',
  'unresolved_evidence',
]);

export interface ObservationRowForAggregation {
  metricId: MetricId;
  metricVersion: string;
  cutoff: number;
  evaluationUnit: EvaluationUnit;
  status: ObservationStatus;
  value: number | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Aggregates per-task metric observations into full-precision macro means
 * with explicit eligible/total/failed/excluded counts and completion rates.
 */
export function aggregateMetricObservations(
  rows: ObservationRowForAggregation[],
): MetricAggregate[] {
  const groups = new Map<string, ObservationRowForAggregation[]>();
  for (const row of rows) {
    const key = `${row.metricId}|${row.metricVersion}|${row.cutoff}|${row.evaluationUnit}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const results: MetricAggregate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    let sum = 0;
    let eligibleCount = 0;
    let failedCount = 0;
    let excludedCount = 0;
    const exclusionBreakdown: Record<string, number> = {};
    let hasPartialPool = false;
    let coverageSum = 0;
    let coverageCount = 0;
    let passCount = 0;
    let passEligible = 0;
    let criticalContradictionCount = 0;

    for (const row of group) {
      if (row.metadata?.pooledEstimate === true) hasPartialPool = true;
      if (
        typeof row.metadata?.judgedCoverage === 'number' &&
        Number.isFinite(row.metadata.judgedCoverage)
      ) {
        coverageSum += row.metadata.judgedCoverage;
        coverageCount += 1;
      }

      if (row.status === 'scored' && typeof row.value === 'number') {
        sum += row.value;
        eligibleCount += 1;
        if (typeof row.metadata?.passed === 'boolean') {
          passEligible += 1;
          if (row.metadata.passed) passCount += 1;
        }
        if (row.metadata?.criticalContradiction === true) {
          criticalContradictionCount += 1;
        }
      } else {
        exclusionBreakdown[row.status] =
          (exclusionBreakdown[row.status] ?? 0) + 1;
        if (FAILURE_STATUSES.has(row.status)) {
          failedCount += 1;
        } else {
          excludedCount += 1;
        }
      }
    }

    const attemptedCount = eligibleCount + failedCount;
    const completionRate =
      attemptedCount > 0 ? eligibleCount / attemptedCount : null;

    results.push({
      metricId: first.metricId,
      metricVersion: first.metricVersion,
      cutoff: first.cutoff,
      evaluationUnit: first.evaluationUnit,
      displayLabel: metricDisplayLabel(first.metricId, first.cutoff),
      mean: eligibleCount > 0 ? sum / eligibleCount : null,
      eligibleCount,
      totalCount: group.length,
      failedCount,
      excludedCount,
      exclusionBreakdown,
      completionRate,
      hasPartialPool,
      meanJudgedCoverage:
        coverageCount > 0 ? coverageSum / coverageCount : null,
      passRate: passEligible > 0 ? passCount / passEligible : null,
      criticalContradictionCount,
    });
  }

  const order: MetricId[] = [
    'hit_at_k',
    'precision_at_k',
    'recall_at_k',
    'mrr_at_k',
    'mrr',
    'ndcg_at_k',
    'faithfulness',
    'answer_relevance',
    'context_precision',
    'context_recall',
    'answer_correctness',
    'abstention_answerable',
    'abstention_unanswerable',
  ];
  const rankOf = (id: MetricId) => {
    const idx = order.indexOf(id);
    return idx === -1 ? 999 : idx;
  };

  return results.sort((a, b) => {
    const byMetric = rankOf(a.metricId) - rankOf(b.metricId);
    if (byMetric !== 0) return byMetric;
    return a.cutoff - b.cutoff;
  });
}
