import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import type { Pipeline } from '../types/pipeline';

interface PipelineContextValue {
  pipelines: Pipeline[];
  addPipeline: (overrides?: Partial<Pipeline>) => void;
  updatePipeline: (id: string, updates: Partial<Pipeline>) => void;
  removePipeline: (id: string) => void;
  duplicatePipeline: (id: string) => void;
  setBaseline: (id: string) => void;
}

const PipelineContext = createContext<PipelineContextValue | undefined>(undefined);

const generatePipelineId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pipeline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const createPipelineTemplate = (index: number, overrides: Partial<Pipeline> = {}): Pipeline => {
  const now = new Date().toISOString();

  return {
    id: overrides.id ?? generatePipelineId(),
    name:
      overrides.name ??
      (index === 0 ? 'Baseline Config' : `Configuration ${index + 1}`),
    description: overrides.description ?? '',
    parsing: {
      strategy: overrides.parsing?.strategy ?? 'llama-parse',
    },
    chunking: {
      strategy: overrides.chunking?.strategy ?? 'recursive',
      chunkSize: overrides.chunking?.chunkSize ?? 300,
      overlap: overrides.chunking?.overlap ?? 20,
    },
    embedding: {
      model: overrides.embedding?.model ?? 'text-embedding-3-small',
    },
    retriever: {
      topK: overrides.retriever?.topK ?? 5,
      deduplicate: overrides.retriever?.deduplicate ?? false,
    },
    reranker: {
      enabled: overrides.reranker?.enabled ?? false,
      model: overrides.reranker?.model ?? 'cohere-rerank',
    },
    llm: {
      model: overrides.llm?.model ?? 'gpt-4o-mini',
      temperature: overrides.llm?.temperature ?? 0.7,
      maxTokens: overrides.llm?.maxTokens ?? 500,
    },
    judge: {
      model: overrides.judge?.model ?? 'gpt-4o',
    },
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    isBaseline: overrides.isBaseline ?? index === 0,
  };
};

const mergePipeline = (pipeline: Pipeline, updates: Partial<Pipeline>): Pipeline => {
  const timestamp = new Date().toISOString();
  return {
    ...pipeline,
    ...updates,
    parsing: updates.parsing ? { ...pipeline.parsing, ...updates.parsing } : pipeline.parsing,
    chunking: updates.chunking
      ? { ...pipeline.chunking, ...updates.chunking }
      : pipeline.chunking,
    embedding: updates.embedding
      ? { ...pipeline.embedding, ...updates.embedding }
      : pipeline.embedding,
    retriever: updates.retriever
      ? { ...pipeline.retriever, ...updates.retriever }
      : pipeline.retriever,
    reranker: updates.reranker
      ? { ...pipeline.reranker, ...updates.reranker }
      : pipeline.reranker,
    llm: updates.llm ? { ...pipeline.llm, ...updates.llm } : pipeline.llm,
    judge: updates.judge ? { ...pipeline.judge, ...updates.judge } : pipeline.judge,
    updatedAt: timestamp,
  };
};

export function PipelineProvider({ children }: { children: ReactNode }) {
  const [pipelines, setPipelines] = useState<Pipeline[]>(() => [
    createPipelineTemplate(0),
  ]);

  const addPipeline = useCallback((overrides?: Partial<Pipeline>) => {
    setPipelines((prev) => [...prev, createPipelineTemplate(prev.length, overrides)]);
  }, []);

  const updatePipeline = useCallback((id: string, updates: Partial<Pipeline>) => {
    setPipelines((prev) => prev.map((pipeline) => (pipeline.id === id ? mergePipeline(pipeline, updates) : pipeline)));
  }, []);

  const removePipeline = useCallback((id: string) => {
    setPipelines((prev) => {
      const remaining = prev.filter((pipeline) => pipeline.id !== id);
      if (remaining.length && !remaining.some((pipeline) => pipeline.isBaseline)) {
        return remaining.map((pipeline, index) => ({ ...pipeline, isBaseline: index === 0 }));
      }
      return remaining;
    });
  }, []);

  const duplicatePipeline = useCallback((id: string) => {
    setPipelines((prev) => {
      const source = prev.find((pipeline) => pipeline.id === id);
      if (!source) {
        return prev;
      }

      const duplicate = createPipelineTemplate(prev.length, {
        name: `${source.name} Copy`,
        description: source.description,
        parsing: { ...source.parsing },
        chunking: { ...source.chunking },
        embedding: { ...source.embedding },
        retriever: { ...source.retriever },
        reranker: { ...source.reranker },
        llm: { ...source.llm },
        judge: { ...source.judge },
        isBaseline: false,
      });

      return [...prev, duplicate];
    });
  }, []);

  const setBaseline = useCallback((id: string) => {
    setPipelines((prev) =>
      prev.map((pipeline) => ({
        ...pipeline,
        isBaseline: pipeline.id === id,
      }))
    );
  }, []);

  const value = useMemo(
    () => ({
      pipelines,
      addPipeline,
      updatePipeline,
      removePipeline,
      duplicatePipeline,
      setBaseline,
    }),
    [pipelines, addPipeline, updatePipeline, removePipeline, duplicatePipeline, setBaseline]
  );

  return <PipelineContext.Provider value={value}>{children}</PipelineContext.Provider>;
}

export const usePipelines = () => {
  const context = useContext(PipelineContext);
  if (!context) {
    throw new Error('usePipelines must be used within a PipelineProvider');
  }
  return context;
};
