import type { Request, Response } from 'express';
import type { OpenAIClient } from '../lib/openaiClient.js';
import type { QdrantClient } from '../lib/qdrantClient.js';

interface AnswerRequestBody {
  pipelineId: string;
  question: string;
  topK?: number;
  collectionName?: string;
  model?: string;
  embeddingModel?: string;
}

const buildAnswerPrompt = (question: string, contextSnippets: string[]) => {
  const context = contextSnippets.length
    ? contextSnippets.map((snippet, index) => `Context ${index + 1}:\n${snippet}`).join('\n\n')
    : 'No relevant context was retrieved. Reason from prior knowledge if possible.';

  return [
    {
      role: 'system' as const,
      content:
        'You are an assistant that answers questions using the provided context. ' +
        'Respond with a concise answer grounded in the context. If the context does not contain the answer, say that explicitly.',
    },
    {
      role: 'user' as const,
      content: ['Context:', context, '', `Question: ${question}`, '', 'Answer:'].join('\n'),
    },
  ];
};

export const createAnswerHandler = (
  openai: OpenAIClient,
  qdrant: QdrantClient
) =>
  async (req: Request<unknown, unknown, AnswerRequestBody>, res: Response) => {
    const { pipelineId, question, topK = 5, collectionName, model, embeddingModel } = req.body;
    const normalizedPipelineId = typeof pipelineId === 'string' ? pipelineId.trim() : '';
    const normalizedEmbeddingModel =
      typeof embeddingModel === 'string' ? embeddingModel.trim() : undefined;

    if (!normalizedPipelineId || !question || !question.trim()) {
      return res.status(400).json({ error: 'pipelineId and question are required.' });
    }

    try {
      const startedAt = Date.now();
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
        collectionName
      );

      const matches = await qdrant.search(
        vectors[0],
        Math.max(1, Math.min(20, topK)),
        { pipelineId: normalizedPipelineId },
        targetCollection
      );

      const contextSnippets = matches
        .map((match) => String(match.payload?.text ?? '').trim())
        .filter(Boolean)
        .slice(0, topK);

      const messages = buildAnswerPrompt(question, contextSnippets);
      const completion = await openai.chatCompletion(messages, {
        model: model?.trim() || undefined,
      });
      const latencyMs = Date.now() - startedAt;

      res.json({
        answer: completion.content,
        matches,
        usage: completion.usage,
        latencyMs,
        collection: targetCollection,
        vectorSize,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error';
      res.status(500).json({ error: message });
    }
  };
