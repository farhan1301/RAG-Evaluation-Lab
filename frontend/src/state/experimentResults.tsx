import { createContext, type ReactNode, useContext, useState } from 'react';
import type { ExperimentRun } from '../types/experiment';

type Stage =
  | 'idle'
  | 'parsing'
  | 'chunking'
  | 'answering'
  | 'judging'
  | 'complete';

export interface TaskResult {
  taskId: string;
  question: string;
  expectedAnswer: string;
  answer: string;
  matches: Array<{
    id: string;
    score: number;
    text: string;
    documentName?: string;
  }>;
  latencyMs?: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

function useRunState() {
  const [latestRun, setLatestRun] = useState<ExperimentRun | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [statusLog, setStatusLog] = useState<
    Array<{ id: number; message: string }>
  >([]);
  const [taskResultsByPipeline, setTaskResultsByPipeline] = useState<
    Record<string, TaskResult[]>
  >({});
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  return {
    latestRun,
    setLatestRun,
    stage,
    setStage,
    statusLog,
    setStatusLog,
    taskResultsByPipeline,
    setTaskResultsByPipeline,
    progress,
    setProgress,
    error,
    setError,
    isRunning,
    setIsRunning,
  };
}

const ExperimentResultsContext = createContext<ReturnType<
  typeof useRunState
> | null>(null);

export function ExperimentResultsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const state = useRunState();
  return (
    <ExperimentResultsContext.Provider value={state}>
      {children}
    </ExperimentResultsContext.Provider>
  );
}

export function useExperimentResults() {
  const context = useContext(ExperimentResultsContext);
  if (!context) throw new Error('ExperimentResultsProvider is required');
  return context;
}
