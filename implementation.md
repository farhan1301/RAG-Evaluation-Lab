# Implementation Overview

This document summarizes the backend and frontend work that powers the Retrieval-Augmented Generation (RAG) Evaluation Lab, along with open follow-ups to consider.

---

## Backend (`/backend`)

### Goals
- Provide an Express + TypeScript façade that keeps OpenAI, Qdrant, and LlamaParse credentials out of the browser.
- Offer a complete RAG evaluation pipeline: ingest documents, embed chunks, retrieve context, draft answers, and judge responses.
- Centralize configuration, logging, and CORS controls so the frontend and backend share a consistent runtime story.

### Key Components
| Location | Description |
| --- | --- |
| `package.json`, `tsconfig.json` | Node/TypeScript project scaffolding (ES modules, `tsx` dev runner, `tsc` build). |
| `src/lib/config.ts` | Loads env vars (merging `.env` + `.env.local`) and normalizes defaults for OpenAI, Qdrant, and LlamaParse. |
| `src/lib/logger.ts` | Thin wrappers around `console` that add structured metadata for traceability. |
| `src/lib/openaiClient.ts` | Embedding + chat helpers that surface latency, token usage, and configurable models. |
| `src/lib/qdrantClient.ts` | Handles collection bootstrapping, point upserts, and similarity search against Qdrant. |
| `src/lib/llamaParseClient.ts` | Uploads documents to LlamaParse, polls job status, normalizes markdown/text responses, and extracts page counts. |
| `src/routes/embeddings.ts` | `POST /api/chunks` – embeds chunk payloads and upserts them into Qdrant collections. |
| `src/routes/search.ts` | `POST /api/search` – embeds a query and returns scored matches. |
| `src/routes/answer.ts` | `POST /api/answer` – runs retrieval + answer synthesis and relays token/cost metadata. |
| `src/routes/judge.ts` | `POST /api/judge` – prompts an evaluator model and aggregates per-task scores. |
| `src/routes/parse.ts` | `POST /api/parse` – forwards files to LlamaParse, handles transient errors, and returns normalized text. |
| `src/index.ts` | Configures env loading, CORS (via `CORS_ORIGINS`), JSON body limits, and mounts all routes plus `/health`. |

