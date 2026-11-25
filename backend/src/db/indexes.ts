import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  chunkOptions,
  generationChunk,
  indexGeneration,
  pageSpan,
  z,
  type CreateIndexRequest,
  type GenerationChunk,
  type IndexGeneration,
  type MetadataFilters,
} from '@rag-eval/contracts';
import { ApiError, missing } from '../errors.js';
import type { Extraction } from '../ingestion/local.js';
import { sha256, type ArtifactChunk } from '../ingestion/chunks.js';
import { transaction } from './database.js';
import { paginate } from './definitions.js';
import type { Jobs } from './jobs.js';

export interface RevisionSourceDocument {
  documentId: string;
  documentVersionId: string;
  name: string;
  mimeType: string;
  hash: string;
  isText: boolean;
  inline: Uint8Array;
  artifactId: string | null;
  extraction?: Extraction;
}

export interface KeywordHitRow {
  chunk: GenerationChunk;
  score: number;
}

export interface StoredIndexGeneration extends IndexGeneration {
  qdrantCollection: string | null;
}

const selectGeneration = `
  SELECT g.id, g.dataset_id AS datasetId, g.dataset_revision AS datasetRevision,
    g.fingerprint, g.state, g.mode, g.chunk_config AS chunkConfig,
    g.embedding_provider AS embeddingProvider, g.embedding_model AS embeddingModel,
    g.embedding_dimensions AS embeddingDimensions, g.qdrant_collection AS qdrantCollection,
    g.chunk_count AS chunkCount, g.error_message AS errorMessage,
    g.created_at AS createdAt, g.ready_at AS readyAt,
    (SELECT id FROM index_jobs j WHERE j.generation_id = g.id ORDER BY j.rowid DESC LIMIT 1) AS jobId
  FROM index_generations g
`;

function decodeGeneration(row: Record<string, unknown>): StoredIndexGeneration {
  const parsed = indexGeneration.parse({
    id: row.id,
    datasetId: row.datasetId,
    datasetRevision: row.datasetRevision,
    fingerprint: row.fingerprint,
    state: row.state,
    mode: row.mode,
    chunking: chunkOptions.parse(JSON.parse(String(row.chunkConfig))),
    embeddingProvider: row.embeddingProvider ?? null,
    embeddingModel: row.embeddingModel ?? null,
    embeddingDimensions: row.embeddingDimensions ?? null,
    chunkCount: row.chunkCount,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    readyAt: row.readyAt ?? null,
    jobId: row.jobId ?? null,
  });
  return {
    ...parsed,
    qdrantCollection:
      typeof row.qdrantCollection === 'string' ? row.qdrantCollection : null,
  };
}

export function publicGeneration(
  stored: StoredIndexGeneration,
): IndexGeneration {
  const { qdrantCollection: _c, ...rest } = stored;
  return rest;
}

export class Indexes {
  constructor(
    private readonly db: DatabaseSync,
    private readonly jobs: Jobs,
    private readonly now = Date.now,
  ) {}

  resolveRevision(datasetId: string, requestedRevision?: number): number {
    const row = this.db
      .prepare(
        `SELECT r.revision FROM datasets d
         JOIN dataset_revisions r ON r.dataset_id = d.id AND r.revision = coalesce(?, d.revision)
         WHERE d.id = ?`,
      )
      .get(requestedRevision ?? null, datasetId);
    if (!row) return missing();
    return Number(row.revision);
  }

  revisionDocuments(
    datasetId: string,
    datasetRevision: number,
  ): RevisionSourceDocument[] {
    const rows = this.db
      .prepare(
        `SELECT d.document_id AS documentId, d.id AS documentVersionId,
                d.name, d.mime_type AS mimeType, d.hash, d.is_text AS isText, d.bytes,
                a.id AS artifactId, a.text AS artifactText, a.pages AS artifactPages
         FROM revision_documents r
         JOIN document_versions d ON r.version_id = d.id
         LEFT JOIN jobs j ON j.id = (
           SELECT id FROM jobs
           WHERE version_id = d.id AND chunk_config IS NULL AND state = 'succeeded' AND artifact_id IS NOT NULL
           ORDER BY rowid DESC LIMIT 1
         )
         LEFT JOIN parse_artifacts a ON a.id = j.artifact_id
         WHERE r.dataset_id = ? AND r.revision = ?
         ORDER BY d.document_id ASC`,
      )
      .all(datasetId, datasetRevision);

    if (!rows.length) {
      throw new ApiError(
        409,
        'conflict',
        'Add at least one document to the dataset before indexing.',
      );
    }

    return rows.map((row) => {
      const isText = Number(row.isText) === 1;
      const artifactId =
        typeof row.artifactId === 'string' ? row.artifactId : null;
      if (!artifactId && !isText) {
        throw new ApiError(
          409,
          'conflict',
          'Finish parsing all documents in this dataset revision before indexing.',
        );
      }
      return {
        documentId: String(row.documentId),
        documentVersionId: String(row.documentVersionId),
        name: String(row.name),
        mimeType: String(row.mimeType),
        hash: String(row.hash),
        isText,
        inline: row.bytes as Uint8Array,
        artifactId,
        extraction:
          artifactId && typeof row.artifactText === 'string'
            ? {
                text: row.artifactText,
                pages: z
                  .array(pageSpan)
                  .parse(JSON.parse(String(row.artifactPages))),
              }
            : undefined,
      };
    });
  }

