CREATE TABLE datasets (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  seed TEXT,
  FOREIGN KEY (id,revision) REFERENCES dataset_revisions(dataset_id,revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX active_seed ON datasets(seed) WHERE archived=0;
CREATE TABLE dataset_revisions (
  dataset_id TEXT NOT NULL REFERENCES datasets, revision INTEGER NOT NULL CHECK(revision > 0),
  name TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(dataset_id,revision)
) STRICT;
CREATE TABLE documents (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets) STRICT;
CREATE TABLE document_versions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents, name TEXT NOT NULL,
  mime_type TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL, is_text INTEGER NOT NULL
) STRICT;
CREATE TABLE revision_documents (
  dataset_id TEXT NOT NULL, revision INTEGER NOT NULL, version_id TEXT NOT NULL REFERENCES document_versions,
  PRIMARY KEY(dataset_id,revision,version_id),
  FOREIGN KEY(dataset_id,revision) REFERENCES dataset_revisions
) STRICT;
CREATE TABLE tasks (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets) STRICT;
CREATE TABLE task_versions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks, fields TEXT NOT NULL CHECK(json_valid(fields)),
  pool TEXT NOT NULL CHECK(pool IN ('complete','partial'))
) STRICT;
CREATE TABLE revision_tasks (
  dataset_id TEXT NOT NULL, revision INTEGER NOT NULL, version_id TEXT NOT NULL REFERENCES task_versions,
  PRIMARY KEY(dataset_id,revision,version_id),
  FOREIGN KEY(dataset_id,revision) REFERENCES dataset_revisions
) STRICT;
CREATE TABLE qrels (
  task_version TEXT NOT NULL REFERENCES task_versions, document_version TEXT NOT NULL REFERENCES document_versions,
  grade INTEGER NOT NULL CHECK(grade BETWEEN 0 AND 3), PRIMARY KEY(task_version,document_version)
) STRICT;
CREATE TABLE pipelines (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (id,revision) REFERENCES pipeline_revisions(pipeline_id,revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE pipeline_revisions (
  pipeline_id TEXT NOT NULL REFERENCES pipelines, revision INTEGER NOT NULL CHECK(revision > 0),
  name TEXT NOT NULL, description TEXT NOT NULL, config TEXT NOT NULL CHECK(json_valid(config)),
  hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(pipeline_id,revision)
) STRICT;
