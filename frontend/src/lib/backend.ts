interface ChunkPayload {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

interface UpsertChunksRequest {
  pipelineId: string;
  documentId?: string;
  collectionName?: string;
  chunks: ChunkPayload[];
}

interface UpsertChunksResponse {
  upserted: number;
}

interface SearchMatchesResponse {
  matches: Array<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
  }>;
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
}

interface JudgeEvaluationInput {
  taskId: string;
  question: string;
  answer: string;
  expectedAnswer?: string;
  acceptanceRule?: string;
  context?: string[];
}

interface JudgeResponse {
  pipelineId: string;
  verdict: 'pass' | 'review';
  passRate: number;
  averageScores: {
    relevance: number;
    contextPrecision: number;
    groundedness: number;
  };
  tokensUsed: number;
  latencyMs: number;
  details: Array<{
    taskId: string;
    verdict: 'pass' | 'review';
    scores: {
      relevance: number;
      contextPrecision: number;
      groundedness: number;
    };
    rationale: string;
    missingCriteria: string[];
    latencyMs: number;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }>;
}

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
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_BACKEND_URL) ||
  'http://localhost:7070';

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

export const answerQuestion = async (
  payload: {
    pipelineId: string;
    question: string;
    topK?: number;
    collectionName?: string;
    model?: string;
  }
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
