import {
  documentationPayload,
  type DocumentationPayload,
  type MetricDefinitionDoc,
} from '@rag-eval/contracts';
import type { Config } from '../config/env.js';
import { PROMPT_VERSION, SOFTWARE_VERSION } from '../db/runs.js';
import {
  ABSTENTION_METRIC_VERSION,
  METRIC_DISPLAY_LABELS,
  RETRIEVAL_METRIC_VERSION,
} from '../evaluation/metrics.js';
import { loadRubrics } from '../evaluation/rubrics.js';
import { describeResamplingRule } from './bootstrap.js';

const RETRIEVAL_EDGE_CASES = [
  'Failed retrieval -> status retrieval_failed, value null (excluded from mean, counted in failedCount).',
  'Unanswerable task -> status unanswerable, value null (scored separately under abstention).',
  'Missing qrels -> status missing_qrels, value null.',
  'No positively graded gold documents (|R|=0) -> status no_relevant_docs, value null.',
  'Eligible task with empty successful retrieval -> status scored, value 0.',
  'Partial labeling pool -> unjudged documents receive grade 0 and judgedCoverage is reported alongside pooled estimates.',
];

function buildMetricDocs(): MetricDefinitionDoc[] {
  const rubrics = loadRubrics();
  const retrievalDocs: MetricDefinitionDoc[] = [
    {
      metricId: 'hit_at_k',
      version: RETRIEVAL_METRIC_VERSION,
      category: 'retrieval',
      displayLabel: METRIC_DISPLAY_LABELS.hit_at_k,
      evaluationUnit: 'document',
      formula: '1 if any b_i = 1 for rank i in 1..k, else 0',
      description:
        'Whether at least one positively graded gold document appears within the first k collapsed documents.',
      edgeCases: RETRIEVAL_EDGE_CASES,
    },
    {
      metricId: 'precision_at_k',
      version: RETRIEVAL_METRIC_VERSION,
      category: 'retrieval',
      displayLabel: METRIC_DISPLAY_LABELS.precision_at_k,
      evaluationUnit: 'document',
      formula: '(sum_{i=1..k} b_i) / k',
      description:
        'Fraction of top-k document slots containing relevant documents. Returning fewer than k documents retains k in the denominator.',
      edgeCases: RETRIEVAL_EDGE_CASES,
    },
    {
      metricId: 'recall_at_k',
      version: RETRIEVAL_METRIC_VERSION,
      category: 'retrieval',
      displayLabel: METRIC_DISPLAY_LABELS.recall_at_k,
      evaluationUnit: 'document',
      formula: '(sum_{i=1..k} b_i) / |R|',
      description:
        'Fraction of all positively graded gold documents retrieved within top-k collapsed documents.',
      edgeCases: RETRIEVAL_EDGE_CASES,
    },
    {
      metricId: 'mrr_at_k',
      version: RETRIEVAL_METRIC_VERSION,
      category: 'retrieval',
      displayLabel: METRIC_DISPLAY_LABELS.mrr_at_k,
      evaluationUnit: 'document',
      formula: '1 / first_positive_rank if <= k, else 0',
      description:
        'Reciprocal rank of the first relevant collapsed document within cutoff k.',
      edgeCases: RETRIEVAL_EDGE_CASES,
    },
    {
      metricId: 'mrr',
      version: RETRIEVAL_METRIC_VERSION,
      category: 'retrieval',
      displayLabel: METRIC_DISPLAY_LABELS.mrr,
      evaluationUnit: 'document',
      formula: '1 / first_positive_rank across evaluated depth, else 0',
      description:
        'Full-depth reciprocal rank evaluated over all collapsed documents within the recorded pipeline retrieval depth.',
      edgeCases: RETRIEVAL_EDGE_CASES,
    },
    {
      metricId: 'ndcg_at_k',
      version: RETRIEVAL_METRIC_VERSION,
      category: 'retrieval',
      displayLabel: METRIC_DISPLAY_LABELS.ndcg_at_k,
      evaluationUnit: 'document',
      formula: 'DCG@k / IDCG@k, where DCG = sum (2^g_i - 1) / log2(i + 1)',
      description:
        'Normalized discounted cumulative gain over graded relevance labels (0-3), divided by the ideal ordering of all positive gold grades through k.',
      edgeCases: RETRIEVAL_EDGE_CASES,
    },
  ];

  const judgeDescriptions: Record<keyof typeof rubrics, string> = {
    faithfulness:
      'Decomposes the answer into atomic factual claims and verifies each claim against quoted context passages with validated chunk IDs.',
    answer_relevance:
      'Grades how directly the answer addresses the question on an anchored 0-4 scale, normalized by 4.',
    context_precision:
      'Labels every delivered passage useful or irrelevant to answering the question (displayed as Judged passage usefulness).',
    context_recall:
      'Checks each reviewed atomic reference fact against delivered context passages with validated chunk IDs.',
    answer_correctness:
      'Compares the answer against reviewed reference facts and acceptance criteria, tracking omissions and critical contradictions.',
  };

  const judgeEdgeCases = [
    'Malformed JSON, schema mismatch, unresolved evidence chunk IDs, timeout, or judge refusal record null observations with explicit status and completionRate.',
    'One bounded repair attempt is permitted for malformed/unresolved judge responses; both attempts are retained in judge_attempts.',
    'Judge prompts are blinded to pipeline identity and receive only the inputs required for that rubric.',
  ];

  const judgeDocs: MetricDefinitionDoc[] = (
    Object.values(rubrics) as Array<(typeof rubrics)[keyof typeof rubrics]>
  ).map((rubric) => ({
    metricId: rubric.metricId,
    version: rubric.version,
    category: 'judge',
    displayLabel: rubric.displayLabel,
    evaluationUnit: rubric.evaluationUnit,
    formula: rubric.aggregationRule,
    description: judgeDescriptions[rubric.metricId],
    edgeCases: judgeEdgeCases,
    anchors: rubric.anchors,
    passPolicy: rubric.passPolicy,
    rubricHash: rubric.hash,
  }));

  const abstentionDocs: MetricDefinitionDoc[] = [
    {
      metricId: 'abstention_answerable',
      version: ABSTENTION_METRIC_VERSION,
      category: 'abstention',
      displayLabel: METRIC_DISPLAY_LABELS.abstention_answerable,
      evaluationUnit: 'task',
      formula: '1 if answerable task did not abstain, else 0',
      description:
        'Measures whether the pipeline attempts to answer tasks labeled answerable, reported separately from unanswerable abstention accuracy.',
      edgeCases: ['Failed generation -> status generation_failed, value null.'],
    },
    {
      metricId: 'abstention_unanswerable',
      version: ABSTENTION_METRIC_VERSION,
      category: 'abstention',
      displayLabel: METRIC_DISPLAY_LABELS.abstention_unanswerable,
      evaluationUnit: 'task',
      formula: '1 if unanswerable task abstained, else 0',
      description:
        'Measures whether the pipeline abstains when the task is labeled unanswerable, preventing excessive abstention from inflating answer coverage.',
      edgeCases: ['Failed generation -> status generation_failed, value null.'],
    },
  ];

  return [...retrievalDocs, ...judgeDocs, ...abstentionDocs];
}

