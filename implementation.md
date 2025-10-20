# Implementation Overview

This document captures the backend and frontend work completed to deliver a working Retrieval-Augmented Generation (RAG) evaluation loop, plus a summary of remaining items to consider.

---

## Backend (`/backend`)

### Goals
- Provide a secure layer (Express + TypeScript) that keeps API keys out of the browser.
- Support full RAG lifecycle operations:
  1. Embed & upsert document chunks into Qdrant.
  2. Embed queries and retrieve relevant chunks.
  3. Generate answers with the LLM using retrieved context.

### Key Components
| Location | Description |
| --- | --- |
| `package.json`, `tsconfig.json` | Node/TypeScript project setup. |
| `src/lib/config.ts` | Loads environment variables (OpenAI + Qdrant + LlamaParse). |
| `src/lib/openaiClient.ts` | Helper for embeddings + chat completions (now returns token usage for pricing). |
| `src/lib/qdrantClient.ts` | Wrapper for Qdrant collections, upserts, and search. |
| `src/lib/llamaParseClient.ts` | Thin client for LlamaParse uploads + polling. |
| `src/routes/embeddings.ts` | `POST /api/chunks` route – embeds chunks & upserts to Qdrant. |
| `src/routes/search.ts` | `POST /api/search` – embeds a question and searches Qdrant. |
| `src/routes/answer.ts` | `POST /api/answer` – retrieves context, drafts LLM answer. |
| `src/routes/judge.ts` | `POST /api/judge` – evaluates answers against expectations/context with an LLM judge. |
| `src/routes/parse.ts` | `POST /api/parse` – forwards files to LlamaParse and returns normalized text. |
| `src/index.ts` | Assembles Express app, wires routes, exposes `/health`. |

### Runtime Expectations
- Requires the following environment variables: `OPENAI_API_KEY`, `OPENAI_EMBED_MODEL`, `OPENAI_CHAT_MODEL`, `QDRANT_URL`, optionally `QDRANT_API_KEY`, `QDRANT_COLLECTION`, and `PORT`.
- Set `LLAMA_CLOUD_API_KEY` (and optionally `LLAMA_CLOUD_BASE_URL`) to enable rich document parsing via LlamaParse.
- Start locally with `npm install`, then `npm run dev` (ts-node) or `npm run build` + `npm start`.

---

## Frontend (`/frontend`)

### Goals
- Store user-uploaded documents and evaluation tasks in shared state.
- Chunk documents according to pipeline configuration, send them to the backend, and run retrieval + answer generation using real services.
- Present experiment progress, retrieved context, model answers, and persist run results for the reporting UI.

### Major Changes
| File | Highlights |
| --- | --- |
| `src/state/dataset.tsx` | New context for documents/tasks used across pages. |
| `src/state/pipelines.tsx` | Existing pipeline state reused with defaults/baseline logic. |
| `src/state/experimentResults.tsx` | Stores the latest `ExperimentRun` for the Reports page. |
| `src/lib/chunking.ts` | Reused chunking utilities (recursive/semantic/layout/table) + summarization. |
| `src/lib/backend.ts` | Fetch helpers for `/api/chunks`, `/api/answer`, `/api/judge`, and `/api/parse`. |
| `src/components/DatasetsPage.tsx` | Real file ingestion via LlamaParse, sample dataset loader, persisted tasks. |
| `src/components/ExperimentsPage.tsx` | Replaced stub UI with real flow: chunk → upsert → retrieve + answer → judge → persist summaries and metrics. |
| `src/components/ReportsPage.tsx` | Reads persisted run, renders summary tables/charts using judge-derived metrics and costs. |
| `src/main.tsx` | Wraps app with `PipelineProvider`, `DatasetProvider`, and `ExperimentResultsProvider`. |

### Experiment Pipeline Logic
1. Validate presence of uploaded documents and evaluation tasks.
2. Send raw files to `/api/parse` → LlamaParse returns normalized text + metadata.
3. Chunk documents with `chunkDocumentsWithConfig` (respecting pipeline settings).
4. POST chunks to backend (`/api/chunks`) → embeddings & Qdrant upsert.
5. For each task, POST to `/api/answer` → backend embeds question, searches Qdrant, calls LLM, and returns token usage + latency.
6. Submit the answer set to `/api/judge` → backend prompts an evaluator model for pass/fail, relevance, context precision, and groundedness with structured JSON.
7. Display answers + cited context; compute metrics from judge output (pass rate, context precision, groundedness) and real token/latency/cost figures.
8. Build `ExperimentRun` record with chunking/embedding/retrieval/judging summaries, per-question answer detail, and store via `setLatestRun`.

---

## Remaining / Optional Work
- **Authentication & Security:** protect backend endpoints (API key, session middleware, etc.) if deployed publicly.
- **Streaming / Progress API:** backend could emit progress events (Server-Sent Events / websockets) for long runs.
- **Error UI Enhancements:** finer-grained frontend error handling (retry upserts, per-task failures).
- **Reranker / Deduping Logic:** respect retriever deduping toggle, optionally add reranker stage.
- **Testing & Logging:** unit/integration tests for backend, structured logging, telemetry.
- **Multiple Pipelines in One Run:** loop through selected pipelines and store comparisons in `latestRun`.
- **Deployment Scripts:** dockerize backend/frontend, add environment templates for production deployment.

---

## Critical Gaps
- None at the moment. Recent fixes addressed pipeline configuration state sharing and added configurable CORS headers (use `CORS_ORIGINS` to pin allowed browser origins).

---

## Quick Usage Recap
1. **Backend:** `cd backend && npm install && npm run dev` (with `.env` configured, including `LLAMA_CLOUD_API_KEY` if parsing is required).
2. **Frontend:** `cd frontend && npm install && npm run dev` (ensure `VITE_BACKEND_URL` points to backend).
3. **Workflow:** Upload documents → define tasks → run experiment → review answers → view report.

This should give you a clear snapshot of what’s been implemented so far and what enhancements are still possible. Let me know if you’d like to tackle any of the outstanding items next. 