### Runtime Expectations
- Required env vars: `OPENAI_API_KEY`, `QDRANT_URL`, and either `LLAMA_CLOUD_API_KEY` or `LLAMA_PARSE_API_KEY` if the parse endpoint should be available. Optional overrides include `OPENAI_EMBED_MODEL`, `OPENAI_CHAT_MODEL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `LLAMA_CLOUD_BASE_URL`, `PORT`, and `CORS_ORIGINS`.
- Env layering: `.env` is loaded first, then `.env.local` (when present) can override per-developer secrets. `.env.example` documents every key.
- CORS: `CORS_ORIGINS` accepts a comma-delimited allow list. The server blocks unknown origins unless `*` is present.
- JSON payload limit: 16 MB, covering large document uploads while preventing accidental OOMs.
- Start locally via `npm install && npm run dev` (hot reload with `tsx`). Production build uses `npm run build && npm start`.

### Notable Behaviors
- All external calls (OpenAI, Qdrant, LlamaParse) bubble errors with descriptive messages, helping the frontend display actionable feedback.
- LlamaParse integration includes retry/backoff for uploads/downloads and normalizes heterogeneous payload formats into a consistent `{ text, pageCount }` shape.
- Judge responses request JSON-formatted output and coerce scores into the 0–1 range, ensuring downstream metrics stay bounded.

---

## Frontend (`/frontend`)

### Goals
- Provide a multi-step workspace for dataset ingestion, pipeline configuration, experiment execution, and results analysis.
- Persist experiment state within React context so datasets, pipelines, and results stay synchronized across pages.
- Surface richer guidance via in-app documentation, experiment history, and settings scaffolding.

### Key Modules & Screens
| Location | Highlights |
| --- | --- |
| `src/state/dataset.tsx` | Context + hooks for uploaded documents, parsed text, and evaluation tasks (with sample data seeding). |
| `src/state/pipelines.tsx` | Manages pipeline definitions, baseline selection, and reusable defaults. |
| `src/state/experimentResults.tsx` | Tracks experiment stage, status log, chunk previews, per-task results, judge details, and the latest `ExperimentRun`. |
| `src/lib/chunking.ts` | Chunking strategies (recursive/semantic/layout/table), summarization helpers, and metadata normalization. |
| `src/lib/backend.ts` | Fetch utilities for `/api/parse`, `/api/chunks`, `/api/search`, `/api/answer`, and `/api/judge`, including error parsing. |
| `src/components/DatasetsPage.tsx` | File ingestion pipeline: upload → LlamaParse → chunk preview, plus task management UI. |
| `src/components/PipelinesPage.tsx` | Configure chunking, embedding, retrieval, reranker, answer, and judge parameters across multiple pipelines. |
| `src/components/ExperimentsPage.tsx` | Orchestrates the end-to-end run, displays progress, aggregates metrics/costs, and persists results via context. |
| `src/components/ReportsPage.tsx` | Visualizes the most recent `ExperimentRun`, including metric summaries, per-question breakdowns, and cost analysis. |
| `src/components/HistoryPage.tsx` | Presentational scaffolding for browsing previous experiments (currently seeded with placeholder data). |
| `src/components/DocumentationPage.tsx` | Rich in-app documentation with copy-to-clipboard code snippets and workflow guidance. |
| `src/components/SettingsPage.tsx` | UX shell for future account/API key management (forms and toggles are presently static). |
| `src/main.tsx` | Binds the dataset, pipeline, and experiment providers so every screen shares the same state. |

### Experiment Pipeline Logic
1. **Prerequisites:** Ensure at least one parsed document and task exist. The UI prevents runs when prerequisites are missing.
2. **Parsing:** New uploads hit `/api/parse`, returning normalized markdown and page counts while showing chunk previews.
3. **Chunking:** `chunkDocumentsWithConfig` slices content according to the active pipeline strategy; `summarizeChunkGroups` produces quick stats for the report.
4. **Upsert:** `/api/chunks` embeds every chunk and writes them to the pipeline’s target Qdrant collection (optionally overriding the collection name).
5. **Answering:** For each task and pipeline, `/api/answer` performs retrieval + LLM synthesis, returning cited matches, latency, and token usage.
6. **Judging:** The collected answers feed `/api/judge`, which yields per-task scores (relevance, context precision, groundedness), rationales, and token/latency metrics.
7. **Metrics & Costing:** `ExperimentsPage` aggregates scores, computes percentiles, and estimates spend via `estimateEmbeddingCost` / `estimateChatCost` tables.
8. **Persistence:** A normalized `ExperimentRun` (with chunk summaries, metrics, answers, judge details) is stored in context for Reports, History, and Documentation pages.

---

## Remaining / Optional Work
- **Authentication & Authorization:** Lock down backend routes (API keys, session middleware) before exposing beyond localhost.
- **Experiment Persistence:** Replace History placeholders with real storage (backend API, database, or local export/import).
- **Streaming Feedback:** Consider SSE/websocket progress updates instead of polling to show real-time pipeline stages.
- **Error Handling Enhancements:** Support per-task retries, file-level failure recovery, and richer frontend error surfaces.
- **Testing & Observability:** Add unit/integration coverage for backend clients/routes and instrument structured logs/telemetry.
- **Multi-pipeline Comparisons:** Persist and visualize side-by-side metrics when multiple pipelines run in a single experiment.
- **Deployment Tooling:** Docker images, CI workflows, and environment templates for staging/production readiness.

---

## Critical Gaps
- LlamaParse is optional, but the `/api/parse` route returns `503` when no API key is configured; the UI should communicate this clearly in production.
- Experiment history and settings screens are currently static; wiring them to real persistence remains on the roadmap.
- There is no rate limiting or auth guard on backend endpoints yet, so external deployments require additional hardening.

---

## Quick Usage Recap
1. **Configure Env:** `cp .env.example .env.local`, then populate OpenAI, Qdrant, and LlamaParse credentials.
2. **Backend:** `cd backend && npm install && npm run dev` (or `npm run build && npm start` for production).
3. **Frontend:** `cd frontend && npm install && npm run dev` (ensure `VITE_BACKEND_URL` points to the backend).
4. **Workflow:** Upload documents → define tasks → configure pipelines → run experiment → review reports/history/documentation.

This captures the current implementation status and the main opportunities for enhancement. Let me know if you’d like to dive deeper into any specific area.
