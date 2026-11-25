import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  createGenerationRequest,
  generationBatch,
  generatorProvenance,
  promoteProposalsRequest,
  promoteProposalsResult,
  qrel,
  reviewProposalPatch,
  sourceSpan,
  syntheticProposal,
  taskInput,
  z,
  type Capabilities,
  type CreateGenerationRequestRaw,
  type CreateGenerationResult,
  type GenerationBatch,
  type GeneratorProvenance,
  type PromoteProposalsRequest,
  type PromoteProposalsResult,
  type ProviderKind,
  type ReviewProposalPatch,
  type SourceSpan,
  type SyntheticProposal,
} from '@rag-eval/contracts';
import { ApiError, missing } from '../errors.js';
import {
  computeVerbatimLeakage,
  LEAKAGE_VERBATIM_RATIO_THRESHOLD,
  normalizeQuestionText,
  SYNTHETIC_PROMPT_VERSION,
  validateProposalQrels,
  validateSourceSpans,
  type FrozenDocumentText,
} from '../generation/validation.js';
import { mediaType } from '../ingestion/blobs.js';
import { sha256 } from '../ingestion/chunks.js';
import { fromPages } from '../ingestion/local.js';
import { validateGenerationParams } from '../providers/registry.js';
import { transaction } from './database.js';
import type { Datasets } from './datasets.js';
import { paginate } from './definitions.js';
import type { Indexes, RevisionSourceDocument } from './indexes.js';
import type { Jobs } from './jobs.js';

export interface CreateGenerationOptions {
  capabilities: Capabilities;
  idempotencyKey?: string | null;
}

export interface GenerationBatchDocumentPlan {
  documentId: string;
  documentVersionId: string;
  documentName: string;
  ordinal: number;
  state: 'pending' | 'succeeded' | 'failed' | 'cancelled';
}

export interface GenerationExecutionPlan {
  batch: GenerationBatch;
  documents: GenerationBatchDocumentPlan[];
  revisionSources: RevisionSourceDocument[];
  existingNormalizedQuestions: string[];
  existingSpans: SourceSpan[];
}

export interface NewSyntheticProposalRecord {
  question: string;
  normalizedQuestion: string;
  expectedAnswer: string;
  acceptanceRule: string;
  referenceFacts: string[];
  answerable: boolean;
  sourceSpans: SourceSpan[];
  qrels: Array<{ documentId: string; grade: number }>;
  provenance: GeneratorProvenance;
  leakageScore: number;
  leakageFlagged: boolean;
  leakageReason: string | null;
}

function decodeBatch(
  row: Record<string, unknown>,
  jobId: string,
  workerOnline: boolean,
): GenerationBatch {
  return generationBatch.parse({
    id: row.id,
    datasetId: row.dataset_id,
    datasetRevision: row.dataset_revision,
    state: row.state,
    stage: row.stage,
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    params: JSON.parse(String(row.params)),
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    proposedCount: row.proposed_count,
    deduplicatedCount: row.deduplicated_count,
    invalidSpanCount: row.invalid_span_count,
    leakageFlaggedCount: row.leakage_flagged_count,
    jobId,
    workerOnline,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  });
}

