import type { Request, Response } from 'express';
import type { OpenAIClient } from '../lib/openaiClient.js';
import type { QdrantClient } from '../lib/qdrantClient.js';

interface SearchRequestBody {
  pipelineId: string;
  question: string;
  topK?: number;
  embeddingModel?: string;
}

export const createSearchHandler =
  (openai: Pick<OpenAIClient, 'createEmbeddings'>, qdrant: QdrantClient) =>
  async (req: Request<unknown, unknown, SearchRequestBody>, res: Response) => {
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
    const { pipelineId, question, topK = 5, embeddingModel } = req.body;
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
      const { vectors } = await openai.createEmbeddings([question], {
        model: normalizedEmbeddingModel,
      });
      if (!vectors.length) {
        throw new Error('Embedding API returned no vectors.');
      }

      const vectorSize = vectors[0].length;
      const targetCollection = qdrant.collectionNameForPipeline(
        vectorSize,
        normalizedPipelineId,
      );

      const results = await qdrant.search(
        vectors[0],
        Math.max(1, Math.min(50, topK)),
        { pipelineId: normalizedPipelineId },
        targetCollection,
      );

      res.json({ matches: results, collection: targetCollection, vectorSize });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
