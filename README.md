# RAG Evaluation Lab

End-to-end workspace for building and evaluating retrieval-augmented generation (RAG) pipelines. The repository is now split into a `frontend` Vite/React application and a `backend` Express service that proxies OpenAI and Qdrant.

## Repository Layout
- `frontend/` – Vite + React UI, Tailwind styles, component library, and build assets.
- `backend/` – TypeScript Express API with OpenAI + Qdrant helpers.
- `reference/` – Sample datasets, mock evaluations, and design docs (read-only).
- `.env` – Local secrets consumed by the backend (`dotenv` loads from the repo root).

## Prerequisites
- Node.js 18 or newer
- npm 9 or newer
- Qdrant cluster + API key (or local instance)
- OpenAI API key with access to the specified models
- LlamaParse (Llama Cloud) account and API key for document ingestion

## Initial Setup
Install dependencies for each app:

```bash
# frontend dependencies
cd frontend
npm install

# backend dependencies
cd ../backend
npm install
```

> **Security reminder:** The committed `.env` file currently contains live-looking API keys. Rotate them immediately and replace the contents with safe placeholders. Prefer storing real secrets outside of version control (e.g., `.env.local`, your shell profile, or a secrets manager).

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
| `LLAMA_CLOUD_API_KEY` | ✅ | API key for LlamaParse document parsing | – |
| `LLAMA_CLOUD_BASE_URL` | ⬜️ | Override LlamaParse API host | `https://api.llamaindex.ai` |
| `PORT` | ⬜️ | Backend HTTP port | `7070` |
| `CORS_ORIGINS` | ⬜️ | Comma-separated list of allowed browser origins | (accept all) |

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

After an experiment run, the frontend now records metrics derived from these judge evaluations. Pass rate, context precision, groundedness, latency, cost, and token usage are all taken from real model calls rather than heuristics, giving the reports page production-ready quality signals.

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
