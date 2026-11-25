import type { Request, Response } from 'express';
import { generateGroundedAnswer } from '../providers/answer.js';
import type { ChatProvider } from '../providers/types.js';
import type { QdrantStore } from '../retrieval/qdrant.js';
import type { LegacyEmbedder } from './embeddings.js';

interface AnswerRequestBody {
  pipelineId: string;
  question: string;
  topK?: number;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  embeddingModel?: string;
}

export interface LegacyAnswerDeps extends LegacyEmbedder {
  resolveChat(model?: string): {
    profile: { model: string };
    provider: ChatProvider;
  };
}

export const createAnswerHandler =
  (
    deps: LegacyAnswerDeps,
    qdrant: Pick<
      QdrantStore,
      'collectionForLegacyPipeline' | 'searchLegacyPipeline'
    >,
  ) =>
  async (req: Request<unknown, unknown, AnswerRequestBody>, res: Response) => {
    if (
      !req.body ||
      typeof req.body !== 'object' ||
      'collectionName' in req.body ||
      'resetCollection' in req.body
    ) {
      return res
        .status(400)
        .json({ error: 'Collection selection and reset are server-managed.' });
    }
    const { pipelineId, question, topK = 5, model, embeddingModel } = req.body;
    const normalizedPipelineId =
      typeof pipelineId === 'string' ? pipelineId.trim() : '';
    const normalizedEmbeddingModel =
      typeof embeddingModel === 'string' ? embeddingModel.trim() : undefined;

    if (
      !normalizedPipelineId ||
      typeof question !== 'string' ||
      !question.trim()
    ) {
      return res
        .status(400)
        .json({ error: 'pipelineId and question are required.' });
    }

    try {
      const startedAt = Date.now();
      const { vectors } = await deps.embed(
        [question],
        normalizedEmbeddingModel,
      );
      if (!vectors.length) {
        throw new Error('Embedding API returned no vectors.');
      }

      const vectorSize = vectors[0].length;
      const targetCollection = qdrant.collectionForLegacyPipeline(
        vectorSize,
        normalizedPipelineId,
      );

      const matches = await qdrant.searchLegacyPipeline(
        targetCollection,
        vectors[0],
        Math.max(1, Math.min(20, topK)),
        normalizedPipelineId,
      );

      const { profile, provider } = deps.resolveChat(
        model?.trim() || undefined,
      );
      const grounded = await generateGroundedAnswer({
        question,
        items: matches.slice(0, topK).map((match) => ({
          chunkId: String(match.payload?.chunkId ?? match.id),
          documentId: String(match.payload?.documentId ?? ''),
          documentName: String(match.payload?.documentName ?? 'document'),
          page:
            typeof match.payload?.page === 'number' && match.payload.page > 0
              ? match.payload.page
              : 1,
          start: 0,
          end: String(match.payload?.text ?? '').length,
          content: String(match.payload?.text ?? ''),
        })),
        provider,
        model: profile.model,
        temperature: req.body.temperature,
        maxTokens: req.body.maxTokens,
      });

      const latencyMs = Date.now() - startedAt;
      res.json({
        answer: grounded.answer,
        abstained: grounded.abstained,
        citations: grounded.citations,
        matches,
        usage: grounded.usage
          ? {
              promptTokens: grounded.usage.inputTokens,
              completionTokens: grounded.usage.outputTokens,
              totalTokens: grounded.usage.totalTokens,
            }
          : undefined,
        latencyMs,
        collection: targetCollection,
        vectorSize,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
