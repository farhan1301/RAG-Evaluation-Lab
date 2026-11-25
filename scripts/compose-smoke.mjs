// End-to-end API + static-UI smoke check for the packaged single-origin stack.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(
  baseUrl,
  fetchImpl,
  timeoutMs = 60_000,
  pollIntervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unreachable';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${baseUrl}/health/ready`);
      if (response.ok) {
        const body = await response.json();
        if (body?.status === 'ok') return;
        lastStatus = JSON.stringify(body);
      } else {
        lastStatus = `HTTP ${response.status}`;
      }
    } catch (err) {
      lastStatus = err instanceof Error ? err.message : String(err);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for ${baseUrl}/health/ready (last: ${lastStatus}).`,
  );
}

async function requestJson(baseUrl, fetchImpl, path, init = {}) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  return { status: response.status, headers: response.headers, data };
}

export async function runComposeSmoke(
  baseUrl = process.env.BASE_URL || 'http://127.0.0.1:7070',
  options = {},
) {
  const normalizedBase = baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const runTimeoutMs = options.runTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  await waitForReady(normalizedBase, fetchImpl, readyTimeoutMs, pollIntervalMs);

  // Verify single-origin static frontend + SPA fallback.
  for (const pagePath of ['/', '/datasets']) {
    const res = await fetchImpl(`${normalizedBase}${pagePath}`);
    assert.equal(res.status, 200, `Expected 200 for ${pagePath}`);
    assert.match(
      res.headers.get('content-type') ?? '',
      /text\/html/i,
      `Expected text/html for ${pagePath}`,
    );
    const html = await res.text();
    assert.ok(
      html.includes('id="root"'),
      `Expected SPA root markup for ${pagePath}`,
    );
  }

  // Verify worker online and zero-API-key readiness.
  const caps = await requestJson(
    normalizedBase,
    fetchImpl,
    '/api/v1/capabilities',
  );
  assert.equal(caps.status, 200);
  assert.equal(caps.data.workerOnline, true);

  // Load the labeled sample dataset idempotently.
  const sample = await requestJson(
    normalizedBase,
    fetchImpl,
    '/api/v1/datasets/sample',
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
  assert.ok(
    sample.status === 200 || sample.status === 201,
    `Expected 200/201 loading sample, got ${sample.status}`,
  );
  const datasetId = sample.data.id;
  assert.ok(datasetId, 'Missing sample dataset id');
  assert.equal(sample.data.documents.length, 3);
  assert.equal(sample.data.tasks.length, 10);

  // Create two keyword retrieval pipelines to compare.
  const baseline = await requestJson(
    normalizedBase,
    fetchImpl,
    '/api/v1/pipelines',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'Smoke Baseline (topK=5)',
        config: {
          retriever: { mode: 'keyword', topK: 5 },
        },
      }),
    },
  );
  assert.equal(baseline.status, 201);

  const candidate = await requestJson(
    normalizedBase,
    fetchImpl,
    '/api/v1/pipelines',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'Smoke Candidate (topK=1)',
        config: {
          retriever: { mode: 'keyword', topK: 1 },
        },
      }),
    },
  );
  assert.equal(candidate.status, 201);

  // Create and execute a retrieval-only experiment.
  const experiment = await requestJson(
    normalizedBase,
    fetchImpl,
    '/api/v1/experiments',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'Compose Smoke Comparison',
        datasetId,
        baselinePipelineId: baseline.data.id,
        pipelineIds: [baseline.data.id, candidate.data.id],
        mode: 'retrieval_only',
      }),
    },
  );
  assert.equal(experiment.status, 201);

  const started = await requestJson(
    normalizedBase,
    fetchImpl,
    `/api/v1/experiments/${experiment.data.id}/runs`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
  assert.equal(started.status, 202);
  const runId = started.data.run.id;
  assert.ok(runId, 'Missing run id');

  // Poll until the worker finishes the run.
  const deadline = Date.now() + runTimeoutMs;
  let run = started.data.run;
  while (!['succeeded', 'failed', 'cancelled'].includes(run.state)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for run ${runId} (state=${run.state}, stage=${run.stage}).`,
      );
    }
    await sleep(pollIntervalMs);
    const poll = await requestJson(
      normalizedBase,
      fetchImpl,
      `/api/v1/runs/${runId}`,
    );
    assert.equal(poll.status, 200);
    run = poll.data;
  }

  assert.equal(
    run.state,
    'succeeded',
    `Run ${runId} did not succeed: ${run.state} (${run.errorMessage ?? 'no error'})`,
  );
  assert.equal(run.failedUnits, 0);
  assert.equal(run.completedUnits, run.totalUnits);
  assert.equal(run.pipelines.length, 2);

  for (const pipeline of run.pipelines) {
    const ndcg5 = pipeline.retrievalMetrics.find(
      (m) => m.metricId === 'ndcg_at_k' && m.cutoff === 5,
    );
    assert.ok(ndcg5, `Missing nDCG@5 for pipeline ${pipeline.pipelineName}`);
    assert.equal(typeof ndcg5.mean, 'number');
    assert.ok(ndcg5.eligibleCount > 0);
  }

  // Verify paired comparison and Markdown export.
  const cmpQuery = new URLSearchParams({
    baselineRunId: runId,
    baselinePipelineId: baseline.data.id,
    candidateRunId: runId,
    candidatePipelineId: candidate.data.id,
  });
  const comparison = await requestJson(
    normalizedBase,
    fetchImpl,
    `/api/v1/comparisons?${cmpQuery.toString()}`,
  );
  assert.equal(comparison.status, 200);
  assert.ok(comparison.data.metrics.length > 0);

  const mdExport = await fetchImpl(
    `${normalizedBase}/api/v1/runs/${runId}/export?format=markdown`,
  );
  assert.equal(mdExport.status, 200);
  assert.match(mdExport.headers.get('content-type') ?? '', /text\/markdown/i);
  const mdBody = await mdExport.text();
  assert.ok(mdBody.includes(runId));
  assert.ok(mdBody.includes('Smoke Baseline (topK=5)'));

  return {
    datasetId,
    experimentId: experiment.data.id,
    runId,
    state: run.state,
    completedUnits: run.completedUnits,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await runComposeSmoke();
  console.log(JSON.stringify({ status: 'ok', ...result }, null, 2));
}
