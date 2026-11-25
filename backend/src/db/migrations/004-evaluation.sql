CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  baseline_pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  pipeline_ids TEXT NOT NULL CHECK(json_valid(pipeline_ids)),
  mode TEXT NOT NULL CHECK(mode IN ('retrieval_only', 'full_rag')),
  config TEXT NOT NULL CHECK(json_valid(config)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX experiments_list ON experiments(archived, id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('retrieval_only', 'full_rag')),
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'cancellation_requested', 'cancelled', 'succeeded', 'failed')),
  stage TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  dataset_revision INTEGER NOT NULL,
  baseline_pipeline_id TEXT NOT NULL,
  baseline_pipeline_revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  queue_wait_ms INTEGER CHECK(queue_wait_ms IS NULL OR queue_wait_ms >= 0),
  wall_clock_ms INTEGER CHECK(wall_clock_ms IS NULL OR wall_clock_ms >= 0),
  total_units INTEGER NOT NULL DEFAULT 0 CHECK(total_units >= 0),
  completed_units INTEGER NOT NULL DEFAULT 0 CHECK(completed_units >= 0),
  failed_units INTEGER NOT NULL DEFAULT 0 CHECK(failed_units >= 0),
  error_message TEXT,
  request_key TEXT UNIQUE,
  request_hash TEXT,
  FOREIGN KEY (dataset_id, dataset_revision) REFERENCES dataset_revisions(dataset_id, revision),
  FOREIGN KEY (baseline_pipeline_id, baseline_pipeline_revision) REFERENCES pipeline_revisions(pipeline_id, revision)
) STRICT;
CREATE INDEX runs_history ON runs(queued_at DESC, id DESC);
CREATE INDEX runs_experiment ON runs(experiment_id, queued_at DESC, id DESC);

CREATE TABLE run_pipelines (
  run_id TEXT NOT NULL REFERENCES runs(id),
  pipeline_id TEXT NOT NULL,
  pipeline_revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  pipeline_name TEXT NOT NULL,
  is_baseline INTEGER NOT NULL CHECK(is_baseline IN (0, 1)),
  config TEXT NOT NULL CHECK(json_valid(config)),
  config_hash TEXT NOT NULL,
  resolved_models TEXT NOT NULL CHECK(json_valid(resolved_models)),
  index_generation_id TEXT REFERENCES index_generations(id),
  index_reused INTEGER NOT NULL DEFAULT 0 CHECK(index_reused IN (0, 1)),
  index_time_ms INTEGER CHECK(index_time_ms IS NULL OR index_time_ms >= 0),
  state TEXT NOT NULL CHECK(state IN ('queued', 'indexing', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  error_message TEXT,
  PRIMARY KEY (run_id, pipeline_id),
  FOREIGN KEY (pipeline_id, pipeline_revision) REFERENCES pipeline_revisions(pipeline_id, revision)
) STRICT;
CREATE INDEX run_pipelines_order ON run_pipelines(run_id, ordinal);

CREATE TABLE run_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  pipeline_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  retrieval_key TEXT,
  answer_key TEXT,
  retrieval_state TEXT NOT NULL CHECK(retrieval_state IN ('pending', 'succeeded', 'failed', 'skipped')),
  answer_state TEXT NOT NULL CHECK(answer_state IN ('pending', 'succeeded', 'failed', 'skipped')),
  judge_state TEXT NOT NULL CHECK(judge_state IN ('pending', 'succeeded', 'partial', 'failed', 'skipped')),
  state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  retrieval_latency_ms INTEGER CHECK(retrieval_latency_ms IS NULL OR retrieval_latency_ms >= 0),
  rerank_latency_ms INTEGER CHECK(rerank_latency_ms IS NULL OR rerank_latency_ms >= 0),
  generation_latency_ms INTEGER CHECK(generation_latency_ms IS NULL OR generation_latency_ms >= 0),
  judge_latency_ms INTEGER CHECK(judge_latency_ms IS NULL OR judge_latency_ms >= 0),
  serving_latency_ms INTEGER CHECK(serving_latency_ms IS NULL OR serving_latency_ms >= 0),
  retrieved_depth INTEGER CHECK(retrieved_depth IS NULL OR retrieved_depth >= 0),
  retrieved_count INTEGER CHECK(retrieved_count IS NULL OR retrieved_count >= 0),
  rerank_status TEXT CHECK(rerank_status IS NULL OR rerank_status IN ('skipped', 'applied', 'fallback')),
  rerank_error TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (run_id, pipeline_id, task_version_id),
  FOREIGN KEY (run_id, pipeline_id) REFERENCES run_pipelines(run_id, pipeline_id)
) STRICT;
CREATE INDEX run_tasks_lookup ON run_tasks(run_id, pipeline_id, ordinal);
CREATE INDEX run_tasks_task ON run_tasks(run_id, task_id);
CREATE INDEX run_tasks_keys ON run_tasks(run_id, retrieval_key, answer_key);

CREATE TABLE retrieved_items (
  run_task_id TEXT NOT NULL REFERENCES run_tasks(id),
  chunk_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id),
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  document_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  start INTEGER NOT NULL CHECK(start >= 0),
  end INTEGER NOT NULL CHECK(end >= 0),
  page INTEGER NOT NULL CHECK(page > 0),
  content TEXT NOT NULL,
  keyword_rank INTEGER,
  keyword_score REAL,
  dense_rank INTEGER,
  dense_score REAL,
  fused_rank INTEGER,
  fused_score REAL,
  rerank_rank INTEGER,
  rerank_score REAL,
  final_rank INTEGER NOT NULL CHECK(final_rank > 0),
  final_score REAL NOT NULL,
  PRIMARY KEY (run_task_id, final_rank),
  UNIQUE (run_task_id, chunk_id)
) STRICT;
CREATE INDEX retrieved_items_task ON retrieved_items(run_task_id, final_rank);

