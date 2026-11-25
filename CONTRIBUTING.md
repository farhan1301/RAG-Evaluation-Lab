# Contributing to RAG Evaluation Lab

Thanks for contributing to RAG Evaluation Lab. This guide covers local setup, test layers, coding standards, and pull request expectations.

## Prerequisites & Setup

- **Node.js:** `>=22.18` (CI tests Node `22.22.3` and `26.13.1`)
- **npm:** Workspace-aware npm (bundled with Node 22/26)
- **Docker (optional):** Needed only for real Qdrant integration tests or the Compose smoke test

Install dependencies from the repository root:

```bash
cp .env.example .env.local
npm ci
```

The repository is an npm workspaces monorepo:

- `packages/contracts` (`@rag-eval/contracts`) — Shared Zod schemas, wire DTOs, and metric definitions
- `backend` (`rag-eval-backend`) — Express 5 API, `node:sqlite` storage, durable worker, retrieval, evaluation, reporting, and ops CLIs
- `frontend` (`rag-eval-frontend`) — React 19 + React Router 8 + TanStack Query + Tailwind CSS 4 SPA

## Workspace Scripts

| Script                   | Purpose                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `npm run dev`            | Start Vite frontend dev server (`http://127.0.0.1:3000`, proxies `/api` to `7070`)            |
| `npm run dev:backend`    | Start Express API server (`http://127.0.0.1:7070`)                                            |
| `npm run dev:worker`     | Start durable background worker                                                               |
| `npm run build`          | Build workspaces (`frontend` + `backend`) and verify compiled backend startup                 |
| `npm run format`         | Format all files with Biome                                                                   |
| `npm run lint`           | Run Biome linter and format check                                                             |
| `npm run typecheck`      | Run strict TypeScript checks across contracts, backend, frontend, Vitest tests, and E2E specs |
| `npm test`               | Run Vitest unit and integration suite                                                         |
| `npm run test:e2e`       | Run Playwright browser E2E suite                                                              |
| `npm run backup`         | Run online SQLite + blobs workspace backup CLI                                                |
| `npm run restore`        | Restore a verified workspace backup into a target directory                                   |
| `npm run rebuild:qdrant` | Rebuild Qdrant dense/hybrid vectors from SQLite                                               |

## Test Layers

**Important rule: Tests must never call paid external APIs.** Always use synthetic documents, injected clocks, and deterministic local fake transports. Never hard-code provider model IDs in application code.

1. **Unit & Integration Tests (Vitest)**

   ```bash
   npm test
   ```

   Covers retrieval metrics, chunking, local/mocked cloud parsing, provider adapters, durable job leases/retries, evaluation runner, comparisons/exports, static SPA serving, backup/restore, and synthetic generation.

2. **Real Qdrant Integration Test (`QDRANT_URL`-gated)**

   `tests/qdrant-integration.test.ts` is skipped automatically when `QDRANT_URL` is unset. To run it against the pinned Qdrant image locally:

   ```bash
   docker run --rm -d --name rag-eval-qdrant -p 127.0.0.1:6333:6333 \
     qdrant/qdrant:v1.20.2@sha256:d277592721d2e3b73f9b797b53cf05e6a5bb2134f6d13fdbda4ca51782afbcac
   QDRANT_URL=http://127.0.0.1:6333 npm test -- tests/qdrant-integration.test.ts
   docker stop rag-eval-qdrant
   ```

3. **Browser End-to-End Tests (Playwright)**

   Install Chromium once, build the workspaces, and run the E2E suite (uses a local OpenAI-compatible fixture HTTP server—no API keys needed):

   ```bash
   npx playwright install --with-deps chromium
   npm run build
   npm run test:e2e
   ```

4. **Browser Credential & Packaging Smoke Checks**

   ```bash
   node scripts/check-browser-secrets.mjs
   docker compose up -d --build
   node scripts/compose-smoke.mjs
   docker compose down -v
   ```

## Code Style & Architecture Rules

- **Formatter & Linter:** Biome (`biome.json`) with 2-space indentation and single quotes for JS/TS. Run `npm run format` before committing.
- **TypeScript:** Strict mode across all workspaces (`tsconfig.base.json`). Keep shared HTTP wire schemas and inferred DTOs in `packages/contracts`.
- **SQLite isolation:** Keep all `node:sqlite` access inside `backend/src/db/`. Never read or write SQLite directly from routes or frontend code.
- **Security hygiene:** Never add API keys, private URLs, or personal data to code, fixtures, or docs. Keep provider credentials strictly server-side.

## Pull Request & Commit Expectations

Before opening a pull request, verify all quality gates pass cleanly:

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
node scripts/check-browser-secrets.mjs
```

- Keep pull requests focused on a single concern with a clear description of what changed and how it was verified.
- Add or update Vitest (and Playwright where UI flows change) tests for bug fixes and new behavior.
- Update `CHANGELOG.md` and `README.md` when changing user-facing APIs, configuration variables, or workflows.
