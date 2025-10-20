export type ChunkingStrategy = 'recursive' | 'semantic' | 'layout' | 'table';

export interface PipelineChunkingConfig {
  strategy: ChunkingStrategy;
  chunkSize: number;
  overlap: number;
}

export interface PipelineEmbeddingConfig {
  model: string;
}

export interface PipelineRetrieverConfig {
  topK: number;
  deduplicate: boolean;
}

export interface PipelineRerankerConfig {
  enabled: boolean;
  model: string;
}

export interface PipelineLlmConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface PipelineJudgeConfig {
  model: string;
}

export type PipelineStageKey =
  | 'chunking'
  | 'embedding'
  | 'vectordb'
  | 'retriever'
  | 'reranker'
  | 'llm'
  | 'judge';

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  chunking: PipelineChunkingConfig;
  embedding: PipelineEmbeddingConfig;
  retriever: PipelineRetrieverConfig;
  reranker: PipelineRerankerConfig;
  llm: PipelineLlmConfig;
  judge: PipelineJudgeConfig;
  createdAt?: string;
  updatedAt?: string;
  isBaseline?: boolean;
}
