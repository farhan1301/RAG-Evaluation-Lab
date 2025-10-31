import type { Request, Response } from 'express';
import type { OpenAIClient } from '../lib/openaiClient.js';
import type { QdrantClient, QdrantPoint } from '../lib/qdrantClient.js';

interface ChunkPayload {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

interface UpsertRequestBody {
  pipelineId: string;
  documentId?: string;
  collectionName?: string;
  resetCollection?: boolean;
  embeddingModel?: string;
  chunks: ChunkPayload[];
}

export const createEmbeddingsHandler = (
  openai: OpenAIClient,
  qdrant: QdrantClient
) =>
  async (req: Request<unknown, unknown, UpsertRequestBody>, res: Response) => {
    const { pipelineId, documentId, collectionName, resetCollection, embeddingModel, chunks } =
      req.body;
    const normalizedPipelineId = typeof pipelineId === 'string' ? pipelineId.trim() : '';
    const normalizedEmbeddingModel =
      typeof embeddingModel === 'string' ? embeddingModel.trim() : undefined;

    if (!normalizedPipelineId || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'pipelineId and at least one chunk are required.' });
    }

    const texts = chunks.map((chunk) => chunk.text ?? '').map((text) => text.trim());
    if (texts.some((text) => !text)) {
      return res.status(400).json({ error: 'All chunks must include non-empty text.' });
    }

    try {
      const { vectors } = await openai.createEmbeddings(texts, {
        model: normalizedEmbeddingModel,
      });

      if (vectors.length !== chunks.length) {
        throw new Error('Mismatch between embedding vectors and chunk count.');
      }

      const vectorSize = vectors[0].length;
      const targetCollection = qdrant.collectionNameForPipeline(
        vectorSize,
        normalizedPipelineId,
        collectionName
      );

      if (resetCollection) {
        await qdrant.deleteCollection(targetCollection);
      }

      await qdrant.ensureCollection(vectorSize, targetCollection);

      if (!resetCollection) {
        await qdrant.deletePipelinePoints(normalizedPipelineId, targetCollection);
      }

      const points: QdrantPoint[] = vectors.map((vector, index) => {
        const chunk = chunks[index];
        return {
          id: chunk.id,
          vector,
          payload: {
            pipelineId: normalizedPipelineId,
            documentId,
            chunkId: chunk.id,
            text: chunk.text,
            ...(chunk.metadata ?? {}),
          },
        };
      });

      await qdrant.upsertPoints(points, targetCollection);

      res.json({
        upserted: points.length,
        collection: targetCollection,
        vectorSize,
        embeddingModel: normalizedEmbeddingModel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
