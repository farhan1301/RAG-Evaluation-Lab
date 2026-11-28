import {
  runExportJson,
  type ComparisonResult,
  type CostBucket,
  type RunExportJson,
  type RunExportQuery,
  type RunTaskDetail,
} from '@rag-eval/contracts';
import type { Runs } from '../db/runs.js';
import { compareRunPipelines } from './compare.js';

function formatNumber(value: number | null, digits = 3): string {
  return value === null ? 'Unavailable' : value.toFixed(digits);
}

function formatDelta(value: number | null): string {
  if (value === null) return 'Not comparable';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(3)}`;
}

function formatMs(value: number | null): string {
  return value === null ? 'Unavailable' : `${Math.round(value)} ms`;
}

function formatCostBucket(bucket: CostBucket): string {
  if (bucket.status === 'zero') return '$0.0000';
  if (bucket.status === 'known' && bucket.totalUsd !== null) {
    return `$${bucket.totalUsd.toFixed(4)}`;
  }
  if (bucket.status === 'partial') {
    return `$${bucket.knownUsd.toFixed(4)} partial (${bucket.pricedCalls}/${bucket.totalCalls} priced)`;
  }
  return `Unknown (${bucket.totalCalls} unpriced)`;
}

/**
 * Collapses line breaks in free text (names, questions, model answers, judge
 * reasons) so it cannot start new Markdown headings, list items, or table rows.
 * The JSON export keeps the original text verbatim.
 */
function inline(value: string): string {
  return value.replace(/[ \t]*(?:\r\n|\r|\n)\s*/g, ' ').trim();
}

function escapeCell(value: string): string {
  return inline(value).replaceAll('|', '\\|');
}

function renderTaskSideEvidence(
  label: string,
  task: RunTaskDetail | null,
): string[] {
  const lines: string[] = [`#### ${inline(label)}`];
  if (!task) {
    lines.push('_Task not present on this side._', '');
    return lines;
  }
  lines.push(
    `- State: ${task.state} (retrieval: ${task.retrievalState}, answer: ${task.answerState}, judge: ${task.judgeState})`,
  );
  if (task.servingLatencyMs !== null) {
    lines.push(`- Serving latency: ${Math.round(task.servingLatencyMs)} ms`);
  }
  if (task.answer) {
    lines.push(
      `- Answer (${task.answer.provider}/${task.answer.model}${task.answer.abstained ? ', abstained' : ''}): ${inline(task.answer.answerText)}`,
    );
    lines.push(
      `- Validated citations: ${task.answer.citations.length > 0 ? task.answer.citations.join(', ') : 'None'}`,
    );
    if (task.answer.invalidCitations.length > 0) {
      lines.push(
        `- Rejected citations: ${inline(task.answer.invalidCitations.join(', '))}`,
      );
    }
  }
  if (task.retrievedItems.length > 0) {
    lines.push(
      `- Retrieved passages (${task.retrievedItems.length}, depth ${task.retrievedDepth ?? task.retrievedItems.length}):`,
    );
    for (const item of task.retrievedItems) {
      const stages = [
        item.keywordRank !== null ? `kw #${item.keywordRank}` : null,
        item.denseRank !== null ? `dense #${item.denseRank}` : null,
        item.fusedRank !== null ? `fused #${item.fusedRank}` : null,
        item.rerankRank !== null ? `rerank #${item.rerankRank}` : null,
      ].filter(Boolean);
      const snippet = item.content.replace(/\s+/g, ' ').slice(0, 180);
      lines.push(
        `  - #${item.finalRank} ${item.documentName} (p.${item.page}, score ${item.finalScore.toFixed(4)}${stages.length ? `, ${stages.join(', ')}` : ''}): ${snippet}`,
      );
    }
  } else {
    lines.push('- Retrieved passages: None');
  }
  if (task.judgeAttempts.length > 0) {
    lines.push('- Judge audit trail:');
    for (const attempt of task.judgeAttempts) {
      lines.push(
        `  - ${attempt.metricId} (${attempt.rubricVersion}, attempt #${attempt.attemptNumber}${attempt.isRepair ? ' repair' : ''}, ${attempt.model}): ${attempt.status}${attempt.score !== null ? `, score ${attempt.score.toFixed(3)}` : ''}${attempt.reason ? ` — ${inline(attempt.reason)}` : ''}`,
      );
    }
  }
  lines.push('');
  return lines;
}

