# API Transition Notes (0.x to v1.0.0)

Prepared for the Phase 8 `CHANGELOG.md` ("Upgrading from 0.x") release notes.

## Breaking API Changes

RAG Evaluation Lab v1.0.0 removes the 0.x stateless `/api/*` endpoints and browser-side experiment orchestration with no compatibility layer:

- Removed legacy routes:
  - `POST /api/parse`
  - `POST /api/chunks`
  - `POST /api/search`
  - `POST /api/answer`
  - `POST /api/judge`
- Removed temporary transition adapters and browser-side metric/PDF utilities:
  - `backend/src/http/legacy.ts` and `backend/src/routes/{answer,embeddings,judge,search}.ts`
  - `frontend/src/data/legacyRunner.ts`, `frontend/src/lib/backend.ts`, and `frontend/src/types/{dataset,experiment,pipeline}.ts`
  - Client-side metric recomputation and handwritten PDF generation

All browser and API workflows now use the versioned `/api/v1` contract exclusively:

- Health & capabilities: `GET /health/live`, `GET /health/ready`, `GET /api/v1/capabilities`, `GET /api/v1/documentation`
- Versioned workspace definitions: `/api/v1/datasets`, `/api/v1/datasets/sample`, `/api/v1/datasets/:id/documents`, `/api/v1/datasets/:id/tasks`, `/api/v1/tasks/:id/qrels`, `/api/v1/datasets/:id/task-imports`, `/api/v1/pipelines`, `/api/v1/pipelines/:id/copies`
- Durable jobs & immutable indexes: `/api/v1/jobs/:id`, `/api/v1/jobs/:id/events`, `/api/v1/jobs/:id/cancel`, `/api/v1/jobs/:id/retry`, `/api/v1/indexes`, `/api/v1/indexes/:id/search`, `/api/v1/indexes/:id/answer`
- Server-side experiments, history, comparisons, and exports: `/api/v1/experiments`, `/api/v1/experiments/:id/runs`, `/api/v1/runs`, `/api/v1/runs/:id`, `/api/v1/runs/:id/tasks`, `/api/v1/comparisons`, `/api/v1/runs/:id/export`

## Upgrading from 0.x

- **New SQLite database:** 0.x kept datasets, pipelines, and run results in browser memory only, so there is no persisted legacy run database to migrate. Start v1.0.0 with a fresh `DATABASE_PATH` (and optional `BLOB_DIRECTORY`).
- **Re-index corpora:** Upload documents through `/api/v1/datasets/:id/documents` (or load the built-in sample dataset) and build immutable index generations. Offline keyword retrieval (SQLite FTS5 BM25) works immediately with zero API keys.
- **Existing Qdrant vectors untouched:** v1.0.0 writes dense vectors into dimension-scoped collections keyed by immutable `generationId`, `datasetId`, and `datasetRevision`. Pre-existing 0.x Qdrant collections are never modified or deleted automatically.
- **Previously exported reports:** Keep any Markdown/PDF files exported from 0.x as legacy artifacts with their original labels; v1.0.0 exports use persisted server-side observations via `GET /api/v1/runs/:id/export` and paginated browser print CSS.
