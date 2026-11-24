import type { Request, Response } from 'express';
import type { OpenAIClient } from '../lib/openaiClient.js';
import type { QdrantClient, QdrantPoint } from '../lib/qdrantClient.js';

interface ChunkPayload {
  documentId?: string;
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

interface UpsertRequestBody {
  pipelineId: string;
  documentId?: string;
  embeddingModel?: string;
  chunks: ChunkPayload[];
}

export const createEmbeddingsHandler =
  (openai: Pick<OpenAIClient, 'createEmbeddings'>, qdrant: QdrantClient) =>
  async (req: Request<unknown, unknown, UpsertRequestBody>, res: Response) => {
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
    const { pipelineId, documentId, embeddingModel, chunks } = req.body;
    const normalizedPipelineId =
      typeof pipelineId === 'string' ? pipelineId.trim() : '';
    const normalizedEmbeddingModel =
      typeof embeddingModel === 'string' ? embeddingModel.trim() : undefined;

    if (
      !normalizedPipelineId ||
      !Array.isArray(chunks) ||
      chunks.length === 0
    ) {
      return res
        .status(400)
        .json({ error: 'pipelineId and at least one chunk are required.' });
    }

    if (
      (documentId !== undefined && typeof documentId !== 'string') ||
      chunks.some(
        (chunk) =>
          !chunk ||
          typeof chunk.id !== 'string' ||
          !chunk.id.trim() ||
          typeof chunk.text !== 'string' ||
          !chunk.text.trim() ||
          (chunk.documentId !== undefined &&
            typeof chunk.documentId !== 'string'),
      )
    ) {
      return res
        .status(400)
        .json({
          error: 'Chunks require an id, text, and valid document identifiers.',
        });
    }
    if (
      chunks.some(
        ({ metadata }) =>
          metadata !== undefined &&
          (!metadata ||
            typeof metadata !== 'object' ||
            Array.isArray(metadata) ||
            ['pipelineId', 'documentId', 'chunkId', 'text'].some((key) =>
              Object.hasOwn(metadata, key),
            )),
      )
    ) {
      return res
        .status(400)
        .json({ error: 'Invalid chunk metadata or reserved payload field.' });
    }
    const texts = chunks.map((chunk) => chunk.text.trim());

    try {
      const { vectors } = await openai.createEmbeddings(texts, {
        model: normalizedEmbeddingModel,
      });

      if (vectors.length !== chunks.length) {
        throw new Error('Mismatch between embedding vectors and chunk count.');
      }

      const vectorSize = vectors[0].length;
      if (
        !vectorSize ||
        vectors.some(
          (vector) =>
            vector.length !== vectorSize || !vector.every(Number.isFinite),
        )
      ) {
        throw new Error(
          'Embedding API returned invalid or inconsistent vectors.',
        );
      }
      const targetCollection = qdrant.collectionNameForPipeline(
        vectorSize,
        normalizedPipelineId,
      );

      await qdrant.ensureCollection(vectorSize, targetCollection);
      await qdrant.deletePipelinePoints(normalizedPipelineId, targetCollection);

      const points: QdrantPoint[] = vectors.map((vector, index) => {
        const chunk = chunks[index];
        return {
          id: chunk.id,
          vector,
          payload: {
            ...(chunk.metadata ?? {}),
            pipelineId: normalizedPipelineId,
            documentId: chunk.documentId ?? documentId,
            chunkId: chunk.id,
            text: chunk.text,
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
      const message =
        error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
