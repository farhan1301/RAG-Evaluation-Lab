import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ExperimentRun } from '../types/experiment';

interface ExperimentResultsContextValue {
  latestRun: ExperimentRun | null;
  setLatestRun: (run: ExperimentRun | null) => void;
}

const ExperimentResultsContext = createContext<ExperimentResultsContextValue | undefined>(
  undefined
);

export function ExperimentResultsProvider({ children }: { children: ReactNode }) {
  const [latestRun, setLatestRunState] = useState<ExperimentRun | null>(null);

  const setLatestRun = useCallback((run: ExperimentRun | null) => {
    setLatestRunState(run);
  }, []);

  const value = useMemo(
    () => ({
      latestRun,
      setLatestRun,
    }),
    [latestRun, setLatestRun]
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
