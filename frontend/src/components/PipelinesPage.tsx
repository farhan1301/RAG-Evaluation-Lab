import { useEffect, useState } from 'react';
import { Plus, ChevronDown, ChevronUp, Trash2, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Slider } from './ui/slider';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Badge } from './ui/badge';
import { usePipelines } from '../state/pipelines';
import type { Pipeline } from '../types/pipeline';

interface PipelinesPageProps {
  darkMode: boolean;
  onNext: () => void;
}

interface PipelineStageProps {
  title: string;
  description: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  darkMode: boolean;
}

const MODEL_OPTIONS = [
  { value: 'gpt-5-chat-latest', label: 'GPT-5 Chat (Latest)' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
  { value: 'gpt-4o', label: 'GPT-4o (Balanced, $$)' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast, $)' },
  { value: 'gpt-4-turbo', label: 'GPT-4 Turbo (Advanced, $$$)' },
];

function PipelineStage({ title, description, isExpanded, onToggle, children, darkMode }: PipelineStageProps) {
  return (
    <div
      className={`border rounded-lg ${
        darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-white'
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full p-4 flex items-center justify-between hover:opacity-80 transition-opacity"
      >
        <div className="text-left">
          <h4>{title}</h4>
          <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>{description}</p>
        </div>
        {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
      </button>
      {isExpanded && <div className="px-4 pb-4 space-y-4">{children}</div>}
    </div>
  );
}

export function PipelinesPage({ darkMode, onNext }: PipelinesPageProps) {
  const {
    pipelines,
    addPipeline: addPipelineToContext,
    updatePipeline: updatePipelineInContext,
    removePipeline: removePipelineFromContext,
    duplicatePipeline: duplicatePipelineInContext,
  } = usePipelines();
  const [expandedStages, setExpandedStages] = useState<{ [key: string]: string }>(() => {
    const firstPipelineId = pipelines[0]?.id;
    return firstPipelineId ? { [firstPipelineId]: 'parsing' } : {};
  });
  const [expandAllStages, setExpandAllStages] = useState(false);

  const toggleStage = (pipelineId: string, stage: string) => {
    if (expandAllStages) {
      setExpandAllStages(false);
      setExpandedStages({ [pipelineId]: stage });
      return;
    }
    setExpandedStages((prev) => ({
      ...prev,
      [pipelineId]: prev[pipelineId] === stage ? '' : stage,
    }));
  };

  const handleAddPipeline = () => {
    const baseline = pipelines.find((pipeline) => pipeline.isBaseline) ?? pipelines[0];
    const overrides = baseline
      ? {
          parsing: { ...baseline.parsing },
          chunking: { ...baseline.chunking },
          embedding: { ...baseline.embedding },
          retriever: { ...baseline.retriever },
          reranker: { ...baseline.reranker },
          llm: { ...baseline.llm },
          judge: { ...baseline.judge },
        }
      : undefined;

    addPipelineToContext(overrides);
  };

  const handleRemovePipeline = (id: string) => {
    removePipelineFromContext(id);
  };

  const handleUpdatePipeline = (id: string, updates: Partial<Pipeline>) => {
    updatePipelineInContext(id, updates);
  };

  const handleDuplicatePipeline = (id: string) => {
    duplicatePipelineInContext(id);
  };

  useEffect(() => {
    pipelines.forEach((pipeline) => {
      const updates: Partial<Pipeline> = {};
      let requiresUpdate = false;

      if (pipeline.embedding.model === 'cohere-embed-v3') {
        updates.embedding = { model: 'text-embedding-3-small' };
        requiresUpdate = true;
      }

      const llmModel = pipeline.llm.model;
      if (llmModel.startsWith('claude')) {
        updates.llm = { ...pipeline.llm, model: 'gpt-4o-mini' };
        requiresUpdate = true;
      }

      const judgeModel = pipeline.judge.model;
      if (judgeModel.startsWith('claude')) {
        updates.judge = { model: 'gpt-4o' };
        requiresUpdate = true;
      }

      if (pipeline.reranker.enabled) {
        updates.reranker = { ...pipeline.reranker, enabled: false };
        requiresUpdate = true;
      }

      if (requiresUpdate) {
        updatePipelineInContext(pipeline.id, updates);
      }
    });
  }, [pipelines, updatePipelineInContext]);

  const isStageExpanded = (pipelineId: string, stage: string) =>
    expandAllStages || expandedStages[pipelineId] === stage;

  const handleToggleExpandAll = () => {
    setExpandAllStages((prev) => !prev);
  };

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2>Pipeline Configuration</h2>
            <p className={`${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Design RAG pipelines step-by-step
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleToggleExpandAll}>
              {expandAllStages ? 'Collapse All' : 'Expand All'}
            </Button>
            <Button onClick={handleAddPipeline} className="gap-2">
              <Plus size={16} />
              Add Pipeline to Compare
            </Button>
          </div>
        </div>

        {/* Pipelines Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {pipelines.map((pipeline) => (
            <Card key={pipeline.id} className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{pipeline.isBaseline ? 'Baseline' : 'Variant'}</Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDuplicatePipeline(pipeline.id)}
                      aria-label="Duplicate pipeline"
                    >
                      <Copy size={16} />
                    </Button>
                    {pipelines.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemovePipeline(pipeline.id)}
                        aria-label="Remove pipeline"
                      >
                        <Trash2 size={16} />
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  value={pipeline.name}
                  onChange={(e) => handleUpdatePipeline(pipeline.id, { name: e.target.value })}
                  className="text-lg mb-0"
                  placeholder="Pipeline name..."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Parsing */}
                <PipelineStage
                  title="Document Parsing"
                  description="Convert uploaded files into text before chunking"
                  isExpanded={isStageExpanded(pipeline.id, 'parsing')}
                  onToggle={() => toggleStage(pipeline.id, 'parsing')}
                  darkMode={darkMode}
                >
                  <div>
                    <label className="text-sm opacity-60 block mb-2">Parsing Strategy</label>
                    <Select
                      value={pipeline.parsing.strategy}
                      onValueChange={(value) =>
                        handleUpdatePipeline(pipeline.id, {
                          parsing: {
                            ...pipeline.parsing,
                            strategy: value as Pipeline['parsing']['strategy'],
                          },
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="llama-parse">LlamaParse (cloud)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </PipelineStage>

                {/* Chunking */}
                <PipelineStage
                  title="Chunking"
                  description="How documents are split into pieces"
                  isExpanded={isStageExpanded(pipeline.id, 'chunking')}
                  onToggle={() => toggleStage(pipeline.id, 'chunking')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm opacity-60 block mb-2">Strategy</label>
                      <Select
                        value={pipeline.chunking.strategy}
                        onValueChange={(value) =>
                          handleUpdatePipeline(pipeline.id, {
                            chunking: { ...pipeline.chunking, strategy: value },
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="recursive">Recursive (Character-based)</SelectItem>
                          <SelectItem value="semantic">Semantic (Meaning-based)</SelectItem>
                          <SelectItem value="layout">Layout-aware (PDF)</SelectItem>
                          <SelectItem value="table">Table Splitter</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm opacity-60 block mb-2">
                        Chunk Size: {pipeline.chunking.chunkSize} tokens
                      </label>
                      <Slider
                        value={[pipeline.chunking.chunkSize]}
                        onValueChange={([value]) =>
                          handleUpdatePipeline(pipeline.id, {
                            chunking: { ...pipeline.chunking, chunkSize: value },
                          })
                        }
                        min={100}
                        max={1000}
                        step={50}
                      />
                    </div>
                    <div>
                      <label className="text-sm opacity-60 block mb-2">
                        Overlap: {pipeline.chunking.overlap}%
                      </label>
                      <Slider
                        value={[pipeline.chunking.overlap]}
                        onValueChange={([value]) =>
                          handleUpdatePipeline(pipeline.id, {
                            chunking: { ...pipeline.chunking, overlap: value },
                          })
                        }
                        min={0}
                        max={50}
                        step={5}
                      />
                    </div>
                  </div>
                </PipelineStage>

                {/* Embedding Model */}
                <PipelineStage
                  title="Embedding Model"
                  description="Converts text to vectors"
                  isExpanded={isStageExpanded(pipeline.id, 'embedding')}
                  onToggle={() => toggleStage(pipeline.id, 'embedding')}
                  darkMode={darkMode}
                >
                  <div>
                    <Select
                      value={pipeline.embedding.model}
                      onValueChange={(value) =>
                        handleUpdatePipeline(pipeline.id, { embedding: { model: value } })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text-embedding-3-small">
                          text-embedding-3-small (1536d, Fast, $)
                        </SelectItem>
                        <SelectItem value="text-embedding-3-large">
                          text-embedding-3-large (3072d, Accurate, $$)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </PipelineStage>

                {/* Vector Database */}
                <PipelineStage
                  title="Vector Database"
                  description="Stores document embeddings"
                  isExpanded={isStageExpanded(pipeline.id, 'vectordb')}
                  onToggle={() => toggleStage(pipeline.id, 'vectordb')}
                  darkMode={darkMode}
                >
                  <div className={`p-3 rounded border ${darkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-zinc-50'}`}>
                    <p className="text-sm">
                      <span className="opacity-60">Using:</span> Qdrant
                    </p>
                    <p className="text-sm opacity-60 mt-1">
                      High-performance vector similarity search engine
                    </p>
                  </div>
                </PipelineStage>

                {/* Retriever */}
                <PipelineStage
                  title="Retriever"
                  description="Finds relevant chunks"
                  isExpanded={isStageExpanded(pipeline.id, 'retriever')}
                  onToggle={() => toggleStage(pipeline.id, 'retriever')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm opacity-60 block mb-2">Top-K Results</label>
                      <Input
                        type="number"
                        value={pipeline.retriever.topK}
                        onChange={(e) =>
                          handleUpdatePipeline(pipeline.id, {
                            retriever: { ...pipeline.retriever, topK: parseInt(e.target.value) },
                          })
                        }
                        min={1}
                        max={20}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={pipeline.retriever.deduplicate}
                        onCheckedChange={(checked) =>
                          handleUpdatePipeline(pipeline.id, {
                            retriever: { ...pipeline.retriever, deduplicate: checked as boolean },
                          })
                        }
                      />
                      <label className="text-sm">Deduplicate similar chunks</label>
                    </div>
                  </div>
                </PipelineStage>

                {/* Reranker */}
                <PipelineStage
                  title="Reranker"
                  description="Refines retrieval results"
                  isExpanded={isStageExpanded(pipeline.id, 'reranker')}
                  onToggle={() => toggleStage(pipeline.id, 'reranker')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={pipeline.reranker.enabled}
                        disabled
                        onCheckedChange={(checked) =>
                          handleUpdatePipeline(pipeline.id, {
                            reranker: { ...pipeline.reranker, enabled: checked as boolean },
                          })
                        }
                      />
                      <label className="text-sm opacity-60">Enable reranking (coming soon)</label>
                    </div>
                    {pipeline.reranker.enabled && (
                      <Select
                        value={pipeline.reranker.model}
                        onValueChange={(value) =>
                          handleUpdatePipeline(pipeline.id, {
                            reranker: { ...pipeline.reranker, model: value },
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cohere-rerank">Cohere Rerank v3</SelectItem>
                          <SelectItem value="bge-reranker">BGE Reranker</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </PipelineStage>

                {/* LLM Generator */}
                <PipelineStage
                  title="LLM Generator"
                  description="Generates final answers"
                  isExpanded={isStageExpanded(pipeline.id, 'llm')}
                  onToggle={() => toggleStage(pipeline.id, 'llm')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm opacity-60 block mb-2">Model</label>
                      <Select
                        value={pipeline.llm.model}
                        onValueChange={(value) =>
                          handleUpdatePipeline(pipeline.id, { llm: { ...pipeline.llm, model: value } })
                        }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {MODEL_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm opacity-60 block mb-2">
                        Temperature: {pipeline.llm.temperature}
                      </label>
                      <Slider
                        value={[pipeline.llm.temperature]}
                        onValueChange={([value]) =>
                          handleUpdatePipeline(pipeline.id, { llm: { ...pipeline.llm, temperature: value } })
                        }
                        min={0}
                        max={1}
                        step={0.1}
                      />
                    </div>
                    <div>
                      <label className="text-sm opacity-60 block mb-2">Max Tokens</label>
                      <Input
                        type="number"
                        value={pipeline.llm.maxTokens}
                        onChange={(e) =>
                          handleUpdatePipeline(pipeline.id, {
                            llm: { ...pipeline.llm, maxTokens: parseInt(e.target.value) },
                          })
                        }
                      />
                    </div>
                  </div>
                </PipelineStage>

                {/* Judge Model */}
                <PipelineStage
                  title="Judge Model"
                  description="Evaluates response quality"
                  isExpanded={isStageExpanded(pipeline.id, 'judge')}
                  onToggle={() => toggleStage(pipeline.id, 'judge')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div>
                      <Select
                        value={pipeline.judge.model}
                        onValueChange={(value) =>
                          handleUpdatePipeline(pipeline.id, { judge: { model: value } })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MODEL_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className={`p-3 rounded text-sm space-y-1 ${darkMode ? 'bg-zinc-800' : 'bg-zinc-50'}`}>
                      <p className="opacity-60">Evaluation Rubric:</p>
                      <p>✓ Groundedness in context</p>
                      <p>✓ Faithfulness to sources</p>
                      <p>✓ Completeness of answer</p>
                    </div>
                  </div>
                </PipelineStage>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Bottom CTA */}
        <div className="flex justify-end">
          <Button onClick={onNext} size="lg" className="gap-2">
            Run Experiment →
          </Button>
        </div>
      </div>
    </div>
  );
}
