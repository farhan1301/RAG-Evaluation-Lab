export interface AppConfig {
  openaiApiKey: string;
  openaiEmbeddingModel: string;
  openaiChatModel: string;
  qdrantUrl: string;
  qdrantApiKey?: string;
  qdrantCollection: string;
  qdrantCollections: Record<number, string>;
  llamaParseApiKey?: string;
  llamaParseBaseUrl: string;
}

const required = (value: string | undefined, name: string) => {
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
};

export const loadConfig = (): AppConfig => {
  const openaiApiKey = required(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY');
  const qdrantUrl = required(process.env.QDRANT_URL, 'QDRANT_URL');
  const defaultCollection = process.env.QDRANT_COLLECTION?.trim() || 'rag-eval-chunks';
  const qdrantCollections: Record<number, string> = {};
  for (const size of [1536, 3072]) {
    const collection = process.env[`QDRANT_COLLECTION_${size}`]?.trim();
    if (collection) qdrantCollections[size] = collection;
  }

  return {
    openaiApiKey,
    openaiEmbeddingModel: process.env.OPENAI_EMBED_MODEL?.trim() ?? 'text-embedding-3-small',
    openaiChatModel: process.env.OPENAI_CHAT_MODEL?.trim() ?? 'gpt-4o-mini',
    qdrantUrl: qdrantUrl.replace(/\/$/, ''),
    qdrantApiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
    qdrantCollection: defaultCollection,
    qdrantCollections,
    llamaParseApiKey:
      process.env.LLAMA_CLOUD_API_KEY?.trim() ??
      process.env.LLAMA_PARSE_API_KEY?.trim() ??
      undefined,
    llamaParseBaseUrl:
      process.env.LLAMA_CLOUD_BASE_URL?.trim() ?? 'https://api.cloud.llamaindex.ai/api',
  };
};