export function buildRunExportJson(
  runs: Runs,
  runId: string,
  query: RunExportQuery,
  now = Date.now,
): RunExportJson {
  const run = runs.getRun(runId);
  const tasks = runs.listAllRunTasks(runId);

  const comparisons: ComparisonResult[] = [];
  const basePipelineId =
    query.baselinePipelineId ??
    run.baselinePipelineId ??
    run.pipelines[0]?.pipelineId;

  if (query.compareRunId && basePipelineId) {
    const compareRun = runs.getRun(query.compareRunId);
    const candPipelineId =
      query.comparePipelineId ??
      query.candidatePipelineId ??
      compareRun.baselinePipelineId ??
      compareRun.pipelines[0]?.pipelineId;
    if (candPipelineId) {
      comparisons.push(
        compareRunPipelines(runs, {
          baselineRunId: run.id,
          baselinePipelineId: basePipelineId,
          candidateRunId: compareRun.id,
          candidatePipelineId: candPipelineId,
          bootstrapSamples: query.bootstrapSamples,
          seed: query.seed,
        }),
      );
    }
  } else if (query.candidatePipelineId && basePipelineId) {
    comparisons.push(
      compareRunPipelines(runs, {
        baselineRunId: run.id,
        baselinePipelineId: basePipelineId,
        candidateRunId: run.id,
        candidatePipelineId: query.candidatePipelineId,
        bootstrapSamples: query.bootstrapSamples,
        seed: query.seed,
      }),
    );
  } else if (basePipelineId) {
    for (const candidate of run.pipelines) {
      if (candidate.pipelineId === basePipelineId) continue;
      comparisons.push(
        compareRunPipelines(runs, {
          baselineRunId: run.id,
          baselinePipelineId: basePipelineId,
          candidateRunId: run.id,
          candidatePipelineId: candidate.pipelineId,
          bootstrapSamples: query.bootstrapSamples,
          seed: query.seed,
        }),
      );
    }
  }

  return runExportJson.parse({
    schemaVersion: 1,
    exportedAt: new Date(now()).toISOString(),
    run,
    comparisons,
    tasks,
  });
}

