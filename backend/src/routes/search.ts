import type { Request, Response } from 'express';
import type { OpenAIClient } from '../lib/openaiClient.js';
import type { QdrantClient } from '../lib/qdrantClient.js';

interface SearchRequestBody {
  pipelineId: string;
  question: string;
  topK?: number;
  collectionName?: string;
}

export const createSearchHandler = (
  openai: OpenAIClient,
  qdrant: QdrantClient
) =>
  async (req: Request<unknown, unknown, SearchRequestBody>, res: Response) => {
    const { pipelineId, question, topK = 5, collectionName } = req.body;

    if (!pipelineId || !question || !question.trim()) {
      return res.status(400).json({ error: 'pipelineId and question are required.' });
    }

    try {
      const { vectors } = await openai.createEmbeddings([question]);
      if (!vectors.length) {
        throw new Error('Embedding API returned no vectors.');
      }

      const results = await qdrant.search(
        vectors[0],
        Math.max(1, Math.min(50, topK)),
        { pipelineId },
        collectionName
      );

      res.json({ matches: results });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