  getStored(id: string): StoredIndexGeneration {
    const row = this.db.prepare(`${selectGeneration} WHERE g.id = ?`).get(id);
    if (!row) return missing();
    return decodeGeneration(row);
  }

  get(id: string): IndexGeneration {
    return publicGeneration(this.getStored(id));
  }

  list(limit: number, cursor = '', datasetId?: string) {
    const rows = datasetId
      ? this.db
          .prepare(
            `${selectGeneration} WHERE g.dataset_id = ? AND g.id > ? ORDER BY g.id LIMIT ?`,
          )
          .all(datasetId, cursor, limit + 1)
      : this.db
          .prepare(`${selectGeneration} WHERE g.id > ? ORDER BY g.id LIMIT ?`)
          .all(cursor, limit + 1);
    return paginate(
      rows.map((row) => publicGeneration(decodeGeneration(row))),
      limit,
      (item) => item.id,
    );
  }

  listReadyDenseGenerations(generationId?: string): StoredIndexGeneration[] {
    if (generationId) {
      const gen = this.getStored(generationId);
      if (gen.state !== 'ready') {
        throw new ApiError(
          409,
          'conflict',
          `Index generation "${generationId}" is in "${gen.state}" state and cannot be rebuilt into Qdrant.`,
        );
      }
      if (gen.mode !== 'dense' && gen.mode !== 'hybrid') {
        throw new ApiError(
          400,
          'invalid_input',
          `Index generation "${generationId}" uses "${gen.mode}" mode and does not require Qdrant vectors.`,
        );
      }
      return [gen];
    }
    const rows = this.db
      .prepare(
        `${selectGeneration} WHERE g.state = 'ready' AND g.mode IN ('dense', 'hybrid') ORDER BY g.created_at ASC, g.id ASC`,
      )
      .all();
    return rows.map((row) => decodeGeneration(row));
  }

