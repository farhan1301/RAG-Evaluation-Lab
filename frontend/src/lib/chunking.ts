import * as c from '@rag-eval/contracts';
import { request } from '../data/workspace';
import type { DatasetDocument } from '../types/dataset';
import type {
  PipelineChunkingConfig,
  ChunkingStrategy,
} from '../types/pipeline';

export interface DocumentChunk {
  id: string;
  documentId: string;
  documentName?: string;
  documentSource?: string;
  strategy: ChunkingStrategy;
  index: number;
  content: string;
  charCount: number;
  tokenEstimate: number;
}

export interface DocumentChunkGroup {
  documentId: string;
  documentName?: string;
  documentSource?: string;
  strategy: ChunkingStrategy;
  chunks: DocumentChunk[];
}

// Transitional reader for the browser runner. The worker owns chunk generation.
export async function chunkDocumentsWithConfig(
  documents: DatasetDocument[],
  config: PipelineChunkingConfig,
) {
  const groups: DocumentChunkGroup[] = [];
  for (const doc of documents) {
    let job = await request(
      c.job,
      `document-versions/${doc.versionId}/chunks`,
      'POST',
      config,
      undefined,
      crypto.randomUUID(),
    );
    const deadline = Date.now() + 11 * 60 * 1000;
    while (
      ['queued', 'running', 'cancellation_requested'].includes(job.state)
    ) {
      if (Date.now() > deadline)
        throw new Error(
          'Chunking timed out. Check that the worker is running.',
        );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      job = await request(c.job, `jobs/${job.id}`);
    }
    if (job.state !== 'succeeded')
      throw new Error(job.message ?? 'Chunking was cancelled.');
    const chunks: DocumentChunk[] = [];
    let cursor: string | null = null;
    do {
      const batch: {
        items: c.z.infer<typeof c.chunkRow>[];
        nextCursor: string | null;
      } = await request(
        c.page(c.chunkRow),
        `jobs/${job.id}/chunks?after=${cursor ?? -1}`,
      );
      for (const row of batch.items)
        chunks.push({
          ...row,
          documentId: doc.id,
          documentName: doc.name,
          strategy: config.strategy,
          index: row.ordinal,
          charCount: row.content.length,
          tokenEstimate: Math.max(1, Math.round(row.content.length / 4)),
        });
      cursor = batch.nextCursor;
    } while (cursor !== null);
    groups.push({
      documentId: doc.id,
      documentName: doc.name,
      strategy: config.strategy,
      chunks,
    });
  }
  return groups;
}

export interface ChunkingStatistics {
  totalChunks: number;
  averageChars: number;
  averageTokens: number;
  maxChunkSize: number;
  minChunkSize: number;
}

export const summarizeChunkGroups = (
  groups: DocumentChunkGroup[],
): ChunkingStatistics => {
  const allChunks = groups.flatMap((group) => group.chunks);

  if (allChunks.length === 0) {
    return {
      totalChunks: 0,
      averageChars: 0,
      averageTokens: 0,
      maxChunkSize: 0,
      minChunkSize: 0,
    };
  }

  const totalChars = allChunks.reduce((acc, chunk) => acc + chunk.charCount, 0);
  const totalTokens = allChunks.reduce(
    (acc, chunk) => acc + chunk.tokenEstimate,
    0,
  );
  const maxChunk = Math.max(...allChunks.map((chunk) => chunk.charCount));
  const minChunk = Math.min(...allChunks.map((chunk) => chunk.charCount));

  return {
    totalChunks: allChunks.length,
    averageChars: Math.round(totalChars / allChunks.length),
    averageTokens: Math.round(totalTokens / allChunks.length),
    maxChunkSize: maxChunk,
    minChunkSize: minChunk,
  };
};