function decodeProposal(row: Record<string, unknown>): SyntheticProposal {
  return syntheticProposal.parse({
    id: row.id,
    batchId: row.batch_id,
    datasetId: row.dataset_id,
    datasetRevision: row.dataset_revision,
    question: row.question,
    expectedAnswer: row.expected_answer,
    acceptanceRule: row.acceptance_rule,
    referenceFacts: JSON.parse(String(row.reference_facts)),
    answerable: Number(row.answerable) === 1,
    sourceSpans: z
      .array(sourceSpan)
      .parse(JSON.parse(String(row.source_spans))),
    qrels: z.array(qrel).parse(JSON.parse(String(row.qrels))),
    provenance: generatorProvenance.parse(JSON.parse(String(row.provenance))),
    leakageScore: Number(row.leakage_score),
    leakageFlagged: Number(row.leakage_flagged) === 1,
    leakageReason: row.leakage_reason ?? null,
    reviewStatus: row.review_status,
    edited: Number(row.edited) === 1,
    promotedTaskId: row.promoted_task_id ?? null,
    promotedRevision:
      row.promoted_revision === null ? null : Number(row.promoted_revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function extractSourceTextSync(doc: RevisionSourceDocument): string {
  if (doc.extraction) return doc.extraction.text;
  const mime = mediaType(doc.name, doc.mimeType || 'text/plain');
  if (!mime.startsWith('text/')) {
    throw new ApiError(
      409,
      'conflict',
      `Document "${doc.name}" must be parsed before text validation.`,
    );
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.from(doc.inline),
  );
  return fromPages([decoded]).text;
}

function formatTaskProvenance(proposal: SyntheticProposal): string {
  const base = `synthetic:${proposal.provenance.provider}/${proposal.provenance.model} (${proposal.provenance.promptVersion}, r${proposal.datasetRevision})`;
  return base.slice(0, 200);
}

export class Generations {
  constructor(
    private readonly db: DatabaseSync,
    private readonly datasets: Datasets,
    private readonly indexes: Indexes,
    private readonly jobs: Jobs,
    private readonly now = Date.now,
  ) {}

  private latestJobId(batchId: string): string {
    const row = this.db
      .prepare(
        'SELECT id FROM generation_jobs WHERE batch_id = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(batchId);
    return String(row?.id ?? '');
  }

  private resolveFrozenTexts(
    datasetId: string,
    datasetRevision: number,
  ): Map<string, FrozenDocumentText> {
    const docs = this.indexes.revisionDocuments(datasetId, datasetRevision);
    const map = new Map<string, FrozenDocumentText>();
    for (const doc of docs) {
      map.set(doc.documentVersionId, {
        documentId: doc.documentId,
        documentVersionId: doc.documentVersionId,
        name: doc.name,
        text: extractSourceTextSync(doc),
      });
    }
    return map;
  }

  createBatch(
    datasetId: string,
    rawRequest: CreateGenerationRequestRaw,
    options: CreateGenerationOptions,
  ): CreateGenerationResult {
    const request = createGenerationRequest.parse(rawRequest);
    const chatProfile = options.capabilities.profiles.find(
      (p) => p.role === 'chat' && (!request.model || p.model === request.model),
    );
    if (!chatProfile?.capabilities.chat) {
      throw new ApiError(
        422,
        'missing_capability',
        request.model
          ? `Chat profile "${request.model}" is unavailable for synthetic question generation.`
          : 'Synthetic question generation requires a configured chat profile.',
      );
    }

    const effectiveTemperature =
      request.temperature !== undefined
        ? request.temperature
        : chatProfile.capabilities.temperature
          ? 0.2
          : undefined;
    const effectiveMaxTokens = request.maxTokens ?? 2000;
    validateGenerationParams(chatProfile, {
      temperature: effectiveTemperature,
      maxTokens: effectiveMaxTokens,
    });

    const idempotencyKey = options.idempotencyKey ?? null;
    const requestHash = sha256(
      JSON.stringify([
        'create-generation-v1',
        datasetId,
        request,
        chatProfile.provider,
        chatProfile.model,
      ]),
    );

    return transaction(this.db, () => {
      const replayed = this.jobs.replayGeneration(idempotencyKey, requestHash);
      if (replayed) {
        return {
          batch: this.getBatch(replayed.batchId),
          job: this.jobs.get(replayed.jobId),
          reused: true,
        };
      }

      const head = this.datasets.head(datasetId, request.datasetRevision);
      if (request.datasetRevision === undefined && head.archived) {
        throw new ApiError(
          409,
          'archived',
          'Cannot generate questions for an archived dataset.',
        );
      }

      const revisionDocs = this.indexes.revisionDocuments(
        datasetId,
        head.revision,
      );
      let selectedDocs = revisionDocs;
      if (request.documentIds?.length) {
        const docById = new Map(revisionDocs.map((d) => [d.documentId, d]));
        selectedDocs = request.documentIds.map((docId) => {
          const found = docById.get(docId);
          if (!found) {
            throw new ApiError(
              400,
              'invalid_input',
              `Document "${docId}" is outside dataset revision ${head.revision}.`,
            );
          }
          return found;
        });
      }

      const batchId = randomUUID();
      const nowIso = new Date(this.now()).toISOString();
      const params = {
        seed: request.seed,
        temperature:
          effectiveTemperature === undefined ? null : effectiveTemperature,
        maxTokens: chatProfile.capabilities.maxTokens
          ? effectiveMaxTokens
          : null,
        structuredOutput: chatProfile.capabilities.structuredOutput,
        targetCount: request.count,
        includeUnanswerable: request.includeUnanswerable,
        leakageThreshold: LEAKAGE_VERBATIM_RATIO_THRESHOLD,
        documentIds: selectedDocs.map((d) => d.documentId),
      };

      this.db
        .prepare(
          `INSERT INTO generation_batches(
            id, dataset_id, dataset_revision, state, stage,
            provider, model, prompt_version, params,
            total_documents, processed_documents, proposed_count,
            deduplicated_count, invalid_span_count, leakage_flagged_count,
            created_at, request_key, request_hash
          ) VALUES (?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)`,
        )
        .run(
          batchId,
          datasetId,
          head.revision,
          chatProfile.provider,
          chatProfile.model,
          SYNTHETIC_PROMPT_VERSION,
          JSON.stringify(params),
          selectedDocs.length,
          nowIso,
          idempotencyKey,
          requestHash,
        );

      const insertDoc = this.db.prepare(
        `INSERT INTO generation_batch_documents(
          batch_id, document_id, document_version_id, document_name, ordinal, state, artifact_id
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      );
      selectedDocs.forEach((doc, ordinal) => {
        insertDoc.run(
          batchId,
          doc.documentId,
          doc.documentVersionId,
          doc.name,
          ordinal,
          doc.artifactId,
        );
      });

      const jobId = this.jobs.enqueueGeneration(
        batchId,
        idempotencyKey,
        requestHash,
      );
      return {
        batch: this.getBatch(batchId),
        job: this.jobs.get(jobId),
        reused: false,
      };
    });
  }

  getBatch(batchId: string): GenerationBatch {
    const row = this.db
      .prepare('SELECT * FROM generation_batches WHERE id = ?')
      .get(batchId);
    if (!row) return missing();
    return decodeBatch(row, this.latestJobId(batchId), this.jobs.online());
  }

  listBatches(datasetId: string, limit: number, cursor?: string) {
    this.datasets.head(datasetId);
    const clauses = ['dataset_id = ?'];
    const params: SQLInputValue[] = [datasetId];
    if (cursor) {
      const sep = cursor.lastIndexOf('|');
      if (sep <= 0) {
        throw new ApiError(400, 'invalid_input', 'Invalid generation cursor.');
      }
      const cursorTime = cursor.slice(0, sep);
      const cursorId = cursor.slice(sep + 1);
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursorTime, cursorTime, cursorId);
    }
    params.push(limit + 1);
    const online = this.jobs.online();
    const rows = this.db
      .prepare(
        `SELECT * FROM generation_batches
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params)
      .map((row) => decodeBatch(row, this.latestJobId(String(row.id)), online));
    return paginate(rows, limit, (item) => `${item.createdAt}|${item.id}`);
  }

  listProposals(
    datasetId: string,
    limit: number,
    cursor?: string,
    filters: {
      batchId?: string;
      status?: SyntheticProposal['reviewStatus'];
    } = {},
  ) {
    this.datasets.head(datasetId);
    const clauses = ['dataset_id = ?'];
    const params: SQLInputValue[] = [datasetId];
    if (filters.batchId) {
      clauses.push('batch_id = ?');
      params.push(filters.batchId);
    }
    if (filters.status) {
      clauses.push('review_status = ?');
      params.push(filters.status);
    }
    if (cursor) {
      const sep = cursor.lastIndexOf('|');
      if (sep <= 0) {
        throw new ApiError(400, 'invalid_input', 'Invalid proposal cursor.');
      }
      const cursorTime = cursor.slice(0, sep);
      const cursorId = cursor.slice(sep + 1);
      clauses.push('(created_at < ? OR (created_at = ? AND id > ?))');
      params.push(cursorTime, cursorTime, cursorId);
    }
    params.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT * FROM synthetic_proposals
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id ASC
         LIMIT ?`,
      )
      .all(...params)
      .map((row) => decodeProposal(row));
    return paginate(rows, limit, (item) => `${item.createdAt}|${item.id}`);
  }

  getProposal(datasetId: string, proposalId: string): SyntheticProposal {
    const row = this.db
      .prepare(
        'SELECT * FROM synthetic_proposals WHERE dataset_id = ? AND id = ?',
      )
      .get(datasetId, proposalId);
    if (!row) return missing();
    return decodeProposal(row);
  }

  reviewProposal(
    datasetId: string,
    proposalId: string,
    rawPatch: ReviewProposalPatch,
  ): SyntheticProposal {
    const patch = reviewProposalPatch.parse(rawPatch);
    return transaction(this.db, () => {
      const current = this.getProposal(datasetId, proposalId);
      if (current.reviewStatus === 'promoted') {
        throw new ApiError(
          409,
          'conflict',
          'Promoted proposals cannot be modified.',
        );
      }

      const frozenTexts = this.resolveFrozenTexts(
        datasetId,
        current.datasetRevision,
      );
      const validDocIds = new Set(
        Array.from(frozenTexts.values()).map((d) => d.documentId),
      );
      const corpusTexts = Array.from(frozenTexts.values()).map((d) => d.text);

      const nextQuestion = patch.question ?? current.question;
      const nextExpectedAnswer = patch.expectedAnswer ?? current.expectedAnswer;
      const nextAcceptanceRule = patch.acceptanceRule ?? current.acceptanceRule;
      const nextFacts = patch.referenceFacts ?? current.referenceFacts;
      const nextAnswerable = patch.answerable ?? current.answerable;
      const nextReviewStatus = patch.reviewStatus ?? current.reviewStatus;

      let nextQrels = current.qrels;
      if (patch.qrels !== undefined || patch.answerable !== undefined) {
        const qrelCheck = validateProposalQrels(
          patch.qrels ?? current.qrels,
          nextAnswerable,
          current.sourceSpans,
          validDocIds,
        );
        if (!qrelCheck.valid) {
          throw new ApiError(400, 'invalid_input', qrelCheck.reason);
        }
        nextQrels = qrelCheck.qrels;
      }

      const contentEdited =
        patch.question !== undefined ||
        patch.expectedAnswer !== undefined ||
        patch.acceptanceRule !== undefined ||
        patch.referenceFacts !== undefined ||
        patch.answerable !== undefined ||
        patch.qrels !== undefined;

      const leakage = computeVerbatimLeakage(nextExpectedAnswer, corpusTexts);
      const updatedAt = new Date(this.now()).toISOString();

      this.db
        .prepare(
          `UPDATE synthetic_proposals
           SET question = ?, normalized_question = ?,
               expected_answer = ?, acceptance_rule = ?,
               reference_facts = ?, answerable = ?, qrels = ?,
               leakage_score = ?, leakage_flagged = ?, leakage_reason = ?,
               review_status = ?, edited = CASE WHEN ? THEN 1 ELSE edited END,
               updated_at = ?
           WHERE id = ? AND dataset_id = ?`,
        )
        .run(
          nextQuestion,
          normalizeQuestionText(nextQuestion),
          nextExpectedAnswer,
          nextAcceptanceRule,
          JSON.stringify(nextFacts),
          Number(nextAnswerable),
          JSON.stringify(nextQrels),
          leakage.score,
          Number(leakage.flagged),
          leakage.reason,
          nextReviewStatus,
          Number(contentEdited),
          updatedAt,
          proposalId,
          datasetId,
        );

      return this.getProposal(datasetId, proposalId);
    });
  }

  /**
   * Promotes explicitly accepted proposals into a brand-new dataset revision
   * (leaving the previous revision completely untouched) while preventing
   * verbatim-answer leakage against the target revision's indexed corpus.
   */
  promoteProposals(
    datasetId: string,
    expectedRevision: number,
    rawRequest: PromoteProposalsRequest,
  ): PromoteProposalsResult {
    const request = promoteProposalsRequest.parse(rawRequest);
    return transaction(this.db, () => {
      const current = this.datasets.head(datasetId);
      if (current.archived) {
        throw new ApiError(409, 'archived', 'This resource has been archived.');
      }
      if (current.revision !== expectedRevision) {
        throw new ApiError(
          409,
          'stale_revision',
          'Another editor saved changes. Load the latest revision before retrying.',
        );
      }

      const targetFrozenTexts = this.resolveFrozenTexts(
        datasetId,
        expectedRevision,
      );
      const targetDocIds = new Set(
        Array.from(targetFrozenTexts.values()).map((d) => d.documentId),
      );
      const targetCorpusTexts = Array.from(targetFrozenTexts.values()).map(
        (d) => d.text,
      );

      const proposals: SyntheticProposal[] = request.proposalIds.map(
        (proposalId) => this.getProposal(datasetId, proposalId),
      );

      for (const proposal of proposals) {
        if (proposal.reviewStatus !== 'accepted') {
          throw new ApiError(
            409,
            'conflict',
            proposal.reviewStatus === 'promoted'
              ? `Proposal "${proposal.id}" was already promoted.`
              : `Proposal "${proposal.id}" must be accepted before promotion (current status: ${proposal.reviewStatus}).`,
          );
        }

        // Re-verify source spans exist in the target dataset revision (supporting document
        // versions must still be present and unchanged in the target revision).
        const spanCheck = validateSourceSpans(
          proposal.sourceSpans,
          targetFrozenTexts,
        );
        if (!spanCheck.valid) {
          throw new ApiError(
            409,
            'conflict',
            `Cannot promote proposal "${proposal.id}" into revision ${expectedRevision}: ${spanCheck.reason}`,
          );
        }

        // Reject promotion when any required positive qrel is absent from the target revision
        // or when an answerable task would be left without a positive gold document.
        const missingPositive = proposal.qrels.filter(
          (q) => q.grade > 0 && !targetDocIds.has(q.documentId),
        );
        if (missingPositive.length > 0) {
          throw new ApiError(
            409,
            'conflict',
            `Cannot promote proposal "${proposal.id}": positive relevance label(s) reference document(s) absent from dataset revision ${expectedRevision}.`,
          );
        }
        const remainingPositive = proposal.qrels.filter(
          (q) => q.grade > 0 && targetDocIds.has(q.documentId),
        );
        if (proposal.answerable && remainingPositive.length === 0) {
          throw new ApiError(
            409,
            'conflict',
            `Cannot promote answerable proposal "${proposal.id}": no positive gold documents remain in dataset revision ${expectedRevision}.`,
          );
        }

        // Prevent verbatim leakage against any index built from the target dataset revision's corpus.
        const leakage = computeVerbatimLeakage(
          proposal.expectedAnswer,
          targetCorpusTexts,
        );
        if (leakage.flagged) {
          throw new ApiError(
            409,
            'conflict',
            `Cannot promote proposal "${proposal.id}" due to verbatim answer leakage (${Math.round(leakage.score * 100)}% overlap with corpus text). Paraphrase the expected answer before promoting.`,
          );
        }
      }

      const nextRevision = expectedRevision + 1;
      const nowIso = new Date(this.now()).toISOString();

      this.db
        .prepare('INSERT INTO dataset_revisions VALUES (?, ?, ?, ?)')
        .run(datasetId, nextRevision, current.name, nowIso);
      for (const table of ['revision_tasks', 'revision_documents']) {
        this.db
          .prepare(
            `INSERT INTO ${table} SELECT dataset_id, ?, version_id FROM ${table} WHERE dataset_id = ? AND revision = ?`,
          )
          .run(nextRevision, datasetId, expectedRevision);
      }

      const promotedTaskIds: string[] = [];
      for (const proposal of proposals) {
        const filteredQrels = proposal.qrels.filter((q) =>
          targetDocIds.has(q.documentId),
        );
        const parsed = taskInput.parse({
          question: proposal.question,
          expectedAnswer: proposal.expectedAnswer,
          acceptanceRule: proposal.acceptanceRule,
          referenceFacts: proposal.referenceFacts,
          answerable: proposal.answerable,
          provenance: formatTaskProvenance(proposal),
          pool: 'partial',
          qrels: filteredQrels,
        });

        const taskId = randomUUID();
        const taskVersionId = randomUUID();
        const { qrels: taskQrels, pool, ...fields } = parsed;

        this.db
          .prepare('INSERT INTO tasks VALUES (?, ?)')
          .run(taskId, datasetId);
        this.db
          .prepare('INSERT INTO task_versions VALUES (?, ?, ?, ?)')
          .run(taskVersionId, taskId, JSON.stringify(fields), pool);
        this.db
          .prepare('INSERT INTO revision_tasks VALUES (?, ?, ?)')
          .run(datasetId, nextRevision, taskVersionId);

        for (const q of taskQrels) {
          this.db
            .prepare(
              `INSERT INTO qrels SELECT ?, d.id, ?
               FROM revision_documents r JOIN document_versions d ON d.id = r.version_id
               WHERE r.dataset_id = ? AND r.revision = ? AND d.document_id = ?`,
            )
            .run(taskVersionId, q.grade, datasetId, nextRevision, q.documentId);
        }

        this.db
          .prepare(
            `UPDATE synthetic_proposals
             SET review_status = 'promoted',
                 promoted_task_id = ?,
                 promoted_revision = ?,
                 updated_at = ?
             WHERE id = ? AND dataset_id = ?`,
          )
          .run(taskId, nextRevision, nowIso, proposal.id, datasetId);

        promotedTaskIds.push(taskId);
      }

      this.db
        .prepare('UPDATE datasets SET revision = ? WHERE id = ?')
        .run(nextRevision, datasetId);

      return promoteProposalsResult.parse({
        dataset: this.datasets.get(datasetId),
        promotedCount: promotedTaskIds.length,
        promotedTaskIds,
      });
    });
  }

  // --- Worker execution & durable checkpoint helpers ---

  loadExecutionPlan(batchId: string): GenerationExecutionPlan {
    const batch = this.getBatch(batchId);
    const docRows = this.db
      .prepare(
        `SELECT document_id AS documentId, document_version_id AS documentVersionId,
                document_name AS documentName, ordinal, state, artifact_id AS artifactId
         FROM generation_batch_documents
         WHERE batch_id = ?
         ORDER BY ordinal ASC`,
      )
      .all(batchId);
    const docs: GenerationBatchDocumentPlan[] = docRows.map((row) => ({
      documentId: String(row.documentId),
      documentVersionId: String(row.documentVersionId),
      documentName: String(row.documentName),
      ordinal: Number(row.ordinal),
      state: row.state as GenerationBatchDocumentPlan['state'],
    }));

    const hasPinnedArtifacts = docRows.some(
      (r) => typeof r.artifactId === 'string',
    );
    const pinnedArtifacts = hasPinnedArtifacts
      ? Object.fromEntries(
          docRows.map((r) => [
            String(r.documentVersionId),
            typeof r.artifactId === 'string' ? r.artifactId : null,
          ]),
        )
      : undefined;
    const allRevisionSources = this.indexes.revisionDocuments(
      batch.datasetId,
      batch.datasetRevision,
    );
    const revisionSources = pinnedArtifacts
      ? this.indexes.revisionDocuments(batch.datasetId, batch.datasetRevision, {
          ...Object.fromEntries(
            allRevisionSources.map((s) => [s.documentVersionId, s.artifactId]),
          ),
          ...pinnedArtifacts,
        })
      : allRevisionSources;

    // Existing questions from the frozen dataset revision + existing non-rejected proposals
    const frozenTasks = this.datasets.get(
      batch.datasetId,
      batch.datasetRevision,
    ).tasks;
    const existingQuestions = new Set<string>(
      frozenTasks.map((t) => normalizeQuestionText(t.question)),
    );
    const existingSpans: SourceSpan[] = [];

    const existingRows = this.db
      .prepare(
        `SELECT normalized_question, source_spans
         FROM synthetic_proposals
         WHERE dataset_id = ? AND review_status != 'rejected'`,
      )
      .all(batch.datasetId);
    for (const row of existingRows) {
      existingQuestions.add(String(row.normalized_question));
      const spans = z
        .array(sourceSpan)
        .parse(JSON.parse(String(row.source_spans)));
      existingSpans.push(...spans);
    }

    return {
      batch,
      documents: docs,
      revisionSources,
      existingNormalizedQuestions: Array.from(existingQuestions),
      existingSpans,
    };
  }

  markBatchStarted(batchId: string, guard?: () => void) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare(
          `UPDATE generation_batches
           SET state = 'running', stage = 'extracting',
               started_at = coalesce(started_at, ?)
           WHERE id = ? AND state IN ('queued', 'running')`,
        )
        .run(new Date(this.now()).toISOString(), batchId);
    });
  }

  updateBatchStage(batchId: string, stage: string, guard?: () => void) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare(
          "UPDATE generation_batches SET stage = ? WHERE id = ? AND state = 'running'",
        )
        .run(stage, batchId);
    });
  }

  saveDocumentProposals(
    input: {
      batchId: string;
      datasetId: string;
      datasetRevision: number;
      documentVersionId: string;
      rawResponseHash: string;
      requestId: string | null;
      proposals: NewSyntheticProposalRecord[];
      deduplicatedCount: number;
      invalidSpanCount: number;
      leakageFlaggedCount: number;
    },
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      const nowIso = new Date(this.now()).toISOString();
      const insertProposal = this.db.prepare(
        `INSERT INTO synthetic_proposals(
          id, batch_id, dataset_id, dataset_revision,
          question, normalized_question, expected_answer, acceptance_rule,
          reference_facts, answerable, source_spans, qrels, provenance,
          leakage_score, leakage_flagged, leakage_reason,
          review_status, edited, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      );
      for (const item of input.proposals) {
        insertProposal.run(
          randomUUID(),
          input.batchId,
          input.datasetId,
          input.datasetRevision,
          item.question,
          item.normalizedQuestion,
          item.expectedAnswer,
          item.acceptanceRule,
          JSON.stringify(item.referenceFacts),
          Number(item.answerable),
          JSON.stringify(item.sourceSpans),
          JSON.stringify(item.qrels),
          JSON.stringify(item.provenance),
          item.leakageScore,
          Number(item.leakageFlagged),
          item.leakageReason,
          nowIso,
          nowIso,
        );
      }

      this.db
        .prepare(
          `UPDATE generation_batch_documents
           SET state = 'succeeded', raw_response_hash = ?, request_id = ?, error_message = NULL
           WHERE batch_id = ? AND document_version_id = ?`,
        )
        .run(
          input.rawResponseHash,
          input.requestId,
          input.batchId,
          input.documentVersionId,
        );

      const counts = this.db
        .prepare(
          `SELECT count(*) AS processed FROM generation_batch_documents
           WHERE batch_id = ? AND state IN ('succeeded', 'failed')`,
        )
        .get(input.batchId);
      const proposalTotals = this.db
        .prepare(
          `SELECT count(*) AS total,
                  coalesce(sum(leakage_flagged), 0) AS flagged
           FROM synthetic_proposals WHERE batch_id = ?`,
        )
        .get(input.batchId);

      this.db
        .prepare(
          `UPDATE generation_batches
           SET processed_documents = ?,
               proposed_count = ?,
               deduplicated_count = deduplicated_count + ?,
               invalid_span_count = invalid_span_count + ?,
               leakage_flagged_count = ?
           WHERE id = ?`,
        )
        .run(
          Number(counts?.processed ?? 0),
          Number(proposalTotals?.total ?? 0),
          input.deduplicatedCount,
          input.invalidSpanCount,
          Number(proposalTotals?.flagged ?? 0),
          input.batchId,
        );
    });
  }

  markDocumentFailed(
    batchId: string,
    documentVersionId: string,
    errorMessage: string,
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      this.db
        .prepare(
          `UPDATE generation_batch_documents
           SET state = 'failed', error_message = ?
           WHERE batch_id = ? AND document_version_id = ?`,
        )
        .run(errorMessage, batchId, documentVersionId);
      const counts = this.db
        .prepare(
          `SELECT count(*) AS processed FROM generation_batch_documents
           WHERE batch_id = ? AND state IN ('succeeded', 'failed')`,
        )
        .get(batchId);
      this.db
        .prepare(
          'UPDATE generation_batches SET processed_documents = ? WHERE id = ?',
        )
        .run(Number(counts?.processed ?? 0), batchId);
    });
  }

  finalizeBatch(
    batchId: string,
    state: 'succeeded' | 'failed' | 'cancelled',
    errorMessage: string | null = null,
    guard?: () => void,
  ) {
    transaction(this.db, () => {
      guard?.();
      const stage =
        state === 'succeeded'
          ? 'complete'
          : state === 'cancelled'
            ? 'cancelled'
            : 'failed';
      this.db
        .prepare(
          `UPDATE generation_batches
           SET state = ?, stage = ?, completed_at = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          state,
          stage,
          new Date(this.now()).toISOString(),
          errorMessage,
          batchId,
        );
      if (state === 'cancelled') {
        this.db
          .prepare(
            "UPDATE generation_batch_documents SET state = 'cancelled' WHERE batch_id = ? AND state = 'pending'",
          )
          .run(batchId);
      }
    });
  }

  markBatchFailed(batchId: string, message: string) {
    this.finalizeBatch(batchId, 'failed', message);
  }
}

export type { ProviderKind };