  planOrReuse(
    request: CreateIndexRequest,
    embedding: {
      provider: 'openai' | 'openai-compatible';
      model: string;
      expectedDimensions?: number;
    } | null,
    idempotencyKey: string | null = null,
    enqueueJob = true,
  ) {
    return transaction(this.db, () => {
      const datasetRevision = this.resolveRevision(
        request.datasetId,
        request.datasetRevision,
      );
      const docs = this.revisionDocuments(request.datasetId, datasetRevision);
      const fingerprint = sha256(
        JSON.stringify([
          'index-generation-v1',
          request.datasetId,
          datasetRevision,
          docs.map((d) => [d.documentVersionId, d.artifactId ?? d.hash]),
          request.mode,
          request.chunking,
          request.mode === 'keyword'
            ? null
            : embedding
              ? {
                  provider: embedding.provider,
                  model: embedding.model,
                  expectedDimensions: embedding.expectedDimensions ?? null,
                }
              : null,
        ]),
      );
      const requestHash = sha256(
        JSON.stringify(['create-index', fingerprint, request.forceRebuild]),
      );
      const replayed = this.jobs.replayIndex(idempotencyKey, requestHash);
      if (replayed) {
        return {
          index: this.get(replayed.generationId),
          jobId: replayed.jobId,
          reused: false,
        };
      }

      if (!request.forceRebuild) {
        const existing = this.db
          .prepare(
            `${selectGeneration} WHERE g.fingerprint = ? AND g.state = 'ready' ORDER BY g.ready_at DESC LIMIT 1`,
          )
          .get(fingerprint);
        if (existing) {
          const decoded = publicGeneration(decodeGeneration(existing));
          return {
            index: decoded,
            jobId: decoded.jobId,
            reused: true,
          };
        }
      }

      const generationId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO index_generations(
            id, dataset_id, dataset_revision, fingerprint, state, mode,
            chunk_config, embedding_provider, embedding_model, created_at
          ) VALUES (?, ?, ?, ?, 'building', ?, ?, ?, ?, ?)`,
        )
        .run(
          generationId,
          request.datasetId,
          datasetRevision,
          fingerprint,
          request.mode,
          JSON.stringify(request.chunking),
          request.mode === 'keyword' ? null : (embedding?.provider ?? null),
          request.mode === 'keyword' ? null : (embedding?.model ?? null),
          new Date(this.now()).toISOString(),
        );
      const jobId = enqueueJob
        ? this.jobs.enqueueIndex(generationId, idempotencyKey, requestHash)
        : null;
      return {
        index: this.get(generationId),
        jobId,
        reused: false,
      };
    });
  }

  ensureInlineArtifact(
    documentHash: string,
    mimeType: string,
    extraction: Extraction,
  ): string {
    const version = 'inline-text-v1';
    const id = sha256(JSON.stringify([documentHash, mimeType, version]));
    this.db
      .prepare('INSERT OR IGNORE INTO parse_artifacts VALUES (?,?,?,?,?)')
      .run(
        id,
        documentHash,
        version,
        extraction.text,
        JSON.stringify(extraction.pages),
      );
    return id;
  }

  saveArtifactChunks(artifactId: string, rows: ArtifactChunk[]) {
    transaction(this.db, () => {
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO chunks VALUES (?,?,?,?,?,?,?,?,?,?)',
      );
      for (const row of rows) {
        insert.run(
          row.id,
          artifactId,
          row.strategy,
          row.chunkSize,
          row.overlap,
          row.ordinal,
          row.start,
          row.end,
          row.page,
          row.hash,
        );
      }
    });
  }

  writeGenerationChunks(generationId: string, rows: GenerationChunk[]) {
    if (!rows.length) return;
    transaction(this.db, () => {
      const insertChunk = this.db.prepare(
        `INSERT OR IGNORE INTO generation_chunks(
          generation_id, chunk_id, document_id, document_version_id,
          document_name, mime_type, ordinal, start, end, page, content_hash, content
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insertFts = this.db.prepare(
        'INSERT INTO chunk_fts(content, generation_id, chunk_id) VALUES (?,?,?)',
      );
      for (const row of rows) {
        const res = insertChunk.run(
          generationId,
          row.chunkId,
          row.documentId,
          row.documentVersionId,
          row.documentName,
          row.mimeType,
          row.ordinal,
          row.start,
          row.end,
          row.page,
          row.contentHash,
          row.content,
        );
        if (res.changes > 0) {
          insertFts.run(row.content, generationId, row.chunkId);
        }
      }
    });
  }

  verifySqliteCounts(generationId: string) {
    const chunkRow = this.db
      .prepare(
        'SELECT count(*) AS n FROM generation_chunks WHERE generation_id = ?',
      )
      .get(generationId);
    const ftsRow = this.db
      .prepare('SELECT count(*) AS n FROM chunk_fts WHERE generation_id = ?')
      .get(generationId);
    return {
      chunkCount: Number(chunkRow?.n ?? 0),
      ftsCount: Number(ftsRow?.n ?? 0),
    };
  }

  markReady(
    generationId: string,
    info: {
      chunkCount: number;
      embeddingDimensions?: number;
      qdrantCollection?: string;
    },
  ) {
    transaction(this.db, () => {
      const res = this.db
        .prepare(
          `UPDATE index_generations
           SET state = 'ready', chunk_count = ?, embedding_dimensions = ?,
               qdrant_collection = ?, error_message = NULL, ready_at = ?
           WHERE id = ? AND state = 'building'`,
        )
        .run(
          info.chunkCount,
          info.embeddingDimensions ?? null,
          info.qdrantCollection ?? null,
          new Date(this.now()).toISOString(),
          generationId,
        );
      if (!res.changes) {
        throw new ApiError(
          409,
          'conflict',
          'Generation is no longer in building state.',
        );
      }
    });
  }

  markFailed(generationId: string, message: string) {
    transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE index_generations
           SET state = 'failed', error_message = ?
           WHERE id = ? AND state = 'building'`,
        )
        .run(message, generationId);
      // Clean unready FTS rows for this failed generation without touching any other generation.
      this.db
        .prepare('DELETE FROM chunk_fts WHERE generation_id = ?')
        .run(generationId);
    });
  }

  allChunks(generationId: string): GenerationChunk[] {
    return this.db
      .prepare(
        `SELECT chunk_id AS chunkId, document_id AS documentId,
                document_version_id AS documentVersionId, document_name AS documentName,
                mime_type AS mimeType, ordinal, start, end, page,
                content_hash AS contentHash, content
         FROM generation_chunks
         WHERE generation_id = ?
         ORDER BY document_id ASC, ordinal ASC`,
      )
      .all(generationId)
      .map((row) => generationChunk.parse(row));
  }

  chunks(generationId: string, afterOrdinal = -1, limit = 100) {
    this.getStored(generationId);
    const rows = this.db
      .prepare(
        `SELECT rowid, chunk_id AS chunkId, document_id AS documentId,
                document_version_id AS documentVersionId, document_name AS documentName,
                mime_type AS mimeType, ordinal, start, end, page,
                content_hash AS contentHash, content
         FROM generation_chunks
         WHERE generation_id = ? AND rowid > ?
         ORDER BY rowid ASC
         LIMIT ?`,
      )
      .all(generationId, afterOrdinal, limit + 1);
    const items = rows.slice(0, limit).map((row) =>
      generationChunk.parse({
        chunkId: row.chunkId,
        documentId: row.documentId,
        documentVersionId: row.documentVersionId,
        documentName: row.documentName,
        mimeType: row.mimeType,
        ordinal: row.ordinal,
        start: row.start,
        end: row.end,
        page: row.page,
        contentHash: row.contentHash,
        content: row.content,
      }),
    );
    const lastRow = rows[limit - 1];
    return {
      items,
      nextCursor: rows.length > limit && lastRow ? String(lastRow.rowid) : null,
    };
  }

  chunksByIds(
    generationId: string,
    chunkIds: string[],
  ): Map<string, GenerationChunk> {
    const map = new Map<string, GenerationChunk>();
    if (!chunkIds.length) return map;
    const unique = [...new Set(chunkIds)];
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT chunk_id AS chunkId, document_id AS documentId,
                document_version_id AS documentVersionId, document_name AS documentName,
                mime_type AS mimeType, ordinal, start, end, page,
                content_hash AS contentHash, content
         FROM generation_chunks
         WHERE generation_id = ? AND chunk_id IN (${placeholders})`,
      )
      .all(generationId, ...unique);
    for (const row of rows) {
      const parsed = generationChunk.parse(row);
      map.set(parsed.chunkId, parsed);
    }
    return map;
  }

