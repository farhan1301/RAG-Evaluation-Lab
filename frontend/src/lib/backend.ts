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

interface ParseDocumentRequest {
  filename: string;
  mimeType?: string;
  contentBase64: string;
}

interface ParseDocumentResponse {
  text: string;
  pageCount?: number;
  jobId?: string;
}

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  'http://127.0.0.1:7070';

const withBase = (path: string) => {
  const trimmed = path.startsWith('/') ? path : `/${path}`;
  return `${BACKEND_URL.replace(/\/$/, '')}${trimmed}`;
};

const parseJson = async (response: Response) => {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text);
  }
};

export const upsertChunks = async (
  payload: UpsertChunksRequest
): Promise<UpsertChunksResponse> => {
  const response = await fetch(withBase('/api/chunks'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await parseJson(response);
    throw new Error(detail?.error || `Failed to upsert chunks (${response.status})`);
  }

  return parseJson(response) as Promise<UpsertChunksResponse>;
};

export const searchMatches = async (
  payload: SearchRequest
): Promise<SearchMatchesResponse> => {
  const response = await fetch(withBase('/api/search'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await parseJson(response);
    throw new Error(detail?.error || `Failed to search chunks (${response.status})`);
  }

  return parseJson(response) as Promise<SearchMatchesResponse>;
};

export const answerQuestion = async (
  payload: AnswerRequestPayload
): Promise<AnswerResponse> => {
  const response = await fetch(withBase('/api/answer'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await parseJson(response);
    throw new Error(detail?.error || `Failed to answer question (${response.status})`);
  }

  return parseJson(response) as Promise<AnswerResponse>;
};

export const judgeAnswers = async (
  payload: {
    pipelineId: string;
    model?: string;
    evaluations: JudgeEvaluationInput[];
  }
): Promise<JudgeResponse> => {
  const response = await fetch(withBase('/api/judge'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await parseJson(response);
    throw new Error(detail?.error || `Failed to judge answers (${response.status})`);
  }

  return parseJson(response) as Promise<JudgeResponse>;
};

export const parseDocument = async (
  payload: ParseDocumentRequest
): Promise<ParseDocumentResponse> => {
  const response = await fetch(withBase('/api/parse'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await parseJson(response);
    throw new Error(detail?.error || `Failed to parse document (${response.status})`);
  }

  return parseJson(response) as Promise<ParseDocumentResponse>;
};

export type {
  SearchMatchesResponse,
  AnswerResponse,
  JudgeResponse,
  JudgeEvaluationInput,
  ParseDocumentResponse,
};
