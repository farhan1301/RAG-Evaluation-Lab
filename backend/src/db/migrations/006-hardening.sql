CREATE TABLE generation_source_artifacts (
  generation_id TEXT NOT NULL REFERENCES index_generations(id),
  document_version_id TEXT NOT NULL REFERENCES document_versions(id),
  artifact_id TEXT REFERENCES parse_artifacts(id),
  PRIMARY KEY (generation_id, document_version_id)
) STRICT;

ALTER TABLE generation_batch_documents ADD COLUMN artifact_id TEXT REFERENCES parse_artifacts(id);
