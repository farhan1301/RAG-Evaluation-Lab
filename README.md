# <img src="favicon/favicon-32x32.png" alt="RAG Evaluation Lab icon" width="28" height="28" /> RAG Evaluation Lab

End-to-end workspace for building, running, and evaluating retrieval-augmented generation (RAG) pipelines. The project is split into a `frontend` Vite/React application that orchestrates datasets, pipelines, experiments, reporting, history, documentation, and settings, and a `backend` Express service that handles OpenAI, Qdrant, and LlamaParse integrations.

Click on the image below to open the demo video:

[![Watch Demo](/RAG_Demo_Thumbnail.png)](https://drive.google.com/file/d/1N9gWsj2-VUxENEvvmErER1WbRtXOn-Ph/view?usp=sharing)


## Highlights
- Guided landing page that explains the workflow and links directly into datasets or experiments.
- Rich dataset management: drag-and-drop uploads, status tracking, curated sample datasets, and CSV imports with header alias support.
- Multi-pipeline configuration with baseline selection, duplication, and per-stage controls (parsing, chunking, embeddings, retrieval, reranker placeholder, LLM, judge).
- Experiment runner that auto-parses documents when needed, logs progress, captures latency/token/cost metrics, and persists the latest run.
- Reports dashboard that recommends the leading pipeline, visualizes metric deltas, and exports Markdown or PDF summaries.
- LlamaParse-powered document ingestion guarantees consistent parsing today, with additional techniques (local parsers, OCR) on the roadmap.
- Coming Soon roadmap view to communicate upcoming features (additional models, reranking, dark mode, metrics).

## Repository Layout
- `frontend/` – Vite + React UI with Tailwind styles, Radix components, and feature pages (Home, Datasets, Pipelines, Experiments, Reports, History, Documentation, Settings, Coming Soon).
- `backend/` – TypeScript Express API with OpenAI + Qdrant helpers, LlamaParse ingestion, and evaluation endpoints.
- `backend/scripts/` – TypeScript scripts that smoke-test each API or provision Qdrant indexes (`verify-*.ts`, `setup-qdrant-index.ts`).
- `backend/sample-data/` – Sample assets used by verification scripts or demos.
- `favicon/` – Application icons consumed by the frontend.
- `.env.example` – Template with every environment variable the apps consume.
- `.env.local` – Git-ignored overrides; copy from `.env.example` for local development.

## Prerequisites
- Node.js 18 or newer
- npm 9 or newer
- Qdrant cluster + API key (or local instance)
- OpenAI API key with access to the specified models
- LlamaParse (Llama Cloud) account and API key for document ingestion (required today; additional parsing connectors coming soon)

## Initial Setup
Copy the environment template and install dependencies for each app:

```bash
cp .env.example .env.local
# edit .env.local with real endpoints and secrets
```

```bash
# frontend dependencies
cd frontend
npm install

# backend dependencies
cd ../backend
npm install
```

> **Security reminder:** Never commit real API keys. Keep secrets in `.env.local` (gitignored) or inject them via your shell/secret manager. The backend loads `.env` first (if present) and then `.env.local` so you can layer per-machine overrides.

## Environment Variables
Both apps read environment variables from the repository root. The backend hydrates via `dotenv` and the frontend points Vite to the same directory (`envDir`). Create a safe `.env` (or `.env.local` to override locally) with at least the required keys below; see `.env.example` for the full catalog.

| Variable | Required | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | ✅ | OpenAI account key used for embeddings and chat completions |
| `QDRANT_URL` | ✅ | Base URL for your Qdrant cluster |
| `LLAMA_CLOUD_API_KEY` or `LLAMA_PARSE_API_KEY` | ✅ | API key for LlamaParse document parsing |
| `VITE_BACKEND_URL` | ✅ | Frontend base URL for backend requests |

Frontend-only environment overrides still need the `VITE_` prefix; set them in the root `.env` as well (or `.env.local`) and they will be surfaced to the Vite dev server.

## Running Locally

```bash
# Terminal 1 – frontend
cd frontend
npm run dev
# -> http://localhost:5173

# Terminal 2 – backend
cd backend
npm run dev       # single run
npm run dev:watch # optional: auto-restarts on file changes
```

The backend exposes:
- `GET /health` – Basic readiness probe.
- `POST /api/chunks` – Upsert document chunks with embeddings.
- `POST /api/search` – Vector search against Qdrant.
- `POST /api/answer` – Retrieve context + synthesize an answer via OpenAI.
- `POST /api/judge` – Score generated answers against expected outcomes and context using an LLM evaluator.
- `POST /api/parse` – Send raw files to LlamaParse and return normalized text for downstream chunking.

After an experiment run, the frontend records metrics derived from these judge evaluations. Pass rate, context precision, groundedness, latency, cost, and token usage are all calculated from real model calls rather than heuristics, powering the reports and history views with production-ready quality signals.

## Production Builds

```bash
# Frontend static bundle (outputs to frontend/build)
cd frontend
npm run build

# Backend TypeScript -> dist/
cd ../backend
npm run build
npm run start
```

Deploy the `frontend/build` directory behind a static host or CDN and run the backend Node service behind your API gateway/load balancer.

## Root NPM Shortcuts
From the repository root you can use:

```bash
npm run dev          # alias for frontend dev
npm run dev:frontend # explicit frontend dev
npm run dev:backend  # backend dev (requires env vars)
npm run build        # frontend build
npm run build:backend
```

These scripts proxy into the respective `frontend`/`backend` packages via `npm --prefix`.

## API Smoke Tests
When you want to confirm credentials or infrastructure without running the UI, execute the backend verification scripts:

```bash
cd backend
npx ts-node --swc ./scripts/verify-chunks.ts
npx ts-node --swc ./scripts/verify-search.ts
# ...answer, judge, parse also available
```

`scripts/setup-qdrant-index.ts` helps create the `pipelineId` payload index when Qdrant is freshly provisioned.

## Implementation Overview

This section summarizes the backend and frontend work that powers the Retrieval-Augmented Generation (RAG) Evaluation Lab, along with follow-ups that are still on the roadmap.

### Backend (`/backend`)

#### Goals
- Provide a TypeScript + Express façade that keeps OpenAI, Qdrant, and LlamaParse credentials out of the browser.
- Offer a complete RAG evaluation pipeline: ingest documents, embed chunks, retrieve context, draft answers, judge responses, and expose per-pipeline analytics.
- Centralize configuration, logging, and CORS controls so the frontend and backend share a consistent runtime story, plus scripts that sanity-check each API surface.

#### Key Components
| Location | Description |
| --- | --- |
| `package.json`, `tsconfig.json` | Node/TypeScript scaffolding (ES modules, `tsx` dev runner, `tsc` build output). |
| `src/lib/config.ts` | Loads env vars (merging `.env` + `.env.local`) and maps vector dimensions to per-size Qdrant collections (`QDRANT_COLLECTION_1536`, `QDRANT_COLLECTION_3072`). |
| `src/lib/logger.ts` | Structured logging to both console and `logs/app.log`, with opt-in console suppression for verbose LlamaParse noise. |
| `src/lib/openaiClient.ts` | Embedding + chat helpers that surface latency, token usage, GPT‑5 model quirks, and response-format support. |
| `src/lib/qdrantClient.ts` | Pipeline-aware collection manager (sanitizes names, ensures payload indexes, retries deletes, and filters searches per `pipelineId`). |
| `src/lib/llamaParseClient.ts` | Robust LlamaParse integration: resilient uploads, exponential backoff polling, payload normalization (markdown/text), and page-count extraction. |
| `src/routes/embeddings.ts` | `POST /api/chunks` – embeds chunk payloads, optionally resets collections, wipes prior pipeline vectors, and returns vector dimension metadata. |
| `src/routes/search.ts` | `POST /api/search` – embeds a query, searches the pipeline-specific collection, and exposes the resolved collection + vector size. |
| `src/routes/answer.ts` | `POST /api/answer` – runs retrieval, composes a grounded answer prompt, returns matches/usage/latency, and mirrors the resolved collection metadata. |
| `src/routes/judge.ts` | `POST /api/judge` – coaxes structured JSON verdicts, aggregates pass rate + average scores, and keeps raw per-task rationales. |
| `src/routes/parse.ts` | `POST /api/parse` – forwards files to LlamaParse with detailed logging, returns normalized text + job IDs, and surfaces configuration gaps with `503`s. |
| `src/index.ts` | Loads environment layers, configures strict CORS allowlists, applies JSON size limits, and mounts every route plus `/health`. |
| `scripts/*.ts` | CLI utilities for bootstrapping Qdrant payload indexes and verifying each API surface end-to-end (chunks, search, answer, judge, parse). |

#### Runtime Expectations
- Required env vars: `OPENAI_API_KEY`, `QDRANT_URL`, and either `LLAMA_CLOUD_API_KEY` or `LLAMA_PARSE_API_KEY` if parsing should be enabled.
- Optional overrides: `OPENAI_EMBED_MODEL`, `OPENAI_CHAT_MODEL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`, `QDRANT_COLLECTION_1536`, `QDRANT_COLLECTION_3072`, `LLAMA_CLOUD_BASE_URL`, `PORT`, `CORS_ORIGINS`, and the log toggles `LLAMA_PARSE_CONSOLE_LOGS` / `PARSE_ROUTE_CONSOLE_LOGS`.
- Env layering: `.env` is loaded first, then `.env.local` (when present) can override per-developer secrets. `.env.example` documents every key.
- CORS: `CORS_ORIGINS` accepts a comma-delimited allow list. The server blocks unknown origins unless `*` is present.
- JSON payload limit: 16 MB, covering large document uploads while preventing accidental OOMs.
- Start locally via `npm install && npm run dev` (hot reload with `tsx`). Production build uses `npm run build && npm start`.

#### Notable Behaviors
- Pipeline-aware Qdrant usage keeps embeddings partitioned per experiment configuration while automatically provisioning/cleaning collections and payload indexes.
- All external calls (OpenAI, Qdrant, LlamaParse) bubble errors with descriptive messages, helping the frontend display actionable feedback.
- LlamaParse integration includes retry/backoff for uploads/downloads and normalizes heterogeneous payload formats into a consistent `{ text, pageCount }` shape.
- Judge responses request JSON-formatted output, coerce scores into the 0–1 range, and aggregate latency/tokens for downstream cost analysis.
- `backend/scripts/*` give a quick way to validate credentials and infrastructure without running the full UI.

### Frontend (`/frontend`)

#### Goals
- Provide a multi-step workspace (with a polished landing page) for dataset ingestion, pipeline configuration, experiment execution, and results analysis.
- Persist experiment state within React context so datasets, pipelines, and results stay synchronized across pages.
- Surface richer guidance via in-app documentation, experiment history, roadmap previews, and settings scaffolding.

#### Key Modules & Screens
| Location | Highlights |
| --- | --- |
| `src/App.tsx` | Entry shell with sidebar navigation, workflow helper, quick access to History/Reports, and route scaffolding. |
| `src/state/dataset.tsx` | Context for uploaded documents and evaluation tasks, including sample dataset seeding and CSV import updates. |
| `src/state/pipelines.tsx` | Manages pipeline definitions, baseline selection, duplication, timestamp tracking, and strategy defaults. |
| `src/state/experimentResults.tsx` | Tracks experiment stage, status log, chunk previews, per-task results, judge details, and latest `ExperimentRun`. |
| `src/lib/chunking.ts` | Chunking strategies (recursive/semantic/layout/table), sentence-aware splitting, and chunk statistics helpers. |
| `src/lib/taskCsv.ts` | CSV parser that accepts header aliases, surfaces warnings, and hydrates task lists. |
| `src/lib/backend.ts` | Strongly-typed fetch utilities for `/api/parse`, `/api/chunks`, `/api/search`, `/api/answer`, and `/api/judge`, including error parsing. |
| `src/components/DatasetsPage.tsx` | File ingestion with progress UI, removal, sample dataset loader, and CSV task import feedback. |
| `src/components/PipelinesPage.tsx` | Configure parsing, chunking, embedding, retrieval, reranker (placeholder), LLM, and judge stages per pipeline with expand/collapse controls. |
| `src/components/ExperimentsPage.tsx` | Orchestrates runs across multiple pipelines, auto-parses documents when needed, tracks status logs/progress, and rolls up cost + latency estimates. |
| `src/components/ReportsPage.tsx` | Compares pipelines, recommends top configs, highlights metric deltas, and exports Markdown/PDF summaries. |
| `src/components/HistoryPage.tsx` | Presentational scaffolding for browsing previous experiments (seeded data + management affordances). |
| `src/components/DocumentationPage.tsx` | Rich in-app documentation with copy-to-clipboard snippets, tabbed guides, and workflow walkthroughs. |
| `src/components/ComingSoonPage.tsx` | Product roadmap showcasing planned features (re-ranking, model support, dark mode, metrics). |
| `src/components/SettingsPage.tsx` | UX shell for future account/API key management (forms and toggles are presently static). |
| `src/main.tsx` | Binds the dataset, pipeline, and experiment providers so every screen shares the same shared state. |

#### Experiment Pipeline Logic
1. **Prerequisites:** The UI blocks experiment runs until at least one uploaded document (raw content or ready-to-parse file) and one task exist.
2. **Parsing on Demand:** When a pipeline runs, any uploaded-but-unparsed documents are sent to `/api/parse` using the baseline pipeline’s parsing strategy, with status updates fed back into the dataset context.
3. **Chunking:** `chunkDocumentsWithConfig` slices content according to the active pipeline strategy; `summarizeChunkGroups` produces quick stats for the report.
4. **Upsert:** `/api/chunks` embeds every chunk and writes them to the pipeline’s target Qdrant collection. Existing vectors for that pipeline are cleared, and collection metadata (dimension, source collection) is tracked.
5. **Answering:** For each task + pipeline, `/api/answer` performs retrieval, captures cited chunks, latency, and token usage, and normalizes snippets for downstream rendering.
6. **Judging:** Answers feed `/api/judge`, which yields per-task verdicts (pass/review), dimension-specific scores, rationales, latency, and token counts.
7. **Metrics & Costing:** The experiment store computes aggregate metrics (pass rate, context precision, groundedness, latency p95, cost/query, tokens used) and derives “best pipeline” recommendations.
8. **Reporting & Export:** The Reports page compares pipelines, highlights metric deltas against baseline, and offers Markdown/PDF exports summarizing findings and recommended next steps.
9. **Persistence:** The latest `ExperimentRun` snapshot (including configuration copies) is stored in context for Reports, History, and Documentation pages.

### Remaining / Optional Work
- **Authentication & Authorization (critical):** No auth guard or rate limiting exists today; add API keys/session middleware before exposing beyond localhost.
- **Persistent Storage (critical):** Experiment history and settings screens remain static—replace with real storage (backend API, database, or export/import utilities).
- **Parsing Flexibility (critical):** `/api/parse` returns `503` without `LLAMA_CLOUD_API_KEY`; introduce alternative connectors so LlamaParse is optional.
- **Provider Coverage (critical):** Backend only supports OpenAI even though the UI advertises other providers; wire up reranker + additional integrations (Anthropic/Cohere).
- **Roadmap Delivery (critical):** Items showcased on the Coming Soon page (reranking, metrics, dark mode) are not implemented yet.
- **Real-time Feedback:** Consider SSE/websocket progress updates instead of polling to show real-time pipeline stages.
- **Testing & Observability:** Add unit/integration coverage for backend clients/routes, plus telemetry dashboards for token/cost monitoring.
- **Deployment Tooling:** Docker images, CI workflows, and environment templates for staging/production readiness.
- **Access Controls:** Gate admin settings (API keys, roadmap edits) and provide workspace-level isolation when multi-user support arrives.

## Troubleshooting
- `ERR_UNKNOWN_FILE_EXTENSION ".ts"` – Occurs when Node tries to execute TypeScript directly. Use the provided `npm run dev` scripts so the loader/transpiler is applied.
- `fs.Stats constructor is deprecated` warning – Previously emitted by `ts-node`; switching to `tsx` for local execution removes the warning. Ensure you’ve re-installed backend deps.
- `Missing required environment variable` – Verify the backend has access to the keys listed above.
- Express server fails to bind `0.0.0.0:7070` – Check for an existing process on that port or override `PORT`.
- Backend route errors – Inspect `backend/logs/app.log` for structured output from the logger utilities.
- 503 on `/api/parse` – Configure `LLAMA_CLOUD_API_KEY` or `LLAMA_PARSE_API_KEY`; parsing is gated on LlamaParse until additional techniques land.

## Next Steps
- Configure HTTPS/TLS if exposing the backend publicly.
- Add authentication and request quotas before opening the API to broader teams.
- Wire the placeholder History/Settings views to persistent storage and access controls.
- Implement reranker + additional provider integrations that are currently marked as “coming soon”.
- Set up CI to lint, test, and deploy each app independently (GitHub Actions, etc.).

Happy experimenting!  
RAG Evaluation Lab Team
