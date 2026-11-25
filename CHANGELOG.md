# Changelog

All notable changes to RAG Evaluation Lab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-25

Complete v1.0.0 rewrite establishing a reproducible, self-hosted RAG evaluation workbench backed by SQLite, a durable worker queue, auditable deterministic and structured-judge metrics, and single-origin Docker packaging.

### Added

- **Monorepo & Toolchain:** Consolidated into npm workspaces (`packages/contracts`, `backend`, `frontend`) with shared Zod wire contracts, strict TypeScript 7, Biome formatting/linting, Vitest unit/integration tests, Playwright browser E2E tests, and pinned GitHub Actions CI across Node 22.22.3 and 26.13.1.
- **SQLite Persistence & Revisions:** Authoritative `node:sqlite` WAL database with versioned SQL migrations (`PRAGMA user_version`) storing immutable dataset revisions, document versions, tasks, graded document-level qrels (`0–3`), pipeline revisions with optimistic concurrency (`ETag` / `If-Match`), and frozen experiment run snapshots.
- **Durable Background Worker:** SQLite-backed job queue (`parse`, `index`, `run`, `generate`) with leases, fencing tokens, heartbeats, resumable checkpoints, cooperative cancellation, linked retries, and reconnectable event polling (`/api/v1/jobs/:id/events`).
- **Ingestion & Chunking:** Bounded streamed uploads into opaque private blob storage with media/content validation (including bounded DOCX container inspection), offline local parsing for TXT, Markdown, and text-layer PDFs (`unpdf`), resumable LlamaParse cloud parsing, and four deterministic chunking strategies (`character-window`, `sentence-packed`, `heading-aware`, `table-aware`) with exact UTF-16 source offsets.
- **Providers & Hybrid Retrieval:** Server-side provider registry supporting OpenAI, Anthropic, local OpenAI-compatible endpoints (such as Ollama for zero-cloud-account dense/hybrid retrieval and local chat/judge), and an operator-configured HTTP reranker with `fail`/`fallback` policies. Added offline SQLite FTS5 BM25 keyword search, dimension-scoped Qdrant dense retrieval with fail-closed generation/dataset/revision filters, Reciprocal Rank Fusion (RRF), metadata filtering, and an interactive retrieval preview.
- **Auditable Evaluation & Reporting:** Deterministic document-level retrieval metrics (`Hit@k`, `Precision@k`, `Recall@k`, `MRR@k`, full-depth `MRR`, `nDCG@k`), five versioned structured LLM-judge rubrics (Faithfulness, Answer relevance, Judged passage usefulness / context precision, Judged context recall, Answer correctness), separate answerable/unanswerable abstention tracking, strict null-on-failure handling with one bounded repair attempt, actual provider token/cost tracking with explicit operator price schedules (unknown prices remain `unknown`), nearest-rank `p50`/`p95` latency stats, paired comparisons with seeded task-level bootstrap CIs, saved run History, Markdown/JSON exports, paginated print/PDF reports, and configuration-derived in-app documentation.
- **Synthetic Test-Set Generation:** Cancellable background proposal generation from frozen document revisions with strict source-span verification, question/span deduplication, verbatim leakage detection that blocks promotion until paraphrased, and explicit human review/promotion into new dataset revisions with full provenance.
- **Frontend Application Shell:** Migrated to React 19, Vite 8, Tailwind CSS 4, React Router 8, and TanStack Query 5 with addressable deep links, accessible keyboard navigation, responsive layout, system/light/dark theme persistence, and server capability status.
- **Packaging, Recovery & Security:** Multi-stage `Dockerfile` on pinned Node 26 (`trixie-slim`) with non-root runtime user, `compose.yaml` (`app`, `worker`, optional `dense` profile `qdrant`), single-origin production static asset + SPA fallback serving, online SQLite + blobs backup/restore CLIs (`npm run backup`, `npm run restore`), Qdrant vector rebuild CLI (`npm run rebuild:qdrant`), `HOST`/`TRUSTED_HOSTS`/`CORS_ORIGINS`/`TRUSTED_PROXIES` enforcement, structured Pino log redaction, Compose CI smoke job, and MIT `LICENSE`.

### Changed

- Removed hard-coded model IDs from application code; all chat, judge, embedding, and rerank model IDs are configured via environment profiles and per-pipeline overrides.
- Bound development servers to loopback (`127.0.0.1`) by default and removed all frontend API-key paths and direct proxy routes.

### Removed

- Removed all 0.x stateless `/api/*` endpoints (`POST /api/parse`, `POST /api/chunks`, `POST /api/search`, `POST /api/answer`, `POST /api/judge`) with no compatibility layer.
- Removed browser-side chunking, client-side experiment orchestration, client-side metric recomputation, handwritten single-page PDF generation, temporary transition adapters, dead UI wrappers (`ComingSoonPage`, Figma fallbacks, placeholder profile/key forms), and committed `node_modules/` directories.
- Removed private and unverified demo links from documentation.

### Upgrading from 0.x

v1.0.0 is a clean breaking release with no compatibility layer for 0.x routes:

- **New SQLite database:** 0.x kept datasets, pipelines, and run results in browser tab memory only, so there is no legacy database to migrate. Start v1.0.0 with a fresh `DATABASE_PATH` (and optional `BLOB_DIRECTORY`, or fresh Compose named volume).
- **Re-index corpora:** Upload documents through `/api/v1/datasets/:id/documents` (or load the built-in sample dataset via `POST /api/v1/datasets/sample`) and build immutable index generations. Offline keyword retrieval (SQLite FTS5 BM25) works immediately with zero API keys.
- **Existing Qdrant vectors untouched:** v1.0.0 writes dense vectors into dimension-scoped collections keyed by immutable `generationId`, `datasetId`, and `datasetRevision`. Pre-existing 0.x Qdrant collections are never modified or deleted automatically.
- **Removed `/api/*` routes:** Update any scripts calling `/api/{parse,chunks,search,answer,judge}` to use the versioned `/api/v1` endpoints documented in `README.md`.
- **Previously exported reports:** Keep any Markdown/PDF files exported from 0.x as legacy artifacts with their original labels; v1.0.0 exports use persisted server-side observations via `GET /api/v1/runs/:id/export` and paginated browser print CSS.
