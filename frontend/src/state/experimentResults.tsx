import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { DocumentChunk } from '../lib/chunking';
import type { ExperimentRun, JudgeDetail } from '../types/experiment';

export type ExperimentStage =
  | 'idle'
  | 'parsing'
  | 'chunking'
  | 'searching'
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

interface ExperimentResultsContextValue {
  latestRun: ExperimentRun | null;
  setLatestRun: (run: ExperimentRun | null) => void;
  stage: ExperimentStage;
  setStage: React.Dispatch<React.SetStateAction<ExperimentStage>>;
  statusLog: string[];
  setStatusLog: React.Dispatch<React.SetStateAction<string[]>>;
  taskResults: TaskResult[];
  setTaskResults: React.Dispatch<React.SetStateAction<TaskResult[]>>;
  progress: number;
  setProgress: React.Dispatch<React.SetStateAction<number>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  isRunning: boolean;
  setIsRunning: React.Dispatch<React.SetStateAction<boolean>>;
  chunkPreview: DocumentChunk[];
  setChunkPreview: React.Dispatch<React.SetStateAction<DocumentChunk[]>>;
  judgeDetails: JudgeDetail[];
  setJudgeDetails: React.Dispatch<React.SetStateAction<JudgeDetail[]>>;
  resetExperimentState: () => void;
}

const ExperimentResultsContext = createContext<ExperimentResultsContextValue | undefined>(
  undefined
);

export function ExperimentResultsProvider({ children }: { children: ReactNode }) {
  const [latestRun, setLatestRunState] = useState<ExperimentRun | null>(null);
  const [stage, setStage] = useState<ExperimentStage>('idle');
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [taskResults, setTaskResults] = useState<TaskResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [chunkPreview, setChunkPreview] = useState<DocumentChunk[]>([]);
  const [judgeDetails, setJudgeDetails] = useState<JudgeDetail[]>([]);

  const setLatestRun = useCallback((run: ExperimentRun | null) => {
    setLatestRunState(run);
  }, []);

  const resetExperimentState = useCallback(() => {
    setStage('idle');
    setStatusLog([]);
    setTaskResults([]);
    setProgress(0);
    setError(null);
    setChunkPreview([]);
    setJudgeDetails([]);
  }, []);

  const value = useMemo(
    () => ({
      latestRun,
      setLatestRun,
      stage,
      setStage,
      statusLog,
      setStatusLog,
      taskResults,
      setTaskResults,
      progress,
      setProgress,
      error,
      setError,
      isRunning,
      setIsRunning,
      chunkPreview,
      setChunkPreview,
      judgeDetails,
      setJudgeDetails,
      resetExperimentState,
    }),
    [
      latestRun,
      setLatestRun,
      stage,
      setStage,
      statusLog,
      setStatusLog,
      taskResults,
      setTaskResults,
      progress,
      setProgress,
      error,
      setError,
      isRunning,
      setIsRunning,
      chunkPreview,
      setChunkPreview,
      judgeDetails,
      setJudgeDetails,
      resetExperimentState,
    ]
  );

  return (
    <ExperimentResultsContext.Provider value={value}>
      {children}
    </ExperimentResultsContext.Provider>
  );
}

export const useExperimentResults = () => {
  const context = useContext(ExperimentResultsContext);
  if (!context) {
    throw new Error('useExperimentResults must be used within an ExperimentResultsProvider');
  }
  return context;
};
