const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_CONTEXT_CHARS = 6000;
const TASKS_PER_DOCUMENT = 10;
const EMBEDDING_BATCH_SIZE = 16;

const resolveOpenAIApiKey = () => {
  let envKey: string | undefined;

  try {
    envKey =
      typeof import.meta !== 'undefined'
        ? (import.meta as any).env?.VITE_OPENAI_API_KEY
        : undefined;
  } catch {
    envKey = undefined;
  }

  if (typeof envKey === 'string' && envKey.trim()) {
    return envKey.trim();
  }

  if (typeof window !== 'undefined') {
    const globalKey = (window as any).__OPENAI_API_KEY__;
    if (typeof globalKey === 'string' && globalKey.trim()) {
      return globalKey.trim();
    }
  }

  return '';
};

const resolveOpenAIModel = () => {
  let envModel: string | undefined;

  try {
    envModel =
      typeof import.meta !== 'undefined'
        ? (import.meta as any).env?.VITE_OPENAI_MODEL
        : undefined;
  } catch {
    envModel = undefined;
  }

  if (typeof envModel === 'string' && envModel.trim()) {
    return envModel.trim();
  }

  if (typeof window !== 'undefined') {
    const globalModel = (window as any).__OPENAI_MODEL__;
    if (typeof globalModel === 'string' && globalModel.trim()) {
      return globalModel.trim();
    }
  }

  return DEFAULT_MODEL;
};

const truncateContent = (content: string, limit = MAX_CONTEXT_CHARS) => {
  if (content.length <= limit) {
    return content;
  }
  return `${content.slice(0, limit)}\n… [truncated for prompt]`;
};

export interface GeneratedEvaluationTask {
  question: string;
  expectedAnswer: string;
  acceptanceRule: string;
}

interface GenerateEvaluationTasksOptions {
  count?: number;
  signal?: AbortSignal;
}

const normalizeTask = (raw: any): GeneratedEvaluationTask | null => {
  if (!raw) {
    return null;
  }

  const question = String(
    raw.question ?? raw.prompt ?? raw.query ?? ''
  ).trim();
  const expectedAnswer = String(
    raw.expectedAnswer ?? raw.expected_answer ?? raw.answer ?? ''
  ).trim();
  const acceptanceRule = String(
    raw.acceptanceRule ?? raw.acceptance_rule ?? raw.scoring ?? raw.criteria ?? ''
  ).trim();

  if (!question) {
    return null;
  }

  return {
    question,
    expectedAnswer,
    acceptanceRule,
  };
};

const coerceTasksArray = (payload: any): any[] => {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.tasks)) {
    return payload.tasks;
  }

  if (Array.isArray(payload.questions)) {
    return payload.questions;
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  return [];
};

export async function generateEvaluationTasksFromContent(
  documents: string[],
  options: GenerateEvaluationTasksOptions = {}
): Promise<GeneratedEvaluationTask[]> {
  const apiKey = resolveOpenAIApiKey();

  if (!apiKey) {
    throw new Error('Add your OpenAI API key in Settings to use question generation.');
  }

  if (!documents.length) {
    throw new Error('Upload and parse at least one document before generating questions.');
  }

  const documentsWithContent = documents
    .map((doc, index) => {
      const content = typeof doc === 'string' ? doc.trim() : '';
      if (!content) {
        return null;
      }
      return { index, content };
    })
    .filter((entry): entry is { index: number; content: string } => entry !== null);

  if (!documentsWithContent.length) {
    throw new Error('Parsed documents are empty. Try reprocessing your files.');
  }

  const model = resolveOpenAIModel();
  const aggregated: GeneratedEvaluationTask[] = [];

  for (const { index, content } of documentsWithContent) {
    const documentLabel = `Document ${index + 1}`;
    const truncatedDocument = `${documentLabel}:\n${truncateContent(content)}`;
    const requestPayload = {
      model,
      temperature: 0.3,
      response_format: { type: 'json_object' as const },
      messages: [
        {
          role: 'system',
          content:
            'You are an evaluation expert helping a team build RAG benchmarks. ' +
            'Draft concise question-answer tasks that can measure whether a retrieval-augmented generation pipeline ' +
            'returns factual, context-grounded answers.',
        },
        {
          role: 'user',
          content: [
            `Create ${TASKS_PER_DOCUMENT} evaluation tasks based strictly on the following document excerpt.`,
            'Each task must include:',
            '- question: a retrieval-focused question phrased in natural language.',
            '- expectedAnswer: the concise, factual answer that should be returned.',
            '- acceptanceRule: the criteria a grader should look for in the model answer.',
            '',
            'Return your answer as JSON with a top-level "tasks" array.',
            '',
            truncatedDocument,
          ].join('\n'),
        },
      ],
    };

    let response: Response;

    try {
      response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestPayload),
        signal: options.signal,
      });
    } catch (error) {
      throw new Error(
        `Document ${index + 1}: ${
          error instanceof Error ? error.message : 'Network error calling OpenAI.'
        }`
      );
    }

    if (!response.ok) {
      let detail = '';
      try {
        const data = await response.json();
        detail = data?.error?.message || JSON.stringify(data);
      } catch {
        detail = await response.text();
      }
      throw new Error(
        `Document ${index + 1}: OpenAI request failed (${response.status}). ${
          detail || 'Check your API key and model name.'
        }`
      );
    }

    const payload = await response.json();
    const messageContent = payload?.choices?.[0]?.message?.content;

    if (typeof messageContent !== 'string' || !messageContent.trim()) {
      throw new Error(`Document ${index + 1}: OpenAI returned an empty response.`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(messageContent);
    } catch (error) {
      throw new Error(
        `Document ${index + 1}: Failed to parse OpenAI response. Try again or adjust the prompt.`
      );
    }

    const tasks = coerceTasksArray(parsed);
    const normalized = tasks
      .map((task: any) => normalizeTask(task))
      .filter((task): task is GeneratedEvaluationTask => task !== null)
      .slice(0, TASKS_PER_DOCUMENT);

    if (!normalized.length) {
      throw new Error(`Document ${index + 1}: OpenAI response did not include any valid tasks.`);
    }

    aggregated.push(...normalized);
  }

  return aggregated;
}

export async function createEmbeddings(
  texts: string[],
  model: string,
  signal?: AbortSignal
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const apiKey = resolveOpenAIApiKey();
  if (!apiKey) {
    throw new Error('Missing OpenAI API key for embeddings. Set VITE_OPENAI_API_KEY.');
  }

  const normalizedTexts = texts.map((text) => {
    if (typeof text !== 'string') {
      return ' ';
    }
    const cleaned = text.trim();
    return cleaned || ' ';
  });

  const embeddings: number[][] = [];

  for (let index = 0; index < normalizedTexts.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = normalizedTexts.slice(index, index + EMBEDDING_BATCH_SIZE);

    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: batch,
      }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `OpenAI embeddings request failed (${response.status}). ${detail || 'Check your API key and embedding model name.'}`
      );
    }

    const payload = await response.json();
    const vectors = Array.isArray(payload?.data)
      ? payload.data.map((item: any) => item?.embedding).filter((vector: any) => Array.isArray(vector))
      : [];

    if (!vectors.length) {
      throw new Error('OpenAI embeddings response did not include any vectors.');
    }

    embeddings.push(...vectors);
  }

  return embeddings;
}
