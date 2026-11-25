CREATE TABLE generation_batches (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  dataset_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'cancellation_requested', 'cancelled', 'succeeded', 'failed')),
  stage TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('openai', 'openai-compatible', 'anthropic', 'http')),
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  params TEXT NOT NULL CHECK(json_valid(params)),
  total_documents INTEGER NOT NULL DEFAULT 0 CHECK(total_documents >= 0),
  processed_documents INTEGER NOT NULL DEFAULT 0 CHECK(processed_documents >= 0),
  proposed_count INTEGER NOT NULL DEFAULT 0 CHECK(proposed_count >= 0),
  deduplicated_count INTEGER NOT NULL DEFAULT 0 CHECK(deduplicated_count >= 0),
  invalid_span_count INTEGER NOT NULL DEFAULT 0 CHECK(invalid_span_count >= 0),
  leakage_flagged_count INTEGER NOT NULL DEFAULT 0 CHECK(leakage_flagged_count >= 0),
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  request_key TEXT UNIQUE,
  request_hash TEXT,
  FOREIGN KEY (dataset_id, dataset_revision) REFERENCES dataset_revisions(dataset_id, revision)
) STRICT;
CREATE INDEX generation_batches_dataset ON generation_batches(dataset_id, created_at DESC, id DESC);

CREATE TABLE generation_batch_documents (
  batch_id TEXT NOT NULL REFERENCES generation_batches(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  document_name TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  state TEXT NOT NULL CHECK(state IN ('pending', 'succeeded', 'failed', 'cancelled')),
  raw_response_hash TEXT,
  request_id TEXT,
  error_message TEXT,
  PRIMARY KEY (batch_id, document_version_id)
) STRICT;
CREATE INDEX generation_batch_documents_order ON generation_batch_documents(batch_id, ordinal);

CREATE TABLE synthetic_proposals (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES generation_batches(id),
  dataset_id TEXT NOT NULL,
  dataset_revision INTEGER NOT NULL,
  question TEXT NOT NULL,
  normalized_question TEXT NOT NULL,
  expected_answer TEXT NOT NULL,
  acceptance_rule TEXT NOT NULL,
  reference_facts TEXT NOT NULL CHECK(json_valid(reference_facts)),
  answerable INTEGER NOT NULL CHECK(answerable IN (0, 1)),
  source_spans TEXT NOT NULL CHECK(json_valid(source_spans)),
  qrels TEXT NOT NULL CHECK(json_valid(qrels)),
  provenance TEXT NOT NULL CHECK(json_valid(provenance)),
  leakage_score REAL NOT NULL CHECK(leakage_score >= 0 AND leakage_score <= 1),
  leakage_flagged INTEGER NOT NULL CHECK(leakage_flagged IN (0, 1)),
  leakage_reason TEXT,
  review_status TEXT NOT NULL CHECK(review_status IN ('pending', 'accepted', 'rejected', 'promoted')),
  edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0, 1)),
  promoted_task_id TEXT REFERENCES tasks(id),
  promoted_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dataset_id, dataset_revision) REFERENCES dataset_revisions(dataset_id, revision)
) STRICT;
CREATE INDEX synthetic_proposals_dataset ON synthetic_proposals(dataset_id, review_status, created_at DESC, id ASC);
CREATE INDEX synthetic_proposals_batch ON synthetic_proposals(batch_id, created_at ASC, id ASC);
CREATE INDEX synthetic_proposals_norm_q ON synthetic_proposals(dataset_id, normalized_question);

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES generation_batches(id),
  state TEXT NOT NULL CHECK(state IN ('queued','running','cancellation_requested','cancelled','succeeded','failed')),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  token INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  message TEXT,
  parent_id TEXT UNIQUE REFERENCES generation_jobs(id),
  request_key TEXT UNIQUE,
  request_hash TEXT
) STRICT;
CREATE INDEX generation_job_claim ON generation_jobs(state, eligible, expires);
CREATE INDEX generation_job_batch ON generation_jobs(batch_id);

CREATE TABLE generation_job_events (
  seq INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES generation_jobs(id),
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  time INTEGER NOT NULL,
  message TEXT
) STRICT;
CREATE INDEX generation_job_history ON generation_job_events(job_id, seq);
