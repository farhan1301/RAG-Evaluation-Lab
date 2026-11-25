CREATE TABLE generation_source_artifacts (
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  artifact_id TEXT REFERENCES parse_artifacts(id),
  PRIMARY KEY (generation_id, document_version_id)
) STRICT;

ALTER TABLE generation_batch_documents ADD COLUMN artifact_id TEXT REFERENCES parse_artifacts(id);
ALTER TABLE provider_calls ADD COLUMN job_id TEXT;
CREATE INDEX provider_calls_job ON provider_calls(run_id, run_task_id, operation, job_id);
ALTER TABLE index_generations ADD COLUMN embedding_endpoint TEXT;
ALTER TABLE generation_batches ADD COLUMN provider_endpoint TEXT;
ALTER TABLE generation_batches ADD COLUMN artifact_pin_version INTEGER NOT NULL DEFAULT 0;
