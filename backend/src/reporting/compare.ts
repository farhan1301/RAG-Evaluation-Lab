import {
  comparisonResult,
  type ComparisonIncompatibility,
  type ComparisonQuery,
  type ComparisonResult,
  type ComparisonSide,
  type ConfigDiffEntry,
  type EvaluationUnit,
  type MetricId,
  type MetricObservation,
  type PairedMetricComparison,
  type PairedTaskComparison,
  type PairedTaskMetricDelta,
  type RunDetail,
  type RunPipelineSummary,
  type RunTaskDetail,
} from '@rag-eval/contracts';
import type { Runs } from '../db/runs.js';
import { ApiError } from '../errors.js';
import { metricDisplayLabel } from '../evaluation/metrics.js';
import {
  describeResamplingRule,
  pairedBootstrapInterval,
} from './bootstrap.js';

const RETRIEVAL_METRICS = new Set<MetricId>([
  'hit_at_k',
  'precision_at_k',
  'recall_at_k',
  'mrr_at_k',
  'mrr',
  'ndcg_at_k',
]);

const JUDGE_METRICS = new Set<MetricId>([
  'faithfulness',
  'answer_relevance',
  'context_precision',
  'context_recall',
  'answer_correctness',
]);

const METRIC_ORDER: MetricId[] = [
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

function metricCategory(
  metricId: MetricId,
): 'retrieval' | 'judge' | 'abstention' {
  if (RETRIEVAL_METRICS.has(metricId)) return 'retrieval';
  if (JUDGE_METRICS.has(metricId)) return 'judge';
  return 'abstention';
}

function metricOrderRank(metricId: MetricId): number {
  const idx = METRIC_ORDER.indexOf(metricId);
  return idx === -1 ? 999 : idx;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectDiffs(
  prefix: string,
  left: unknown,
  right: unknown,
  out: ConfigDiffEntry[],
) {
  if (Object.is(left, right)) return;
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Array.from(
      new Set([...Object.keys(left), ...Object.keys(right)]),
    ).sort();
    for (const key of keys) {
      const nextPath = prefix ? `${prefix}.${key}` : key;
      collectDiffs(nextPath, left[key], right[key], out);
    }
    return;
  }
  if (JSON.stringify(left) === JSON.stringify(right)) return;
  out.push({
    path: prefix,
    baseline: left ?? null,
    candidate: right ?? null,
  });
}

export function diffComparisonSides(
  baseline: ComparisonSide,
  candidate: ComparisonSide,
): ConfigDiffEntry[] {
  const diffs: ConfigDiffEntry[] = [];
  collectDiffs(
    'dataset',
    { id: baseline.datasetId, revision: baseline.datasetRevision },
    { id: candidate.datasetId, revision: candidate.datasetRevision },
    diffs,
  );
  collectDiffs(
    'run',
    { mode: baseline.mode, judgeEnabled: baseline.judgeEnabled },
    { mode: candidate.mode, judgeEnabled: candidate.judgeEnabled },
    diffs,
  );
  collectDiffs('config', baseline.config, candidate.config, diffs);
  collectDiffs(
    'resolvedModels',
    baseline.resolvedModels,
    candidate.resolvedModels,
    diffs,
  );
  collectDiffs(
    'versions',
    {
      promptVersion: baseline.promptVersion,
      retrievalMetricVersion: baseline.retrievalMetricVersion,
      rubricVersions: baseline.rubricVersions,
      priceScheduleVersion: baseline.priceScheduleVersion,
    },
    {
      promptVersion: candidate.promptVersion,
      retrievalMetricVersion: candidate.retrievalMetricVersion,
      rubricVersions: candidate.rubricVersions,
      priceScheduleVersion: candidate.priceScheduleVersion,
    },
    diffs,
  );
  return diffs;
}

function toComparisonSide(
  run: RunDetail,
  pipeline: RunPipelineSummary,
): ComparisonSide {
  return {
    runId: run.id,
    runName: run.name,
    runState: run.state,
    mode: run.mode,
    judgeEnabled: run.snapshot.judgeEnabled,
    datasetId: run.datasetId,
    datasetRevision: run.datasetRevision,
    datasetName: run.datasetName,
    queuedAt: run.queuedAt,
    completedAt: run.completedAt,
    pipelineId: pipeline.pipelineId,
    pipelineRevision: pipeline.pipelineRevision,
    pipelineName: pipeline.pipelineName,
    isBaseline: pipeline.isBaseline,
    config: pipeline.config,
    configHash: pipeline.configHash,
    resolvedModels: pipeline.resolvedModels,
    promptVersion: run.snapshot.promptVersion,
    retrievalMetricVersion: run.snapshot.retrievalMetricVersion,
    rubricVersions: run.snapshot.rubricVersions,
    priceScheduleVersion: run.snapshot.priceScheduleVersion,
    state: pipeline.state,
    completedTasks: pipeline.completedTasks,
    failedTasks: pipeline.failedTasks,
    totalTasks: pipeline.totalTasks,
    latency: pipeline.latency,
    cost: pipeline.cost,
    tokens: pipeline.tokens,
  };
}

function findPipelineOrThrow(
  run: RunDetail,
  pipelineId: string,
  label: string,
) {
  const found = run.pipelines.find((p) => p.pipelineId === pipelineId);
  if (!found) {
    throw new ApiError(
      404,
      'not_found',
      `${label} pipeline was not part of the selected run.`,
    );
  }
  return found;
}

function describeJudgeModel(side: ComparisonSide): string {
  const judge = side.resolvedModels.judge;
  if (!side.judgeEnabled || !judge) return 'disabled';
  return `${judge.provider}/${judge.model} (temp=${judge.effectiveTemperature ?? 'default'}, structured=${judge.structuredOutput})`;
}

interface MetricKeySpec {
  key: string;
  metricId: MetricId;
  cutoff: number;
  evaluationUnit: EvaluationUnit;
}

function obsKey(
  obs: Pick<MetricObservation, 'metricId' | 'cutoff' | 'evaluationUnit'>,
) {
  return `${obs.metricId}|${obs.cutoff}|${obs.evaluationUnit}`;
}

export function compareRunPipelines(
  runs: Runs,
  query: ComparisonQuery,
): ComparisonResult {
  const baselineRun = runs.getRun(query.baselineRunId);
  const candidateRun =
    query.candidateRunId === query.baselineRunId
      ? baselineRun
      : runs.getRun(query.candidateRunId);

  const baselinePipeline = findPipelineOrThrow(
    baselineRun,
    query.baselinePipelineId,
    'Baseline',
  );
  const candidatePipeline = findPipelineOrThrow(
    candidateRun,
    query.candidatePipelineId,
    'Candidate',
  );

  const baselineSide = toComparisonSide(baselineRun, baselinePipeline);
  const candidateSide = toComparisonSide(candidateRun, candidatePipeline);

  const incompatibilities: ComparisonIncompatibility[] = [];
  let datasetCompatible = true;
  if (baselineRun.datasetId !== candidateRun.datasetId) {
    datasetCompatible = false;
    incompatibilities.push({
      scope: 'dataset',
      field: 'datasetId',
      baselineValue: `${baselineRun.datasetName} (${baselineRun.datasetId})`,
      candidateValue: `${candidateRun.datasetName} (${candidateRun.datasetId})`,
      reason:
        'Runs evaluated different datasets, so task-level pairing is disabled.',
    });
  } else if (baselineRun.datasetRevision !== candidateRun.datasetRevision) {
    datasetCompatible = false;
    incompatibilities.push({
      scope: 'dataset',
      field: 'datasetRevision',
      baselineValue: `r${baselineRun.datasetRevision}`,
      candidateValue: `r${candidateRun.datasetRevision}`,
      reason:
        'Runs evaluated different dataset revisions, so task-level pairing is disabled.',
    });
  }

  let judgeCompatible = true;
  const judgeReasons: string[] = [];
  const eitherHasJudge =
    baselineSide.judgeEnabled ||
    candidateSide.judgeEnabled ||
    baselinePipeline.judgeMetrics.length > 0 ||
    candidatePipeline.judgeMetrics.length > 0;

  if (eitherHasJudge) {
    if (baselineSide.judgeEnabled !== candidateSide.judgeEnabled) {
      judgeCompatible = false;
      const reason =
        'Judge evaluation was enabled on only one side; judge deltas require matching judge configuration.';
      judgeReasons.push(reason);
      incompatibilities.push({
        scope: 'judge',
        field: 'judgeEnabled',
        baselineValue: String(baselineSide.judgeEnabled),
        candidateValue: String(candidateSide.judgeEnabled),
        reason,
      });
    } else if (
      JSON.stringify(baselineSide.resolvedModels.judge) !==
      JSON.stringify(candidateSide.resolvedModels.judge)
    ) {
      judgeCompatible = false;
      const reason =
        'Judge model or effective settings differ; judge deltas require the same judge configuration.';
      judgeReasons.push(reason);
      incompatibilities.push({
        scope: 'judge',
        field: 'resolvedModels.judge',
        baselineValue: describeJudgeModel(baselineSide),
        candidateValue: describeJudgeModel(candidateSide),
        reason,
      });
    }
  }

  const judgeMetricRubricMismatch = new Map<string, string>();
  if (eitherHasJudge) {
    const rubricKeys = Array.from(
      new Set([
        ...Object.keys(baselineSide.rubricVersions),
        ...Object.keys(candidateSide.rubricVersions),
      ]),
    ).sort();
    for (const metricKey of rubricKeys) {
      const bVer = baselineSide.rubricVersions[metricKey] ?? 'missing';
      const cVer = candidateSide.rubricVersions[metricKey] ?? 'missing';
      if (bVer !== cVer) {
        judgeCompatible = false;
        const reason = `Rubric version for ${metricKey} differs (${bVer} vs ${cVer}).`;
        judgeMetricRubricMismatch.set(metricKey, reason);
        incompatibilities.push({
          scope: 'judge',
          field: `rubricVersions.${metricKey}`,
          baselineValue: bVer,
          candidateValue: cVer,
          reason,
        });
      }
    }
  }

  const baselineTasks = runs.listAllRunTasks(
    baselineRun.id,
    baselinePipeline.pipelineId,
  );
  const candidateTasks = runs.listAllRunTasks(
    candidateRun.id,
    candidatePipeline.pipelineId,
  );

  // Align tasks strictly by taskVersionId when datasets/revisions match.
  // When incompatible, still return side-by-side records so the user can inspect both runs.
  const taskPairs: Array<{
    taskVersionId: string;
    baseline: RunTaskDetail | null;
    candidate: RunTaskDetail | null;
  }> = [];

  if (datasetCompatible) {
    const candidateByVersion = new Map(
      candidateTasks.map((t) => [t.taskVersionId, t]),
    );
    const seenVersions = new Set<string>();
    for (const bTask of baselineTasks) {
      seenVersions.add(bTask.taskVersionId);
      taskPairs.push({
        taskVersionId: bTask.taskVersionId,
        baseline: bTask,
        candidate: candidateByVersion.get(bTask.taskVersionId) ?? null,
      });
    }
    for (const cTask of candidateTasks) {
      if (!seenVersions.has(cTask.taskVersionId)) {
        taskPairs.push({
          taskVersionId: cTask.taskVersionId,
          baseline: null,
          candidate: cTask,
        });
      }
    }
  } else {
    const candidateByVersion = new Map(
      candidateTasks.map((t) => [t.taskVersionId, t]),
    );
    const matched = new Set<string>();
    for (const bTask of baselineTasks) {
      const match = candidateByVersion.get(bTask.taskVersionId) ?? null;
      if (match) matched.add(bTask.taskVersionId);
      taskPairs.push({
        taskVersionId: bTask.taskVersionId,
        baseline: bTask,
        candidate: match,
      });
    }
    for (const cTask of candidateTasks) {
      if (!matched.has(cTask.taskVersionId)) {
        taskPairs.push({
          taskVersionId: cTask.taskVersionId,
          baseline: null,
          candidate: cTask,
        });
      }
    }
  }

  // Collect union of all observed metric definitions (metricId, cutoff, evaluationUnit).
  const metricSpecs = new Map<string, MetricKeySpec>();
  for (const task of [...baselineTasks, ...candidateTasks]) {
    for (const obs of task.observations) {
      const key = obsKey(obs);
      if (!metricSpecs.has(key)) {
        metricSpecs.set(key, {
          key,
          metricId: obs.metricId,
          cutoff: obs.cutoff,
          evaluationUnit: obs.evaluationUnit,
        });
      }
    }
  }

  const orderedMetricSpecs = Array.from(metricSpecs.values()).sort((a, b) => {
    const byMetric = metricOrderRank(a.metricId) - metricOrderRank(b.metricId);
    if (byMetric !== 0) return byMetric;
    if (a.cutoff !== b.cutoff) return a.cutoff - b.cutoff;
    return a.evaluationUnit.localeCompare(b.evaluationUnit);
  });

  const bootstrapOpts = {
    samples: query.bootstrapSamples,
    seed: query.seed,
  };
  const rule = describeResamplingRule(bootstrapOpts);

  const metricCompatibility = new Map<
    string,
    { comparable: boolean; reason: string | null }
  >();

  const metrics: PairedMetricComparison[] = [];

  for (const spec of orderedMetricSpecs) {
    const category = metricCategory(spec.metricId);
    const baselineVersions = new Set<string>();
    const candidateVersions = new Set<string>();

    let baselineOverallSum = 0;
    let baselineEligibleCount = 0;
    let candidateOverallSum = 0;
    let candidateEligibleCount = 0;

    for (const task of baselineTasks) {
      const obs = task.observations.find((o) => obsKey(o) === spec.key);
      if (obs) {
        baselineVersions.add(obs.metricVersion);
        if (obs.status === 'scored' && typeof obs.value === 'number') {
          baselineOverallSum += obs.value;
          baselineEligibleCount += 1;
        }
      }
    }
    for (const task of candidateTasks) {
      const obs = task.observations.find((o) => obsKey(o) === spec.key);
      if (obs) {
        candidateVersions.add(obs.metricVersion);
        if (obs.status === 'scored' && typeof obs.value === 'number') {
          candidateOverallSum += obs.value;
          candidateEligibleCount += 1;
        }
      }
    }

    const baseVersion =
      Array.from(baselineVersions)[0] ??
      Array.from(candidateVersions)[0] ??
      'unknown';
    const candVersion = Array.from(candidateVersions)[0] ?? null;

    let comparable = true;
    let incompatibilityReason: string | null = null;

    if (!datasetCompatible) {
      comparable = false;
      incompatibilityReason =
        'Runs used different datasets or dataset revisions.';
    } else if (
      baselineVersions.size > 0 &&
      candidateVersions.size > 0 &&
      (baselineVersions.size > 1 ||
        candidateVersions.size > 1 ||
        baseVersion !== candVersion)
    ) {
      comparable = false;
      incompatibilityReason = `Metric version differs (${baseVersion} vs ${candVersion ?? 'missing'}).`;
      incompatibilities.push({
        scope: 'metric',
        field: `${spec.metricId}@${spec.cutoff}.metricVersion`,
        baselineValue: baseVersion,
        candidateValue: candVersion ?? 'missing',
        reason: incompatibilityReason,
      });
    } else if (category === 'judge') {
      const specificRubric = judgeMetricRubricMismatch.get(spec.metricId);
      if (specificRubric) {
        comparable = false;
        incompatibilityReason = specificRubric;
      } else if (!judgeCompatible) {
        comparable = false;
        incompatibilityReason =
          judgeReasons[0] ?? 'Judge configuration differs between runs.';
      }
    }

    metricCompatibility.set(spec.key, {
      comparable,
      reason: incompatibilityReason,
    });

    const pairedBaselineVals: number[] = [];
    const pairedCandidateVals: number[] = [];
    const pairedDeltas: number[] = [];

    if (comparable) {
      for (const pair of taskPairs) {
        const bObs = pair.baseline?.observations.find(
          (o) => obsKey(o) === spec.key,
        );
        const cObs = pair.candidate?.observations.find(
          (o) => obsKey(o) === spec.key,
        );
        if (
          bObs &&
          cObs &&
          bObs.metricVersion === cObs.metricVersion &&
          bObs.status === 'scored' &&
          cObs.status === 'scored' &&
          typeof bObs.value === 'number' &&
          typeof cObs.value === 'number'
        ) {
          pairedBaselineVals.push(bObs.value);
          pairedCandidateVals.push(cObs.value);
          pairedDeltas.push(cObs.value - bObs.value);
        }
      }
    }

    const totalTasks = taskPairs.length;
    const pairedCount = pairedDeltas.length;
    const missingPairs = Math.max(0, totalTasks - pairedCount);

    let baselineMean: number | null = null;
    let candidateMean: number | null = null;
    let absoluteDelta: number | null = null;
    let direction: PairedMetricComparison['direction'] = 'not_comparable';
    let bootstrapCi: PairedMetricComparison['bootstrapCi'] = null;
    let bootstrapNote: string | null = null;

    if (comparable && pairedCount > 0) {
      baselineMean =
        pairedBaselineVals.reduce((acc, v) => acc + v, 0) / pairedCount;
      candidateMean =
        pairedCandidateVals.reduce((acc, v) => acc + v, 0) / pairedCount;
      absoluteDelta = pairedDeltas.reduce((acc, v) => acc + v, 0) / pairedCount;
      if (Math.abs(absoluteDelta) < 1e-12) {
        direction = 'unchanged';
        absoluteDelta = 0;
      } else {
        direction = absoluteDelta > 0 ? 'improved' : 'regressed';
      }
      const boot = pairedBootstrapInterval(pairedDeltas, bootstrapOpts);
      bootstrapCi = boot.interval;
      bootstrapNote = boot.note;
    } else {
      bootstrapNote = comparable
        ? 'No paired scored tasks available for this metric.'
        : incompatibilityReason;
    }

    metrics.push({
      metricId: spec.metricId,
      metricVersion: baseVersion,
      candidateMetricVersion: candVersion,
      cutoff: spec.cutoff,
      evaluationUnit: spec.evaluationUnit,
      displayLabel: metricDisplayLabel(spec.metricId, spec.cutoff),
      category,
      comparable,
      incompatibilityReason,
      baselineMean,
      candidateMean,
      baselineOverallMean:
        baselineEligibleCount > 0
          ? baselineOverallSum / baselineEligibleCount
          : null,
      candidateOverallMean:
        candidateEligibleCount > 0
          ? candidateOverallSum / candidateEligibleCount
          : null,
      absoluteDelta,
      direction,
      pairedCount,
      missingPairs,
      baselineEligibleCount,
      candidateEligibleCount,
      totalTasks,
      bootstrapCi,
      bootstrapNote,
    });
  }

  const tasks: PairedTaskComparison[] = taskPairs.map((pair, idx) => {
    const ref = pair.baseline ?? pair.candidate;
    if (!ref) {
      throw new ApiError(
        500,
        'internal_error',
        'Task pair was unexpectedly empty.',
      );
    }

    const metricDeltas: PairedTaskMetricDelta[] = [];
    const differenceSummary: string[] = [];

    for (const spec of orderedMetricSpecs) {
      const bObs =
        pair.baseline?.observations.find((o) => obsKey(o) === spec.key) ?? null;
      const cObs =
        pair.candidate?.observations.find((o) => obsKey(o) === spec.key) ??
        null;
      if (!bObs && !cObs) continue;

      const comp = metricCompatibility.get(spec.key)?.comparable ?? false;
      const delta =
        comp &&
        bObs?.status === 'scored' &&
        cObs?.status === 'scored' &&
        typeof bObs.value === 'number' &&
        typeof cObs.value === 'number'
          ? cObs.value - bObs.value
          : null;

      const displayLabel = metricDisplayLabel(spec.metricId, spec.cutoff);
      metricDeltas.push({
        metricId: spec.metricId,
        metricVersion: bObs?.metricVersion ?? cObs?.metricVersion ?? 'unknown',
        cutoff: spec.cutoff,
        evaluationUnit: spec.evaluationUnit,
        displayLabel,
        comparable: comp,
        baselineStatus: bObs?.status ?? null,
        candidateStatus: cObs?.status ?? null,
        baselineValue: bObs?.value ?? null,
        candidateValue: cObs?.value ?? null,
        delta,
      });

      if (delta !== null && Math.abs(delta) > 1e-9) {
        const sign = delta > 0 ? '+' : '';
        differenceSummary.push(`${displayLabel} (${sign}${delta.toFixed(3)})`);
      } else if (bObs?.status !== cObs?.status) {
        differenceSummary.push(
          `${displayLabel} status (${bObs?.status ?? 'missing'} vs ${cObs?.status ?? 'missing'})`,
        );
      }
    }

    const bChunks = (pair.baseline?.retrievedItems ?? []).map((i) => i.chunkId);
    const cChunks = (pair.candidate?.retrievedItems ?? []).map(
      (i) => i.chunkId,
    );
    if (JSON.stringify(bChunks) !== JSON.stringify(cChunks)) {
      differenceSummary.unshift('Retrieved passages differ');
    }

    const bAnswer = pair.baseline?.answer ?? null;
    const cAnswer = pair.candidate?.answer ?? null;
    if (
      (bAnswer?.answerText ?? '') !== (cAnswer?.answerText ?? '') ||
      Boolean(bAnswer?.abstained) !== Boolean(cAnswer?.abstained) ||
      JSON.stringify(bAnswer?.citations ?? []) !==
        JSON.stringify(cAnswer?.citations ?? [])
    ) {
      differenceSummary.push('Generated answer differs');
    }

    return {
      taskId: ref.taskId,
      taskVersionId: ref.taskVersionId,
      ordinal: pair.baseline?.ordinal ?? pair.candidate?.ordinal ?? idx,
      question: ref.question,
      expectedAnswer: ref.expectedAnswer,
      acceptanceRule: ref.acceptanceRule,
      referenceFacts: ref.referenceFacts,
      answerable: ref.answerable,
      pool: ref.pool,
      qrels: ref.qrels,
      differs: differenceSummary.length > 0,
      differenceSummary,
      baseline: pair.baseline,
      candidate: pair.candidate,
      metricDeltas,
    };
  });

  const configDiff = diffComparisonSides(baselineSide, candidateSide);
  const compatible =
    datasetCompatible &&
    incompatibilities.every((item) => item.scope !== 'dataset');

  return comparisonResult.parse({
    baseline: baselineSide,
    candidate: candidateSide,
    compatible,
    datasetCompatible,
    judgeCompatible,
    incompatibilities,
    configDiff,
    resamplingRule: rule,
    metrics,
    tasks,
  });
}
