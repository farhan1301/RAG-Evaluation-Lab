# syntax=docker/dockerfile:1

# Pinned Node 26 glibc image (amd64 + arm64) required for built-in node:sqlite + FTS5.
FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY backend/package.json backend/tsconfig.json ./backend/
COPY frontend/package.json frontend/tsconfig.json frontend/tsconfig.node.json ./frontend/

RUN npm ci

COPY packages/contracts/src ./packages/contracts/src
COPY favicon ./favicon
COPY frontend/index.html frontend/vite.config.ts ./frontend/
COPY frontend/src ./frontend/src
COPY backend/src ./backend/src

RUN npm run build -w rag-eval-frontend && npm run build -w rag-eval-backend

FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

RUN npm ci --omit=dev --ignore-scripts && mkdir -p /app/backend/node_modules

FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7070 \
    DATABASE_PATH=/data/workspace.sqlite \
    BLOB_DIRECTORY=/data/blobs \
    STATIC_DIR=/app/frontend/build

RUN mkdir -p /data/blobs && chown -R node:node /data /app

COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=prod-deps --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=prod-deps --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/backend/node_modules ./backend/node_modules

COPY --from=builder --chown=node:node /app/packages/contracts/src ./packages/contracts/src
COPY --from=builder --chown=node:node /app/backend/dist ./backend/dist
COPY --from=builder --chown=node:node /app/frontend/build ./frontend/build

USER node

EXPOSE 7070

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '7070') + '/health/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "backend/dist/index.js"]
