# <img src="favicon/favicon-32x32.png" alt="RAG Evaluation Lab icon" width="28" height="28" /> RAG Evaluation Lab

End-to-end workspace for building, running, and evaluating retrieval-augmented generation (RAG) pipelines. The project is split into a `frontend` Vite/React application that orchestrates datasets, pipelines, experiments, reporting, history, documentation, and settings, and a `backend` Express service that handles OpenAI, Qdrant, and LlamaParse integrations.

## Repository Layout
- `frontend/` – Vite + React UI with Tailwind styles, Radix components, and feature pages (Datasets, Pipelines, Experiments, Reports, History, Documentation, Settings).
- `backend/` – TypeScript Express API with OpenAI + Qdrant helpers, LlamaParse ingestion, and evaluation endpoints.
- `favicon/` – Application icons consumed by the frontend.
- `.env.example` – Template with every environment variable the apps consume.
- `.env.local` – Git-ignored overrides; copy from `.env.example` for local development.

## Prerequisites
- Node.js 18 or newer
- npm 9 or newer
- Qdrant cluster + API key (or local instance)
- OpenAI API key with access to the specified models
- LlamaParse (Llama Cloud) account and API key for document ingestion

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
Both apps read environment variables from the repository root. The backend hydrates via `dotenv` and the frontend points Vite to the same directory (`envDir`). Create a safe `.env` (or `.env.local` to override locally) with the following keys:

| Variable | Required | Description | Default |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | ✅ | OpenAI account key used for embeddings and chat completions | – |
| `OPENAI_EMBED_MODEL` | ⬜️ | Override embedding model | `text-embedding-3-small` |
| `OPENAI_CHAT_MODEL` | ⬜️ | Override chat/completions model | `gpt-4o-mini` |
| `QDRANT_URL` | ✅ | Base URL for your Qdrant cluster | – |
| `QDRANT_API_KEY` | ⬜️ | API key if Qdrant requires auth | – |
| `QDRANT_COLLECTION` | ⬜️ | Default collection name for vectors | `rag-eval-chunks` |
| `LLAMA_CLOUD_API_KEY` or `LLAMA_PARSE_API_KEY` | ✅ | API key for LlamaParse document parsing | – |
| `LLAMA_CLOUD_BASE_URL` | ⬜️ | Override LlamaParse API host | `https://api.cloud.llamaindex.ai/api` |
| `PORT` | ⬜️ | Backend HTTP port | `7070` |
| `VITE_BACKEND_URL` | ✅ | Frontend base URL for backend requests | `http://localhost:7070` |
| `CORS_ORIGINS` | ⬜️ | Comma-separated list of allowed browser origins | `http://127.0.0.1:3000,http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173` |

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

## Key UI Areas
- **Datasets & Tasks:** Upload documents, parse them through LlamaParse, and define evaluation questions.
- **Pipelines:** Configure chunking, embedding, retrieval, reranking, answer generation, and judge settings per experiment pipeline.
- **Experiments:** Run one or more pipelines end-to-end, stream progress, capture chunk previews, and persist detailed results.
- **Reports & History:** Review aggregated metrics, cost estimates, per-question breakdowns, and revisit previous runs.
- **Documentation & Settings:** In-app guides, API key reminders, and placeholders for future account/security controls.

## Troubleshooting
- `ERR_UNKNOWN_FILE_EXTENSION ".ts"` – Occurs when Node tries to execute TypeScript directly. Use the provided `npm run dev` scripts so the loader/transpiler is applied.
- `fs.Stats constructor is deprecated` warning – Previously emitted by `ts-node`; switching to `tsx` for local execution removes the warning. Ensure you’ve re-installed backend deps.
- `Missing required environment variable` – Verify the backend has access to the keys listed above.
- Express server fails to bind `0.0.0.0:7070` – Check for an existing process on that port or override `PORT`.

## Next Steps
- Configure HTTPS/TLS if exposing the backend publicly.
- Add authentication and request quotas before opening the API to broader teams.
- Set up CI to lint, test, and deploy each app independently (GitHub Actions, etc.).

Happy experimenting!  
RAG Evaluation Lab Team