export function formatRunExportMarkdown(payload: RunExportJson): string {
  const { run, comparisons, tasks } = payload;
  const lines: string[] = [
    `# ${inline(run.name)}`,
    '',
    `- Run ID: \`${run.id}\``,
    `- State: ${run.state} (stage: ${run.stage})`,
    `- Dataset: ${inline(run.datasetName)} (revision ${run.datasetRevision})`,
    `- Mode: ${run.mode} · Judge enabled: ${run.snapshot.judgeEnabled ? 'yes' : 'no'}`,
    `- Queued: ${run.queuedAt}${run.completedAt ? ` · Completed: ${run.completedAt}` : ''}`,
    `- Snapshot versions: software ${run.snapshot.softwareVersion}, retrieval ${run.snapshot.retrievalMetricVersion}, prompt ${run.snapshot.promptVersion}, pricing ${run.snapshot.priceScheduleVersion}`,
    `- Cutoffs: ${run.snapshot.cutoffs.join(', ')}`,
    '',
    '## Pipeline Comparison Overview',
    '',
  ];

  const metricKeys = Array.from(
    new Map(
      run.pipelines
        .flatMap((p) => [
          ...p.retrievalMetrics,
          ...p.judgeMetrics,
          ...p.abstentionMetrics,
        ])
        .map((m) => [`${m.metricId}:${m.cutoff}:${m.evaluationUnit}`, m]),
    ).values(),
  );

  const overviewHeaders = [
    'Pipeline',
    'State',
    ...metricKeys.map((m) => m.displayLabel),
    'Serving p50 / p95',
    'Eval p50 / p95',
    'Total spend',
    'Retry spend',
  ];
  lines.push(`| ${overviewHeaders.map(escapeCell).join(' | ')} |`);
  lines.push(`| ${overviewHeaders.map(() => '---').join(' | ')} |`);

  for (const pl of run.pipelines) {
    const lookup = new Map(
      [...pl.retrievalMetrics, ...pl.judgeMetrics, ...pl.abstentionMetrics].map(
        (m) => [`${m.metricId}:${m.cutoff}:${m.evaluationUnit}`, m],
      ),
    );
    const metricCells = metricKeys.map((m) => {
      const entry = lookup.get(`${m.metricId}:${m.cutoff}:${m.evaluationUnit}`);
      if (!entry) return 'Unavailable';
      const partialNote =
        entry.hasPartialPool && entry.meanJudgedCoverage !== null
          ? `, pooled ${Math.round(entry.meanJudgedCoverage * 100)}% judged`
          : '';
      return `${formatNumber(entry.mean)} (${entry.eligibleCount}/${entry.totalCount}${partialNote})`;
    });
    const row = [
      pl.isBaseline ? `${pl.pipelineName} (Baseline)` : pl.pipelineName,
      `${pl.state} (${pl.completedTasks}/${pl.totalTasks})`,
      ...metricCells,
      `${formatMs(pl.latency.serving.p50Ms)} / ${formatMs(pl.latency.serving.p95Ms)} (n=${pl.latency.serving.sampleSize})`,
      `${formatMs(pl.latency.evaluation.p50Ms)} / ${formatMs(pl.latency.evaluation.p95Ms)} (n=${pl.latency.evaluation.sampleSize})`,
      formatCostBucket(pl.cost.total),
      formatCostBucket(pl.cost.retry),
    ];
    lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
  }

  lines.push(
    '',
    '## Spend and Latency Summary',
    '',
    `- Indexing spend: ${formatCostBucket(run.cost.indexing)}`,
    `- Serving spend: ${formatCostBucket(run.cost.serving)} (per-query: ${run.cost.perQueryServing.usdPerQuery !== null ? `$${run.cost.perQueryServing.usdPerQuery.toFixed(6)}` : run.cost.perQueryServing.status})`,
    `- Judging spend: ${formatCostBucket(run.cost.judging)}`,
    `- Retry spend: ${formatCostBucket(run.cost.retry)} (${run.tokens.retryTokens.toLocaleString()} retry tokens)`,
    `- Total spend: ${formatCostBucket(run.cost.total)} (${run.tokens.totalTokens.toLocaleString()} total tokens)`,
    `- Queue wait: ${formatMs(run.latency.queueWaitMs)} · Wall clock: ${formatMs(run.latency.wallClockMs)} · Timeouts: ${run.latency.timeoutCount} · Cancellations: ${run.latency.cancellationCount}`,
    '',
  );

  for (const comp of comparisons) {
    lines.push(
      `## Paired Comparison: ${inline(comp.baseline.pipelineName)} (Baseline) vs ${inline(comp.candidate.pipelineName)}`,
      '',
      `- Baseline: ${inline(comp.baseline.runName)} · ${inline(comp.baseline.pipelineName)} (r${comp.baseline.pipelineRevision}, dataset r${comp.baseline.datasetRevision})`,
      `- Candidate: ${inline(comp.candidate.runName)} · ${inline(comp.candidate.pipelineName)} (r${comp.candidate.pipelineRevision}, dataset r${comp.candidate.datasetRevision})`,
      `- Resampling rule: ${comp.resamplingRule.description}`,
      '',
    );

    if (comp.incompatibilities.length > 0) {
      lines.push('### Compatibility Warnings', '');
      for (const issue of comp.incompatibilities) {
        lines.push(
          `- **${issue.field}** (${issue.scope}): baseline \`${inline(issue.baselineValue)}\` vs candidate \`${inline(issue.candidateValue)}\` — ${inline(issue.reason)}`,
        );
      }
      lines.push('');
    }

    if (comp.configDiff.length > 0) {
      lines.push(
        '### Configuration Differences',
        '',
        '| Field | Baseline | Candidate |',
        '| --- | --- | --- |',
      );
      for (const diff of comp.configDiff) {
        lines.push(
          `| ${escapeCell(diff.path)} | ${escapeCell(JSON.stringify(diff.baseline))} | ${escapeCell(JSON.stringify(diff.candidate))} |`,
        );
      }
      lines.push('');
    }

    lines.push(
      '### Paired Metric Deltas',
      '',
      '| Metric | Baseline (paired) | Candidate (paired) | Delta | Direction | Paired / Missing | 95% Paired Bootstrap CI |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const metric of comp.metrics) {
      const ciCell = metric.bootstrapCi
        ? `[${formatDelta(metric.bootstrapCi.lower)}, ${formatDelta(metric.bootstrapCi.upper)}]`
        : (metric.bootstrapNote ?? 'Unavailable');
      lines.push(
        `| ${[
          metric.displayLabel,
          formatNumber(metric.baselineMean),
          formatNumber(metric.candidateMean),
          formatDelta(metric.absoluteDelta),
          metric.direction,
          `${metric.pairedCount} / ${metric.missingPairs}`,
          ciCell,
        ]
          .map(escapeCell)
          .join(' | ')} |`,
      );
    }
    lines.push('');

    lines.push('### Per-Task Side-by-Side Evidence', '');
    for (const task of comp.tasks) {
      lines.push(
        `### Q${task.ordinal + 1}: ${inline(task.question)}${task.differs ? ' [Differs]' : ''}`,
        '',
        `- Answerable: ${task.answerable ? 'yes' : 'no'} · Pool: ${task.pool}${task.differenceSummary.length ? ` · Differences: ${task.differenceSummary.join('; ')}` : ''}`,
        '',
      );
      if (task.metricDeltas.length > 0) {
        lines.push(
          '| Metric | Baseline | Candidate | Delta |',
          '| --- | --- | --- | --- |',
        );
        for (const md of task.metricDeltas) {
          lines.push(
            `| ${[
              md.displayLabel,
              md.baselineValue !== null
                ? md.baselineValue.toFixed(3)
                : `Unavailable (${md.baselineStatus ?? 'missing'})`,
              md.candidateValue !== null
                ? md.candidateValue.toFixed(3)
                : `Unavailable (${md.candidateStatus ?? 'missing'})`,
              md.comparable ? formatDelta(md.delta) : 'Not comparable',
            ]
              .map(escapeCell)
              .join(' | ')} |`,
          );
        }
        lines.push('');
      }
      lines.push(
        ...renderTaskSideEvidence(
          `Baseline — ${comp.baseline.pipelineName}`,
          task.baseline,
        ),
      );
      lines.push(
        ...renderTaskSideEvidence(
          `Candidate — ${comp.candidate.pipelineName}`,
          task.candidate,
        ),
      );
    }
  }

  if (comparisons.length === 0 && tasks.length > 0) {
    lines.push('## Per-Task Evidence', '');
    for (const task of tasks) {
      lines.push(
        `### Q${task.ordinal + 1} (${inline(task.pipelineName)}): ${inline(task.question)}`,
        '',
      );
      lines.push(...renderTaskSideEvidence(task.pipelineName, task));
    }
  }

  return lines.join('\n');
}
