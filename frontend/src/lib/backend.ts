import type { JudgingSummary } from '../types/experiment';

interface ChunkPayload {
  documentId?: string;
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

interface UpsertChunksRequest {
  pipelineId: string;
  documentId?: string;
  embeddingModel?: string;
  chunks: ChunkPayload[];
}

interface UpsertChunksResponse {
  upserted: number;
  collection?: string;
  vectorSize?: number;
  embeddingModel?: string;
}

interface SearchMatchesResponse {
  matches: Array<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
  }>;
  collection?: string;
  vectorSize?: number;
}

interface SearchRequest {
  pipelineId: string;
  question: string;
  topK?: number;
  embeddingModel?: string;
}

interface AnswerRequestPayload {
  temperature?: number;
  maxTokens?: number;
  pipelineId: string;
  question: string;
  topK?: number;
  model?: string;
  embeddingModel?: string;
}

interface AnswerResponse {
  answer: string;
  matches: Array<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs?: number;
  collection?: string;
  vectorSize?: number;
}

interface JudgeEvaluationInput {
  taskId: string;
  question: string;
  answer: string;
  expectedAnswer?: string;
  acceptanceRule?: string;
  context?: string[];
}

type JudgeResponse = Omit<JudgingSummary, 'costUsd'> & { pipelineId: string };

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(
      typeof detail?.error?.message === 'string'
        ? detail.error.message
        : typeof detail?.error === 'string'
          ? detail.error
          : `Request to /api/${path} failed (${response.status})`,
    );
  }
  return response.json();
}

export const upsertChunks = (payload: UpsertChunksRequest) =>
  postJson<UpsertChunksResponse>('chunks', payload);

export const searchMatches = (payload: SearchRequest) =>
  postJson<SearchMatchesResponse>('search', payload);

export const answerQuestion = (payload: AnswerRequestPayload) =>
  postJson<AnswerResponse>('answer', payload);

export const judgeAnswers = (payload: {
  pipelineId: string;
  model?: string;
  evaluations: JudgeEvaluationInput[];
}) => postJson<JudgeResponse>('judge', payload);

export type {
  SearchMatchesResponse,
  AnswerResponse,
  JudgeResponse,
  JudgeEvaluationInput,
};
