import { useState } from 'react';
import { Upload, FileText, Plus, Trash2, Sparkles, AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Progress } from './ui/progress';
import { useDataset } from '../state/dataset';
import type { DatasetDocument, DatasetTask } from '../types/dataset';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { parseTaskCsv } from '../lib/taskCsv';

interface DatasetsPageProps {
  onNext: () => void;
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const UPLOAD_SNIPPET =
  'Ready for parsing. Configure parsing strategy in the Pipelines step.';

type CsvFeedback = {
  type: 'success' | 'warning' | 'error';
  message: string;
  details?: string[];
};

export function DatasetsPage({ onNext }: DatasetsPageProps) {
  const { documents, setDocuments, tasks, setTasks } = useDataset();
  const [uploading, setUploading] = useState(false);
  const [csvImporting, setCsvImporting] = useState(false);
  const [taskCsvFeedback, setTaskCsvFeedback] = useState<CsvFeedback | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = Array.from(e.target.files || []);
    if (!uploadedFiles.length) {
      return;
    }

    setUploading(true);

    for (const file of uploadedFiles) {
      const id = `${Date.now()}-${file.name}`;

      setDocuments((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          size: file.size,
          status: 'uploading',
          progress: 0,
          snippet: 'Preparing preview…',
        },
      ]);

      try {
        const updateDocument = (updates: Partial<DatasetDocument>) => {
          setDocuments((prev) =>
            prev.map((doc) => (doc.id === id ? { ...doc, ...updates } : doc))
          );
        };

        updateDocument({
          status: 'processing',
          progress: 10,
          statusMessage: 'Preparing file for parsing…',
        });

        const arrayBuffer = await file.arrayBuffer();
        const contentBase64 = arrayBufferToBase64(arrayBuffer);
        updateDocument({
          status: 'complete',
          progress: 100,
          snippet: UPLOAD_SNIPPET,
          statusMessage: 'Uploaded successfully. Parsing will run per pipeline configuration.',
          fileBase64: contentBase64,
          mimeType: file.type || 'application/octet-stream',
          uploadedAt: new Date().toISOString(),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error while processing document.';

        setDocuments((prev) =>
          prev.map((doc) =>
            doc.id === id
              ? {
                  ...doc,
                  status: 'error',
                  progress: 100,
                  snippet: 'Failed to process this file.',
                  statusMessage: message,
                  error: message,
                }
              : doc
          )
        );
      }
    }

    setUploading(false);
    if (e.target) {
      e.target.value = '';
    }
  };

  const handleTaskCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.target.files ?? []);
    if (!file) {
      return;
    }

    setTaskCsvFeedback(null);
    setCsvImporting(true);

