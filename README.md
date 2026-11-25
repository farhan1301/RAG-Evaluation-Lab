<div align="center">

# <img src="favicon/favicon-32x32.png" alt="RAG Evaluation Lab icon" width="28" height="28" /> RAG Evaluation Lab

**A comprehensive platform for building, testing, and evaluating Retrieval-Augmented Generation pipelines**

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactjs.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express.js-404D59?style=for-the-badge)](https://expressjs.com/)

[Features](#-features) • [Tech Stack](#️-tech-stack) • [Quick Start](#-quick-start) • [API Reference](#-api-reference) • [Documentation](#-documentation)

</div>

---

## 📖 Overview

RAG Evaluation Lab is an end-to-end workspace for building, running, and evaluating retrieval-augmented generation (RAG) pipelines. The platform provides a modern, intuitive interface for managing datasets, configuring multi-stage pipelines, running experiments, and analyzing results with comprehensive metrics.

### Architecture

- **Frontend**: Vite + React application with Tailwind CSS for orchestrating datasets, pipelines, experiments, and reporting
- **Backend**: TypeScript Express service handling OpenAI, Qdrant, and LlamaParse integrations

---

## 🛠️ Tech Stack

### Frontend
- **Framework**: React 19 with TypeScript and React Router 8
- **Build Tool**: Vite 8
- **Styling**: Tailwind CSS 4
- **UI Components**: Radix UI primitives
- **State Management**: TanStack Query for saved resources and React context for the active run

### Backend
- **Runtime**: Node.js 22.13+ (tested on 22.22.3)
- **Framework**: Express.js
- **Language**: TypeScript
- **Key Integrations**:
  - OpenAI API (embeddings & chat)
  - Qdrant (vector database)
  - LlamaParse (document parsing)

---

## 🎥 Demo

Click the image below to watch a demonstration of the platform:

[![Watch Demo](/RAG_Demo_Thumbnail.png)](https://drive.google.com/file/d/1N9gWsj2-VUxENEvvmErER1WbRtXOn-Ph/view?usp=sharing)


---

## ✨ Features

### 🎯 Core Capabilities

- **Guided Workflow**: Interactive landing page that explains the RAG evaluation process with direct navigation to datasets and experiments
- **Dataset Management**:
  - File uploads with real-time status tracking
  - Curated sample datasets for quick starts
  - CSV import with flexible header alias support
- **Multi-Pipeline Configuration**:
  - Configure complete RAG pipelines with granular control over each stage
  - Parsing, chunking, embeddings, retrieval, reranking, LLM, and judge configurations
  - Baseline selection and pipeline duplication for easy experimentation
- **Intelligent Experiment Runner**:
  - Auto-parsing of documents on-demand
  - Real-time progress logging
  - Comprehensive metrics: latency, token usage, and cost tracking
  - In-tab progress and access to the latest completed run
- **Advanced Reporting**:
  - Pipeline comparison with metric deltas
  - Automated recommendations for optimal configurations
  - Export capabilities (Markdown and PDF)
- **Document Processing**: LlamaParse-powered ingestion for consistent parsing with extensibility for additional techniques

### Appearance

Choose System, Light, or Dark in Settings. The browser remembers the choice when you reload.

---

## 📁 Repository Structure

```
RAG Evaluation Lab/
├── frontend/              # Vite + React UI application
│   ├── src/
│   │   ├── components/   # Feature pages (Datasets, Pipelines, Experiments, Reports, etc.)
│   │   ├── state/        # React context providers for global state
│   │   └── lib/          # Utilities (chunking, CSV parsing, API client)
│   └── package.json
├── backend/              # TypeScript Express API server
│   ├── src/
│   │   ├── lib/         # Client libraries (OpenAI, Qdrant, LlamaParse)
│   │   └── routes/      # API endpoints (chunks, search, answer, judge, parse)
│   ├── scripts/         # Verification and setup utilities
│   └── sample-data/     # Sample assets for testing
├── favicon/             # Application icons
├── .env.example         # Environment variable template
└── .env.local          # Local overrides (gitignored)
```

---

## 📋 Prerequisites

Before getting started, ensure you have the following:

| Requirement | Version | Notes |
|------------|---------|-------|
| Node.js | 22.13+ | JavaScript runtime |
| npm | 9+ | Package manager |
| Qdrant | Optional | Dense retrieval in the current runner |
| OpenAI API Key | Optional | OpenAI embedding, answer and judge profiles |
| LlamaParse API Key | Optional | Parsing uploaded documents in the current runner |

---

## 🚀 Quick Start

### 1. Clone and Install

```bash
# Clone the repository
git clone <repository-url>
cd "RAG Evaluation Lab"

# Copy environment template
cp .env.example .env.local
```

The dataset and pipeline editors work with the empty provider settings in `.env.example`. To use the existing experiment runner, configure Qdrant and the embedding, chat and judge roles. Uploaded files also require a LlamaParse key.

### 2. Install Dependencies

```bash
# From the repository root
npm ci
```

> **Security Note:** Never commit API keys to version control. Keep all secrets in `.env.local` (gitignored) or use a secure secret management system.

### 3. Run the Application

**Terminal 1 - Start Backend:**
```bash
npm run dev:backend
# Server starts at http://127.0.0.1:7070
```

**Terminal 2 - Start Frontend:**
```bash
npm run dev
# Open http://127.0.0.1:3000
```

> **Tip:** Use `npm run dev:watch` in the backend for auto-restart on file changes during development.

---

## ⚙️ Configuration

### Environment Variables

Node loads `.env.local` and `.env` from the repository root. Process environment settings take precedence, followed by `.env.local`. The API stores the workspace in `backend/data/workspace.sqlite` by default. Set `DATABASE_PATH` to select another path. Node 22 emits an expected `ExperimentalWarning` when opening `node:sqlite`.

Set `OPENAI_CHAT_MODEL` to a current model and `OPENAI_API_KEY` to enable generation. The judge uses that model unless `OPENAI_JUDGE_MODEL` selects another. For embeddings, configure `OPENAI_EMBED_MODEL` or set `LOCAL_EMBED_BASE_URL` and `LOCAL_EMBED_MODEL` to an existing OpenAI-compatible service and its installed embedding model. For example, Ollama serves the compatible API at `http://127.0.0.1:11434/v1`. Qdrant uses `QDRANT_URL` and an optional `QDRANT_API_KEY`. Set `QDRANT_REQUIRED=true` to include its readiness probe.

Browser requests use same-origin `/api` paths. Vite proxies them to `http://127.0.0.1:7070` or `BACKEND_PROXY_TARGET`. Configure additional exact origins with `CORS_ORIGINS`, accepted hostnames with `TRUSTED_HOSTS`, and trusted proxy IPs or CIDRs with `TRUSTED_PROXIES`. The default limits are 256 KiB per JSON request, 12 MiB for document and large runner payloads, and 600 requests per client per minute. Override these with `JSON_LIMIT_BYTES`, `DOCUMENT_LIMIT_BYTES`, `RATE_LIMIT`, and `RATE_WINDOW_MS`.

## 🔌 API Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/health/live`, `/health/ready` | GET | Process liveness and storage readiness |
| `/api/v1/capabilities` | GET | Available server profiles and parser and vector store configuration |
| `/api/v1/datasets`, `/api/v1/pipelines` | GET, POST | List active definitions or create one |
| `/api/v1/datasets/sample` | POST | Load the labeled RAG fundamentals sample |
| `/api/v1/{datasets,pipelines}/:id` | GET, PATCH, DELETE | Read, edit, or archive |
| `/api/v1/{datasets,pipelines}/:id/revisions[/:revision]` | GET | List revisions or read a frozen definition |
| `/api/v1/datasets/:id/tasks` | GET, POST | List or add questions |
| `/api/v1/datasets/:id/tasks/:taskId` | PATCH, DELETE | Edit or remove a question |
| `/api/v1/tasks/:id/qrels` | PUT | Replace the labeling pool and graded document labels |
| `/api/v1/pipelines/:id/copies` | POST | Create an independent copy |

Send the current quoted revision in `If-Match` when changing an existing resource, including its tasks, grades and documents. A stale revision returns `409`, and a missing precondition returns `428`. Successful edits return the updated definition with an `ETag`. List responses contain `items` and `nextCursor`. Pass the cursor with `?cursor=…&limit=…` for the next page. Error responses carry a safe message, code, and request ID.

### Metrics and Evaluation

The platform calculates comprehensive metrics from actual LLM evaluations:
- Judge pass rate and coverage
- Judged context precision and groundedness
- Latency (p50, p95, p99)
- Token usage and cost per query

All metrics are derived from real model calls rather than heuristics, ensuring production-ready quality signals.

---

## 🏗️ Production Deployment

### Build for Production

```bash
# Build frontend (outputs to frontend/build)
cd frontend
npm run build

# Build backend (outputs to backend/dist)
cd ../backend
npm run build
npm start
```

### Deployment Recommendations

- **Frontend**: Deploy the `frontend/build` directory to a static hosting service (Vercel, Netlify) or CDN
- **Backend**: Run the Node service behind an API gateway or load balancer with proper HTTPS/TLS
- **Security**: Configure authentication, rate limiting, and request quotas before public deployment

### NPM Scripts (Root Directory)

Convenient scripts for running commands from the repository root:

```bash
npm run dev              # Start frontend dev server
npm run dev:frontend     # Start frontend dev server (explicit)
npm run dev:backend      # Start backend dev server
npm run build            # Build frontend
npm run build:backend    # Build backend
```

---

## 🧪 Testing and Verification

Run the workspace checks from the repository root.

```sh
npm run lint && npm run typecheck && npm test && npm run build
node scripts/check-browser-secrets.mjs
```

Vitest uses synthetic documents and fake providers. TypeScript strictly checks the frontend, Vite config, backend, and TypeScript test fixtures. The build exercises the compiled backend with fixture configuration. CI also checks its HTTP health endpoint on loopback.

---

## 📚 Documentation

### Implementation Overview

This section provides detailed information about the architecture, components, and implementation details of the RAG Evaluation Lab.

### Backend (`/backend`)

#### Goals
- Provide a TypeScript + Express façade that keeps OpenAI, Qdrant, and LlamaParse credentials out of the browser.
- Offer a complete RAG evaluation pipeline: ingest documents, embed chunks, retrieve context, draft answers, judge responses, and expose per-pipeline analytics.
- Centralize configuration, logging, and CORS controls so the frontend and backend share a consistent runtime story, plus scripts that sanity-check each API surface.

#### Key Components
| Location | Description |
| --- | --- |
| `package.json`, `tsconfig.json` | Node/TypeScript scaffolding (ES modules, `tsx` dev runner, `tsc` build output). |
| `src/config/env.ts` | Loads and validates server settings and derives safe provider capabilities. |
| `src/lib/logger.ts` | Pino emits structured, redacted records to stdout. |
| `src/lib/openaiClient.ts` | Embedding + chat helpers that surface latency, token usage, GPT‑5 model quirks, and response-format support. |
| `src/lib/qdrantClient.ts` | Pipeline-aware collection manager (sanitizes names, ensures payload indexes, retries deletes, and filters searches per `pipelineId`). |
| `src/lib/llamaParseClient.ts` | Robust LlamaParse integration: resilient uploads, exponential backoff polling, payload normalization (markdown/text), and page-count extraction. |
| `src/routes/embeddings.ts` | `POST /api/chunks` – embeds chunk payloads, replaces only the selected pipeline’s points, and returns vector dimension metadata. |
| `src/routes/search.ts` | `POST /api/search` – embeds a query, searches the pipeline-specific collection, and exposes the resolved collection + vector size. |
| `src/routes/answer.ts` | `POST /api/answer` – runs retrieval, composes a grounded answer prompt, returns matches/usage/latency, and mirrors the resolved collection metadata. |
| `src/routes/judge.ts` | `POST /api/judge` – coaxes structured JSON verdicts, aggregates pass rate + average scores, and keeps raw per-task rationales. |
| `src/routes/parse.ts` | `POST /api/parse` – forwards files to LlamaParse with detailed logging, returns normalized text + job IDs, and identifies missing parser configuration. |
| `src/index.ts` | Migrates SQLite, starts the app on loopback, drains requests and closes the database on SIGINT or SIGTERM. |
| `scripts/*.ts` | Optional scoped index setup: `node --import tsx backend/scripts/setup-qdrant-index.ts <pipeline-id> <vector-dimension>` from the root. |

Start locally with `npm run dev:backend` from the root. Run the compiled backend with `npm start -w rag-eval-backend` after the workspace build.

#### Notable Behaviors
- Pipeline-aware Qdrant usage keeps embeddings partitioned per experiment configuration while provisioning a collection per pipeline and vector size. Reindexing replaces points for that pipeline. Existing legacy collections stay intact.
- The API returns safe error codes and request IDs for provider failures.
- LlamaParse integration includes retry/backoff for uploads/downloads and normalizes heterogeneous payload formats into a consistent `{ text, pageCount }` shape.
- Judge responses request JSON-formatted output, require valid 0–1 scores, and aggregate latency/tokens for downstream cost analysis.
- Judge coverage is scored tasks / submitted tasks. Only scored tasks contribute to judge pass rate and mean scores. Unavailable judgments are retained in the task details. The legacy judged context precision score is the judge’s 0–1 assessment of how well retrieved text supports the answer.

### Frontend (`/frontend`)

#### Goals
- Provide a multi-step workspace (with a polished landing page) for dataset ingestion, pipeline configuration, experiment execution, and results analysis.
- Load saved definitions through TanStack Query and retain the latest run results in React context.
- Surface richer guidance via in-app documentation, the latest run in History, and theme preferences.

#### Key Modules & Screens
| Location | Highlights |
| --- | --- |
| `src/App.tsx` | Responsive navigation, route focus management, and deep links to workspace pages and reports. |
| `src/data/workspace.ts` | Fetches saved definitions and applies conditional mutations through TanStack Query. |
| `src/data/legacyRunner.ts` | Projects the selected saved documents, tasks, baseline and pipeline settings into the transitional runner. |
| `src/state/experimentResults.tsx` | Keeps progress, per-pipeline answers, and the latest completed run available across routes in the current tab. |
| `src/lib/chunking.ts` | Chunking strategies (recursive/semantic/layout/table), sentence-aware splitting, and chunk statistics helpers. |
| `src/lib/taskCsv.ts` | CSV parser that accepts header aliases, surfaces warnings, and hydrates task lists. |
| `src/lib/backend.ts` | Strongly-typed fetch utilities for `/api/parse`, `/api/chunks`, `/api/search`, `/api/answer`, and `/api/judge`, including error parsing. |
| `src/components/DatasetsPage.tsx` | File ingestion with progress UI, removal, sample dataset loader, and CSV task import feedback. |
| `src/components/PipelinesPage.tsx` | Configure parsing, chunking, embedding, retrieval, reranker (placeholder), LLM, and judge stages per pipeline with expand/collapse controls. |
| `src/components/ExperimentsPage.tsx` | Orchestrates runs across multiple pipelines, auto-parses documents when needed, tracks status logs/progress, and rolls up cost + latency estimates. |
| `src/components/ReportsPage.tsx` | Compares pipelines, recommends top configs, highlights metric deltas, and exports Markdown/PDF summaries. |
| `src/components/HistoryPage.tsx` | Links to the latest completed report by run ID. Refreshing the tab clears run data. |
| `src/components/DocumentationPage.tsx` | Rich in-app documentation with copy-to-clipboard snippets, tabbed guides, and workflow walkthroughs. |
| `src/components/SettingsPage.tsx` | Stores a system, light, or dark theme preference in this browser. |
| `src/main.tsx` | Mounts the browser router, query client, and in-memory workspace providers. |

#### Experiment Pipeline Logic
1. **Prerequisites:** The UI blocks experiment runs until at least one uploaded document (raw content or ready-to-parse file) and one task exist.
2. **Parsing on Demand:** When a pipeline runs, any uploaded-but-unparsed documents are sent to `/api/parse` using the baseline pipeline’s parsing strategy, with parse progress held locally for that execution.
3. **Chunking:** `chunkDocumentsWithConfig` slices content according to the active pipeline strategy; `summarizeChunkGroups` produces quick stats for the report.
4. **Upsert:** `/api/chunks` embeds every chunk and writes them to the pipeline’s target Qdrant collection. Existing vectors for that pipeline are cleared, and collection metadata (dimension, source collection) is tracked.
5. **Answering:** For each task + pipeline, `/api/answer` performs retrieval, records retrieved chunks, latency, and token usage, and normalizes snippets for downstream rendering.
6. **Judging:** Answers feed `/api/judge`, which yields per-task verdicts (pass/review/unavailable), dimension-specific scores, rationales, latency, and token counts.
7. **Metrics & Costing:** The experiment store computes aggregate metrics (judge pass rate, judged context precision, groundedness, latency p95, cost/query, tokens used) and derives “best pipeline” recommendations.
8. **Reporting & Export:** The Reports page compares pipelines, highlights metric deltas against baseline, and offers Markdown/PDF exports summarizing findings and recommended next steps.
9. **Persistence:** The latest `ExperimentRun` snapshot (including configuration copies) is stored in context for Reports, History, and Documentation pages.

### Remaining / Optional Work
- **Authentication & Authorization (critical):** No auth guard or rate limiting exists today; add API keys/session middleware before exposing beyond localhost.
- **Persistent Storage (critical):** Dataset and pipeline revisions are durable. Run history remains in tab memory.
- **Parsing Flexibility (critical):** Parsing uploaded files requires a configured LlamaParse key; introduce alternative connectors so LlamaParse is optional.
- **Provider Coverage (critical):** Backend only supports OpenAI even though the UI advertises other providers; wire up reranker + additional integrations (Anthropic/Cohere).
- **Real-time Feedback:** Consider SSE/websocket progress updates instead of polling to show real-time pipeline stages.
- **Testing & Observability:** Add unit/integration coverage for backend clients/routes, plus telemetry dashboards for token/cost monitoring.
- **Deployment Tooling:** Docker images, CI workflows, and environment templates for staging/production readiness.
- **Access Controls:** Gate admin settings (API keys, roadmap edits) and provide workspace-level isolation when multi-user support arrives.

---

## 🔧 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `ERR_UNKNOWN_FILE_EXTENSION ".ts"` | Use provided `npm run dev` scripts to apply proper TypeScript transpilation |
| `fs.Stats constructor is deprecated` | Reinstall backend dependencies to ensure `tsx` is used instead of `ts-node` |
| `Invalid environment settings` | Verify all required environment variables are set in `.env.local` |
| Express fails to bind to port 7070 | Check if port is in use or override with `PORT` environment variable |
| Backend route errors | Match the request ID in backend stdout |
| Missing parser capability | Ensure `LLAMA_CLOUD_API_KEY` or `LLAMA_PARSE_API_KEY` is configured |

### Getting Help

- Review the in-app documentation for detailed workflows
- Check backend stdout for structured request logs
- Verify all API keys and credentials are valid and have appropriate permissions

---

## 🛣️ Roadmap

### Planned Features

- **Enhanced Model Support**: Integration with additional LLM providers (Anthropic, Cohere)
- **Advanced Reranking**: Implement reranker functionality for improved retrieval accuracy
- **Persistent Storage**: Database integration for experiment history and user settings
- **Authentication & Authorization**: User management and API access controls
- **Additional Parsing Methods**: Local parsers and OCR capabilities
- **Enhanced Metrics**: Additional evaluation dimensions and custom metrics
- **CI/CD Pipeline**: Automated testing and deployment workflows

### Before Production

- [ ] Configure HTTPS/TLS for secure communication
- [ ] Implement authentication and rate limiting
- [ ] Add persistent storage for history and settings
- [ ] Set up monitoring and observability
- [ ] Configure proper CORS and security headers

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests.

---

## 📄 License

This project is provided as-is for evaluation and development purposes.

---

## 👥 Team

Built by the RAG Evaluation Lab Team

---

<div align="center">

**Happy Experimenting!**

For questions or feedback, please open an issue on the repository.

</div>