CREATE TABLE answers (
  run_task_id TEXT PRIMARY KEY REFERENCES run_tasks(id),
  answer_text TEXT NOT NULL,
  abstained INTEGER NOT NULL CHECK(abstained IN (0, 1)),
  citations TEXT NOT NULL CHECK(json_valid(citations)),
  invalid_citations TEXT NOT NULL CHECK(json_valid(invalid_citations)),
  context TEXT NOT NULL CHECK(json_valid(context)),
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effective_params TEXT NOT NULL CHECK(json_valid(effective_params)),
  request_id TEXT,
  latency_ms INTEGER NOT NULL CHECK(latency_ms >= 0),
  reused_from_run_task_id TEXT REFERENCES run_tasks(id)
) STRICT;

CREATE TABLE judge_attempts (
  id TEXT PRIMARY KEY,
  run_task_id TEXT NOT NULL REFERENCES run_tasks(id),
  metric_id TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  is_repair INTEGER NOT NULL DEFAULT 0 CHECK(is_repair IN (0, 1)),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effective_params TEXT NOT NULL CHECK(json_valid(effective_params)),
  status TEXT NOT NULL CHECK(status IN ('succeeded', 'malformed', 'refused', 'timeout', 'upstream_failure', 'unresolved_evidence', 'missing_prerequisite')),
  reason TEXT,
  raw_response_hash TEXT,
  parsed_output TEXT CHECK(parsed_output IS NULL OR json_valid(parsed_output)),
  score REAL,
  request_id TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK(latency_ms >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (run_task_id, metric_id, rubric_version, attempt_number)
) STRICT;
CREATE INDEX judge_attempts_task ON judge_attempts(run_task_id, metric_id, attempt_number);

CREATE TABLE metric_observations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  pipeline_id TEXT NOT NULL,
  task_version_id TEXT NOT NULL REFERENCES task_versions(id),
  run_task_id TEXT NOT NULL REFERENCES run_tasks(id),
  metric_id TEXT NOT NULL,
  metric_version TEXT NOT NULL,
  cutoff INTEGER NOT NULL DEFAULT 0 CHECK(cutoff >= 0),
  evaluation_unit TEXT NOT NULL CHECK(evaluation_unit IN ('document', 'chunk', 'answer', 'passage', 'reference_fact', 'task')),
  status TEXT NOT NULL CHECK(status IN ('scored', 'no_relevant_docs', 'unanswerable', 'missing_qrels', 'missing_reference_facts', 'retrieval_failed', 'generation_failed', 'judge_malformed', 'judge_refused', 'judge_timeout', 'judge_failed', 'unresolved_evidence', 'not_applicable', 'skipped')),
  value REAL,
  reason TEXT,
  metadata TEXT CHECK(metadata IS NULL OR json_valid(metadata)),
  judge_attempt_id TEXT REFERENCES judge_attempts(id),
  CHECK((status = 'scored' AND value IS NOT NULL) OR (status != 'scored' AND value IS NULL)),
  UNIQUE (run_id, pipeline_id, task_version_id, metric_id, metric_version, cutoff, evaluation_unit),
  FOREIGN KEY (run_id, pipeline_id) REFERENCES run_pipelines(run_id, pipeline_id)
) STRICT;
CREATE INDEX metric_obs_lookup ON metric_observations(run_id, pipeline_id, metric_id, cutoff);
CREATE INDEX metric_obs_task ON metric_observations(run_task_id);

CREATE TABLE provider_calls (
  id TEXT PRIMARY KEY,
  stage_key TEXT NOT NULL UNIQUE,
  run_id TEXT REFERENCES runs(id),
  pipeline_id TEXT,
  run_task_id TEXT REFERENCES run_tasks(id),
  index_generation_id TEXT REFERENCES index_generations(id),
  operation TEXT NOT NULL CHECK(operation IN ('corpus_embed', 'query_embed', 'rerank', 'generate', 'judge')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_id TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number > 0),
  is_retry INTEGER NOT NULL DEFAULT 0 CHECK(is_retry IN (0, 1)),
  status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'timeout', 'cancelled', 'ambiguous')),
  error_code TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK(latency_ms >= 0),
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens INTEGER CHECK(cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens >= 0),
  usage_status TEXT NOT NULL CHECK(usage_status IN ('known', 'missing')),
  price_version TEXT NOT NULL,
  cost_status TEXT NOT NULL CHECK(cost_status IN ('known', 'unknown')),
  cost_usd REAL,
  created_at TEXT NOT NULL,
  CHECK((cost_status = 'known' AND cost_usd IS NOT NULL AND cost_usd >= 0) OR (cost_status = 'unknown' AND cost_usd IS NULL))
) STRICT;
CREATE INDEX provider_calls_run ON provider_calls(run_id, operation, is_retry);
CREATE INDEX provider_calls_task ON provider_calls(run_task_id);

CREATE TABLE run_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  state TEXT NOT NULL CHECK(state IN ('queued','running','cancellation_requested','cancelled','succeeded','failed')),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  token INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  message TEXT,
  parent_id TEXT UNIQUE REFERENCES run_jobs(id),
  request_key TEXT UNIQUE,
  request_hash TEXT
) STRICT;
CREATE INDEX run_job_claim ON run_jobs(state, eligible, expires);
CREATE INDEX run_job_run ON run_jobs(run_id);

CREATE TABLE run_job_events (
  seq INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES run_jobs(id),
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  time INTEGER NOT NULL,
  message TEXT
) STRICT;
CREATE INDEX run_job_history ON run_job_events(job_id, seq);
