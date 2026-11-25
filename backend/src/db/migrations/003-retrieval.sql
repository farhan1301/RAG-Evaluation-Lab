CREATE TABLE index_generations (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  dataset_revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('building', 'ready', 'failed')),
  mode TEXT NOT NULL CHECK(mode IN ('keyword', 'dense', 'hybrid')),
  chunk_config TEXT NOT NULL CHECK(json_valid(chunk_config)),
  embedding_provider TEXT CHECK(embedding_provider IS NULL OR embedding_provider IN ('openai', 'openai-compatible')),
  embedding_model TEXT,
  embedding_dimensions INTEGER CHECK(embedding_dimensions IS NULL OR embedding_dimensions > 0),
  qdrant_collection TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  ready_at TEXT,
  FOREIGN KEY (dataset_id, dataset_revision) REFERENCES dataset_revisions(dataset_id, revision)
) STRICT;
CREATE INDEX index_generations_fingerprint ON index_generations(fingerprint, state);
CREATE INDEX index_generations_dataset ON index_generations(dataset_id, dataset_revision, created_at);

CREATE TABLE generation_chunks (
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  chunk_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id),
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  document_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  page INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (generation_id, chunk_id)
) STRICT;
CREATE INDEX generation_chunks_order ON generation_chunks(generation_id, document_id, ordinal);
CREATE INDEX generation_chunks_filter ON generation_chunks(generation_id, document_id, mime_type, page);

CREATE VIRTUAL TABLE chunk_fts USING fts5(
  content,
  generation_id UNINDEXED,
  chunk_id UNINDEXED,
  tokenize='porter unicode61'
);

CREATE TABLE index_jobs (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  state TEXT NOT NULL CHECK(state IN ('queued','running','cancellation_requested','cancelled','succeeded','failed')),
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  token INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  message TEXT,
  parent_id TEXT UNIQUE REFERENCES index_jobs(id),
  request_key TEXT UNIQUE,
  request_hash TEXT
) STRICT;
CREATE INDEX index_job_claim ON index_jobs(state, eligible, expires);
CREATE INDEX index_job_generation ON index_jobs(generation_id);

CREATE TABLE index_job_events (
  seq INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES index_jobs(id),
  state TEXT NOT NULL,
  stage TEXT NOT NULL,
  time INTEGER NOT NULL,
  message TEXT
) STRICT;
CREATE INDEX index_job_history ON index_job_events(job_id, seq);
