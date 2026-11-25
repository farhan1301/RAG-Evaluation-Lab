-- Inline bytes remain readable for the seed and for existing Phase 3 revisions.
ALTER TABLE document_versions ADD COLUMN blob_key TEXT;
ALTER TABLE document_versions ADD COLUMN byte_size INTEGER;

CREATE TABLE parse_artifacts (
  id TEXT PRIMARY KEY, document_hash TEXT NOT NULL, parser_version TEXT NOT NULL,
  text TEXT NOT NULL, pages TEXT NOT NULL CHECK(json_valid(pages))
) STRICT;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES document_versions,
  parser TEXT NOT NULL CHECK(parser IN ('local','llama-parse')),
  state TEXT NOT NULL CHECK(state IN ('queued','running','cancellation_requested','cancelled','succeeded','failed')),
  stage TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, token INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL DEFAULT 0, eligible INTEGER NOT NULL, deadline INTEGER NOT NULL,
  message TEXT, parent_id TEXT UNIQUE REFERENCES jobs, artifact_id TEXT REFERENCES parse_artifacts,
  chunk_config TEXT CHECK(chunk_config IS NULL OR json_valid(chunk_config)),
  request_key TEXT UNIQUE, request_hash TEXT
) STRICT;
CREATE INDEX job_claim ON jobs(state,eligible,expires);
CREATE INDEX document_jobs ON jobs(version_id);
CREATE TABLE job_steps (
  job_id TEXT NOT NULL REFERENCES jobs, stage TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(job_id,stage)
) STRICT;
CREATE TABLE job_events (
  seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs, state TEXT NOT NULL,
  stage TEXT NOT NULL, time INTEGER NOT NULL, message TEXT
) STRICT;
CREATE INDEX job_history ON job_events(job_id,seq);
CREATE TABLE chunks (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES parse_artifacts,
  strategy TEXT NOT NULL, chunk_size INTEGER NOT NULL, overlap INTEGER NOT NULL,
  ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  page INTEGER NOT NULL, hash TEXT NOT NULL
) STRICT;
CREATE INDEX artifact_chunks ON chunks(artifact_id,strategy,chunk_size,overlap,ordinal);
CREATE TABLE worker_presence (id INTEGER PRIMARY KEY CHECK(id=1), seen INTEGER NOT NULL) STRICT;
