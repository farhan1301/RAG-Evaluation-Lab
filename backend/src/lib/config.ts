export interface AppConfig {
  openaiApiKey: string;
  openaiEmbeddingModel: string;
  openaiChatModel: string;
  localEmbedModel?: string;
  localEmbedBaseUrl?: string;
  qdrantUrl: string;
  qdrantApiKey?: string;
  qdrantCollection: string;
  qdrantCollections: Record<number, string>;
  llamaParseApiKey?: string;
  llamaParseBaseUrl: string;
}
