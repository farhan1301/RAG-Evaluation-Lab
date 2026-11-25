export type DocumentStatus =
  | 'queued'
  | 'uploading'
  | 'processing'
  | 'complete'
  | 'error';

export interface DatasetDocument {
  id: string;
  name: string;
  size: number;
  status: DocumentStatus;
  progress: number;
  snippet: string;
  statusMessage?: string;
  content?: string;
  versionId:string;
  mimeType?: string;
  uploadedAt?: string;
  error?: string;
  source?: string;
  pageCount?: number;
  parserJobId?: string;
}

export interface DatasetTask {
  id: string;
  question: string;
  expectedAnswer: string;
  acceptanceRule: string;
}
