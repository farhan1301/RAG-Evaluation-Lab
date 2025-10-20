import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { DatasetDocument, DatasetTask } from '../types/dataset';

interface DatasetContextValue {
  documents: DatasetDocument[];
  setDocuments: Dispatch<SetStateAction<DatasetDocument[]>>;
  tasks: DatasetTask[];
  setTasks: Dispatch<SetStateAction<DatasetTask[]>>;
}

const DatasetContext = createContext<DatasetContextValue | undefined>(undefined);

export function DatasetProvider({ children }: { children: ReactNode }) {
  const [documents, setDocuments] = useState<DatasetDocument[]>([]);
  const [tasks, setTasks] = useState<DatasetTask[]>([]);

  const value = useMemo(
    () => ({
      documents,
      setDocuments,
      tasks,
      setTasks,
    }),
    [documents, tasks]
  );

  return <DatasetContext.Provider value={value}>{children}</DatasetContext.Provider>;
}

export const useDataset = () => {
  const context = useContext(DatasetContext);
  if (!context) {
    throw new Error('useDataset must be used within a DatasetProvider');
  }
  return context;
};
