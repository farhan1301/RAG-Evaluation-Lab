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
  chunks: ChunkPayload[];
}

export const createEmbeddingsHandler = (
  openai: OpenAIClient,
  qdrant: QdrantClient
) =>
  async (req: Request<unknown, unknown, UpsertRequestBody>, res: Response) => {
    const { pipelineId, documentId, collectionName, chunks } = req.body;

    if (!pipelineId || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'pipelineId and at least one chunk are required.' });
    }

    const texts = chunks.map((chunk) => chunk.text ?? '').map((text) => text.trim());
    if (texts.some((text) => !text)) {
      return res.status(400).json({ error: 'All chunks must include non-empty text.' });
    }

    try {
      const { vectors } = await openai.createEmbeddings(texts);

      if (vectors.length !== chunks.length) {
        throw new Error('Mismatch between embedding vectors and chunk count.');
      }

      await qdrant.ensureCollection(vectors[0].length, collectionName);

      const points: QdrantPoint[] = vectors.map((vector, index) => {
        const chunk = chunks[index];
        return {
          id: chunk.id,
          vector,
          payload: {
            pipelineId,
            documentId,
            chunkId: chunk.id,
            text: chunk.text,
            ...(chunk.metadata ?? {}),
          },
        };
      });

      await qdrant.upsertPoints(points, collectionName);

      res.json({ upserted: points.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