  keywordSearch(
    generationId: string,
    ftsMatch: string,
    filters: MetadataFilters | undefined,
    limit: number,
  ): KeywordHitRow[] {
    const params: SQLInputValue[] = [ftsMatch, generationId];
    const clauses = [
      'chunk_fts MATCH ?',
      'chunk_fts.generation_id = ?',
      "g.state = 'ready'",
    ];

    if (filters?.documentIds?.length) {
      clauses.push(
        `gc.document_id IN (${filters.documentIds.map(() => '?').join(',')})`,
      );
      params.push(...filters.documentIds);
    }
    if (filters?.documentNames?.length) {
      clauses.push(
        `gc.document_name IN (${filters.documentNames.map(() => '?').join(',')})`,
      );
      params.push(...filters.documentNames);
    }
    if (filters?.mimeTypes?.length) {
      clauses.push(
        `gc.mime_type IN (${filters.mimeTypes.map(() => '?').join(',')})`,
      );
      params.push(...filters.mimeTypes);
    }
    if (filters?.pageMin !== undefined) {
      clauses.push('gc.page >= ?');
      params.push(filters.pageMin);
    }
    if (filters?.pageMax !== undefined) {
      clauses.push('gc.page <= ?');
      params.push(filters.pageMax);
    }

    params.push(limit);
    const sql = `
      SELECT gc.chunk_id AS chunkId, gc.document_id AS documentId,
             gc.document_version_id AS documentVersionId, gc.document_name AS documentName,
             gc.mime_type AS mimeType, gc.ordinal, gc.start, gc.end, gc.page,
             gc.content_hash AS contentHash, gc.content,
             bm25(chunk_fts) AS bm25Score
      FROM chunk_fts
      JOIN index_generations g ON g.id = chunk_fts.generation_id
      JOIN generation_chunks gc
        ON gc.generation_id = chunk_fts.generation_id
       AND gc.chunk_id = chunk_fts.chunk_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY bm25(chunk_fts) ASC, gc.chunk_id ASC
      LIMIT ?
    `;

    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({
        chunk: generationChunk.parse({
          chunkId: row.chunkId,
          documentId: row.documentId,
          documentVersionId: row.documentVersionId,
          documentName: row.documentName,
          mimeType: row.mimeType,
          ordinal: row.ordinal,
          start: row.start,
          end: row.end,
          page: row.page,
          contentHash: row.contentHash,
          content: row.content,
        }),
        // SQLite FTS5 bm25() returns negative scores where more negative is better.
        score: -Number(row.bm25Score) || 0,
      }));
  }
}