export function buildDocumentationPayload(
  config: Config,
  workerOnline: boolean,
): DocumentationPayload {
  return documentationPayload.parse({
    softwareVersion: SOFTWARE_VERSION,
    capabilities: {
      ...config.capabilities,
      workerOnline,
    },
    limits: {
      jsonLimitBytes: config.env.JSON_LIMIT_BYTES,
      documentLimitBytes: config.env.DOCUMENT_LIMIT_BYTES,
      rateLimit: config.env.RATE_LIMIT,
      rateWindowMs: config.env.RATE_WINDOW_MS,
      providerTimeoutMs: config.env.PROVIDER_TIMEOUT_MS,
      embedBatchSize: config.env.EMBED_BATCH_SIZE,
      workerLeaseMs: config.env.WORKER_LEASE_MS,
      runMaxTokens: config.budgets.maxTokens,
      runMaxCostUsd: config.budgets.maxCostUsd,
    },
    pricing: {
      version: config.pricing.version,
      currency: config.pricing.currency,
      configuredModels: Array.from(
        new Set(config.pricing.entries.map((entry) => entry.model)),
      ).sort(),
    },
    ingestion: {
      localFormats: ['.txt', '.md', '.markdown', '.pdf (text layer)'],
      cloudFormats: ['.pdf (scanned/OCR)', '.docx (via optional LlamaParse)'],
      chunkingStrategies: [
        {
          id: 'character-window',
          name: 'Character window',
          description:
            'Fixed-size sliding character windows with overlap and stable offset-derived chunk IDs.',
        },
        {
          id: 'sentence-packed',
          name: 'Sentence packed',
          description:
            'Packs whole sentences up to the target chunk size while preserving exact source offsets.',
        },
        {
          id: 'heading-aware',
          name: 'Heading aware',
          description:
            'Splits along Markdown/document heading boundaries before windowing long sections.',
        },
        {
          id: 'table-aware',
          name: 'Table aware',
          description:
            'Keeps tabular blocks intact where possible and splits oversized tables by rows.',
        },
      ],
      chunkSizeRange: { min: 100, max: 1000 },
      overlapRange: { min: 0, max: 50 },
    },
    retrieval: {
      modes: [
        {
          id: 'keyword',
          name: 'Keyword (SQLite FTS5 BM25)',
          description:
            'Offline full-text lexical search scoped to a single immutable index generation. Requires zero API keys or external services.',
          requiresDenseStore: false,
          requiresEmbeddingProfile: false,
        },
        {
          id: 'dense',
          name: 'Dense (Qdrant cosine)',
          description:
            'Vector similarity search in Qdrant with mandatory generation, dataset, and revision filters.',
          requiresDenseStore: true,
          requiresEmbeddingProfile: true,
        },
        {
          id: 'hybrid',
          name: 'Hybrid (RRF fusion)',
          description:
            'Retrieves bounded candidate depths from both SQLite FTS5 and Qdrant under identical filters, then fuses rankings by reciprocal rank.',
          requiresDenseStore: true,
          requiresEmbeddingProfile: true,
        },
      ],
      rrfFormula:
        'score(d) = sum(weight_s / (60 + rank_s(d))), tie-broken by stable chunk ID',
      rerankFailurePolicies: [
        {
          id: 'fail',
          description:
            'Fail the retrieval step explicitly if the configured HTTP reranker errors or returns malformed indices.',
        },
        {
          id: 'fallback',
          description:
            'Keep pre-rerank candidate ordering and record rerankStatus=fallback with the safe error message.',
        },
      ],
    },
    evaluation: {
      promptVersion: PROMPT_VERSION,
      retrievalMetricVersion: RETRIEVAL_METRIC_VERSION,
      abstentionMetricVersion: ABSTENTION_METRIC_VERSION,
      comparisonRule:
        'Paired comparisons align on identical taskVersionId, dataset revision, metric version, evaluation unit, and cutoff. Judge deltas additionally require identical judge provider/model/settings and rubric version. Incompatible runs remain inspectable side by side with incompatibilities highlighted, and no winner is declared from unpaired averages.',
      resamplingRule: describeResamplingRule(),
      metrics: buildMetricDocs(),
    },
  });
}
