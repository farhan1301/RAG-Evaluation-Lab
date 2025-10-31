import { useState } from 'react';
import { Upload, FileText, Plus, Trash2, Sparkles } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Progress } from './ui/progress';

interface Task {
  id: string;
  question: string;
  expectedAnswer: string;
  acceptanceRule: string;
}

interface DatasetsPageProps {
  darkMode: boolean;
  onNext: () => void;
}

export function DatasetsPage({ darkMode, onNext }: DatasetsPageProps) {
  const [files, setFiles] = useState<Array<{ name: string; progress: number; snippet: string }>>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [uploading, setUploading] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = Array.from(e.target.files || []);
    setUploading(true);

    uploadedFiles.forEach((file, index) => {
      setTimeout(() => {
        setFiles((prev) => [
          ...prev,
          {
            name: file.name,
            progress: 0,
            snippet: 'Loading document preview...',
          },
        ]);

        // Simulate upload progress
        let progress = 0;
        const interval = setInterval(() => {
          progress += 10;
          setFiles((prev) =>
            prev.map((f, i) =>
              i === prev.length - 1 ? { ...f, progress } : f
            )
          );

          if (progress >= 100) {
            clearInterval(interval);
            setFiles((prev) =>
              prev.map((f, i) =>
                i === prev.length - 1
                  ? { ...f, snippet: 'This document contains information about retrieval systems and their evaluation...' }
                  : f
              )
            );
            if (index === uploadedFiles.length - 1) {
              setUploading(false);
            }
          }
        }, 100);
      }, index * 200);
    });
  };

  const loadSampleDataset = () => {
    setFiles([
      { name: 'RAG_Best_Practices.pdf', progress: 100, snippet: 'Best practices for implementing RAG systems include proper chunking...' },
      { name: 'Embedding_Models_Comparison.pdf', progress: 100, snippet: 'A comprehensive comparison of embedding models across different dimensions...' },
      { name: 'Vector_Database_Guide.txt', progress: 100, snippet: 'Vector databases are specialized systems designed for similarity search...' },
    ]);

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
    ]);
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

  const updateTask = (id: string, field: keyof Task, value: string) => {
    setTasks(tasks.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
  };

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2>Datasets & Tasks</h2>
          <p className={`${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Upload documents and define evaluation questions
          </p>
        </div>

        {/* Upload Section */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle>Document Upload</CardTitle>
            <CardDescription>
              Upload PDFs, TXT, or DOCX files for indexing and retrieval
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center ${
                darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-300 bg-zinc-50'
              }`}
            >
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

            {files.length > 0 && (
              <div className="space-y-3">
                {files.map((file, index) => (
                  <div
                    key={index}
                    className={`p-4 rounded-lg border ${
                      darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-white'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <FileText size={20} className="mt-1 opacity-60" />
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-2">
                          <span>{file.name}</span>
                          <span className="text-sm opacity-60">{file.progress}%</span>
                        </div>
                        <Progress value={file.progress} className="mb-2" />
                        {file.progress === 100 && (
                          <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                            {file.snippet}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Button
              variant="outline"
              onClick={loadSampleDataset}
              className="gap-2"
            >
              <Sparkles size={16} />
              Load Sample Dataset
            </Button>
          </CardContent>
        </Card>

        {/* Task Builder Section */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
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
          <CardContent>
            {tasks.length === 0 ? (
              <div className={`text-center py-8 ${darkMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
                No tasks yet. Add a question or load the sample dataset.
              </div>
            ) : (
              <div className="space-y-4">
                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`p-4 rounded-lg border ${
                      darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-white'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 space-y-3">
                        <div>
                          <label className="text-sm opacity-60 block mb-1">Question</label>
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
            disabled={files.length === 0 || tasks.length === 0}
            className="gap-2"
          >
            Proceed to Pipeline Setup →
          </Button>
        </div>
      </div>
    </div>
  );
}