    try {
      const text = await file.text();
      const { tasks: parsedTasks, warnings } = parseTaskCsv(text);
      const timestamp = Date.now();

      setTasks(
        parsedTasks.map((task, index) => ({
          id: `${timestamp}-${index}`,
          ...task,
        }))
      );

      setTaskCsvFeedback({
        type: warnings.length > 0 ? 'warning' : 'success',
        message:
          warnings.length > 0
            ? `Imported ${parsedTasks.length} tasks from "${file.name}" with ${warnings.length} skipped row${warnings.length === 1 ? '' : 's'}.`
            : `Imported ${parsedTasks.length} tasks from "${file.name}".`,
        details: warnings.length > 0 ? warnings : undefined,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to parse CSV file.';
      setTaskCsvFeedback({
        type: 'error',
        message,
      });
    } finally {
      setCsvImporting(false);
      if (event.target) {
        event.target.value = '';
      }
    }
  };

  const removeDocument = (id: string) => {
    setDocuments((prev) => prev.filter((doc) => doc.id !== id));
  };

  const loadSampleDataset = () => {
    const sampleDocs: DatasetDocument[] = [
      {
        id: 'sample-1',
        name: 'RAG_Best_Practices.txt',
        size: 0,
        status: 'complete',
        progress: 100,
        snippet: 'Best practices for implementing RAG systems include proper chunking...',
        content:
          'Best practices for implementing RAG systems include proper chunking thresholds, overlap configuration, and maintaining up-to-date embeddings.',
      },
      {
        id: 'sample-2',
        name: 'Embedding_Models_Comparison.txt',
        size: 0,
        status: 'complete',
        progress: 100,
        snippet: 'A comprehensive comparison of embedding models across different dimensions...',
        content:
          'A comprehensive comparison of embedding models across different dimensions demonstrates that text-embedding-3-small balances cost and performance for many workloads.',
      },
      {
        id: 'sample-3',
        name: 'Vector_Database_Guide.txt',
        size: 0,
        status: 'complete',
        progress: 100,
        snippet: 'Vector databases are specialized systems designed for similarity search...',
        content:
          'Vector databases are specialized systems designed for similarity search. Selection factors include latency, scalability, filtering, and ecosystem tooling.',
      },
    ];

    setDocuments(
      sampleDocs.map((doc) => ({
        ...doc,
        statusMessage: 'Sample content provided for quick experimentation.',
        uploadedAt: new Date().toISOString(),
      }))
    );

    setTasks([
      {
        id: '1',
        question: 'What is the optimal chunk size for dense documents?',
        expectedAnswer: 'Between 256-512 tokens with 20% overlap',
        acceptanceRule: 'Must include a number between 200-600',
      },
      {
        id: '2',
        question: 'Which embedding model provides the best cost-performance ratio?',
        expectedAnswer: 'text-embedding-3-small for most use cases',
        acceptanceRule: 'Must mention a specific model name',
      },
      {
        id: '3',
        question: 'What are the key factors in vector database selection?',
        expectedAnswer: 'Latency, scalability, and filtering capabilities',
        acceptanceRule: 'Must mention at least 2 factors',
      },
      {
        id: '4',
        question: 'Why is it important to keep embeddings up to date?',
        expectedAnswer: 'It ensures retrieval reflects the latest source information and avoids drift.',
        acceptanceRule: 'Must mention refreshing or updating embeddings',
      },
      {
        id: '5',
        question: 'What chunk overlap pairs well with 256-512 token chunks to preserve context?',
        expectedAnswer: 'Around 20% overlap keeps neighboring chunks connected',
        acceptanceRule: 'Must mention 20% overlap',
      },
      {
        id: '6',
        question: 'Which evaluation dimensions should you compare when selecting an embedding model?',
        expectedAnswer: 'Latency, accuracy, and cost should all be weighed',
        acceptanceRule: 'Must mention at least two of latency, accuracy, or cost',
      },
      {
        id: '7',
        question: 'When would a larger embedding model be worth the extra cost?',
        expectedAnswer: 'When the domain needs more semantic nuance or multilingual coverage',
        acceptanceRule: 'Must reference nuance, multilingual, or higher accuracy requirements',
      },
      {
        id: '8',
        question: 'Besides similarity search, what capability should a vector database offer?',
        expectedAnswer: 'Robust filtering or metadata-based queries to refine results',
        acceptanceRule: 'Must mention filtering or metadata queries',
      },
      {
        id: '9',
        question: 'How do chunk size and overlap work together in retrieval pipelines?',
        expectedAnswer: 'Larger chunks capture context while overlap prevents dropping linking details',
        acceptanceRule: 'Must mention both chunk size and overlap',
      },
      {
        id: '10',
        question: 'What ecosystem consideration matters when choosing a vector database?',
        expectedAnswer: 'Available tooling and integrations to streamline operations',
        acceptanceRule: 'Must mention tooling, integrations, or ecosystem',
      },
    ]);
    setTaskCsvFeedback(null);
  };

  const addTask = () => {
    setTasks([
      ...tasks,
      {
        id: Date.now().toString(),
        question: '',
        expectedAnswer: '',
        acceptanceRule: '',
      },
    ]);
  };

  const removeTask = (id: string) => {
    setTasks(tasks.filter((t) => t.id !== id));
  };

  const updateTask = (id: string, field: keyof DatasetTask, value: string) => {
    setTasks(tasks.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  };

  return (
    <div className="p-8 bg-zinc-50">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2>Datasets & Tasks</h2>
          <p className="text-zinc-600">
            Upload documents and define evaluation questions
          </p>
        </div>

        {/* Upload Section */}
        <Card>
          <CardHeader>
            <CardTitle>Document Upload</CardTitle>
            <CardDescription>
              Upload PDFs, TXT, or DOCX files for indexing and retrieval
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border-2 border-dashed rounded-lg p-8 text-center border-zinc-300 bg-zinc-50">
              <Upload className="mx-auto mb-4 opacity-40" size={48} />
              <p className="mb-4">Drag and drop files here, or click to browse</p>
              <Input
                type="file"
                multiple
                accept=".pdf,.txt,.docx"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
              />
              <Button asChild>
                <label htmlFor="file-upload" className="cursor-pointer">
                  Choose Files
                </label>
              </Button>
            </div>

            {documents.length > 0 && (
              <div className="space-y-3">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="p-4 rounded-lg border border-zinc-200 bg-white"
                  >
                    <div className="flex items-start gap-3">
                      <FileText size={20} className="mt-1 opacity-60" />
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-2">
                          <span>{doc.name}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-sm opacity-60">{doc.progress}%</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => removeDocument(doc.id)}
                              aria-label="Remove document"
                            >
                              <Trash2 size={16} />
                            </Button>
                          </div>
                        </div>
                        <Progress value={doc.progress} className="mb-2" />
                        {doc.statusMessage && (
                          <p
                            className={`text-xs mb-2 ${
                              doc.status === 'error' ? 'text-red-600' : 'text-zinc-600'
                            }`}
                          >
                            {doc.statusMessage}
                          </p>
                        )}
                        {doc.progress === 100 && doc.snippet && (
                          <p className="text-sm text-zinc-600">
                            {doc.snippet}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" onClick={loadSampleDataset} className="gap-2">
                  <Sparkles size={16} />
                  Load Sample Dataset
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Replace the current documents and tasks with a curated demo set for quick exploration.
              </TooltipContent>
            </Tooltip>
          </CardContent>
        </Card>

        {/* Task Builder Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Evaluation Tasks</CardTitle>
                <CardDescription>
                  Define questions and acceptance criteria for pipeline evaluation
                </CardDescription>
              </div>
              <Button onClick={addTask} size="sm" className="gap-2">
                <Plus size={16} />
                Add Question
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-4 md:flex md:items-center md:justify-between">
              <div className="mb-3 md:mb-0 md:max-w-xl">
                <p className="font-medium">Import from CSV</p>
                <p className="text-sm text-zinc-600">
                  Upload a CSV with the headers <code>question</code>, <code>expected_answer</code>, and{' '}
                  <code>acceptance_rule</code>. Importing replaces the current task list.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="file"
                  accept=".csv"
                  onChange={handleTaskCsvUpload}
                  className="hidden"
                  id="task-csv-upload"
                />
                <Button asChild variant="outline" disabled={csvImporting}>
                  <label htmlFor="task-csv-upload" className="cursor-pointer">
                    {csvImporting ? 'Importing…' : 'Upload CSV'}
                  </label>
                </Button>
              </div>
            </div>

            {taskCsvFeedback && (
              <Alert variant={taskCsvFeedback.type === 'error' ? 'destructive' : 'default'}>
                {taskCsvFeedback.type === 'error' ? (
                  <AlertCircle size={16} className="mt-0.5" />
                ) : taskCsvFeedback.type === 'warning' ? (
                  <Info size={16} className="mt-0.5" />
                ) : (
                  <CheckCircle2 size={16} className="mt-0.5" />
                )}
                <AlertTitle>{taskCsvFeedback.message}</AlertTitle>
                {taskCsvFeedback.details && (
                  <AlertDescription>
                    {taskCsvFeedback.details.map((detail) => (
                      <p key={detail}>{detail}</p>
                    ))}
                  </AlertDescription>
                )}
              </Alert>
            )}

            {tasks.length === 0 ? (
              <div className="text-center py-8 text-zinc-400">
                No tasks yet. Add a question or load the sample dataset.
              </div>
            ) : (
              <div className="space-y-4">
                {tasks.map((task, index) => (
                  <div
                    key={task.id}
                    className="p-4 rounded-lg border border-zinc-200 bg-white"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 space-y-3">
                        <div>
                          <label className="text-sm opacity-60 block mb-1">
                            Question {index + 1}
                          </label>
                          <Textarea
                            value={task.question}
                            onChange={(e) => updateTask(task.id, 'question', e.target.value)}
                            placeholder="What question should the RAG system answer?"
                            rows={2}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-sm opacity-60 block mb-1">Expected Answer</label>
                            <Input
                              value={task.expectedAnswer}
                              onChange={(e) => updateTask(task.id, 'expectedAnswer', e.target.value)}
                              placeholder="Ground truth answer"
                            />
                          </div>
                          <div>
                            <label className="text-sm opacity-60 block mb-1">Acceptance Rule</label>
                            <Input
                              value={task.acceptanceRule}
                              onChange={(e) => updateTask(task.id, 'acceptanceRule', e.target.value)}
                              placeholder="Must include..."
                            />
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeTask(task.id)}
                        className="mt-1"
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Bottom CTA */}
        <div className="flex justify-end">
          <Button
            onClick={onNext}
            size="lg"
            disabled={documents.length === 0 || tasks.length === 0}
            className="gap-2"
          >
            Proceed to Pipeline Setup →
          </Button>
        </div>
      </div>
    </div>
  );
}
