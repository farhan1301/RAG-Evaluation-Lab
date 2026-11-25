import { Link } from 'react-router';
import { Switch } from './ui/switch';
import { useEffect, useState } from 'react';
import { Plus, ChevronDown, ChevronUp, Trash2, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Slider } from './ui/slider';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Badge } from './ui/badge';
import { usePipelines } from '../state/pipelines';
import type { Pipeline, PipelineStageKey } from '../types/pipeline';

interface PipelineStageProps {
  title: string;
  description: string;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const stages: PipelineStageKey[] = ['parsing', 'chunking', 'embedding', 'vectordb', 'retriever', 'reranker', 'llm', 'judge'];

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

const EMBEDDING_MODEL_COSTS: Record<string, string> = {
  'text-embedding-3-small': '$0.02 / 1M tokens',
  'text-embedding-3-large': '$0.13 / 1M tokens',
};

function PipelineStage({ title, description, isExpanded, onToggle, children }: PipelineStageProps) {
  return (
    <div className="border border-border bg-card rounded-lg">
      <button type="button" aria-expanded={isExpanded}
        onClick={onToggle}
        className="w-full p-4 flex flex-wrap items-center justify-between gap-2 hover:opacity-80 transition-opacity"
      >
        <span className="text-left">
          <span className="block font-semibold">{title}</span>
          <span className="text-sm text-muted-foreground">{description}</span>
        </span>
        {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
      </button>
      {isExpanded && <div className="px-4 pb-4 space-y-4">{children}</div>}
    </div>
  );
}

export function PipelinesPage() {
  const {
    pipelines,
    setBaseline,
    addPipeline: addPipelineToContext,
    updatePipeline: updatePipelineInContext,
    removePipeline: removePipelineFromContext,
    duplicatePipeline: duplicatePipelineInContext,
  } = usePipelines();
  const [expandedStages, setExpandedStages] = useState<Record<string, PipelineStageKey[]>>(() =>
    pipelines[0] ? { [pipelines[0].id]: ['parsing'] } : {}
  );
  const isStageExpanded = (id: string, stage: PipelineStageKey) => expandedStages[id]?.includes(stage) ?? false;
  const isPipelineExpanded = (id: string) => expandedStages[id]?.length === stages.length;
  const expandAllStages = pipelines.every(({ id }) => isPipelineExpanded(id));

  function toggleStage(id: string, stage: PipelineStageKey) {
    setExpandedStages((prev) => {
      const open = prev[id] ?? [];
      return { ...prev, [id]: open.includes(stage) ? open.filter((key) => key !== stage) : [...open, stage] };
    });
  }

  function handleTogglePipelineExpansion(id: string) {
    setExpandedStages((prev) => ({ ...prev, [id]: prev[id]?.length === stages.length ? [] : stages }));
  }

  function handleToggleExpandAll() {
    setExpandedStages(expandAllStages ? {} : Object.fromEntries(pipelines.map(({ id }) => [id, stages])));
  }

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

  return (
    <div className="px-4 py-6 sm:p-8 bg-background">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1>Pipeline Configuration</h1>
            <p className="text-muted-foreground">Design RAG pipelines step-by-step</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-6">
          {pipelines.map((pipeline) => (
            <Card key={pipeline.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    {pipeline.isBaseline ? <Badge variant="outline">Baseline</Badge> :
                      <Button size="sm" variant="outline" onClick={() => setBaseline(pipeline.id)}>Set as baseline</Button>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={isPipelineExpanded(pipeline.id)}
                      onClick={() => handleTogglePipelineExpansion(pipeline.id)}
                      aria-label={isPipelineExpanded(pipeline.id) ? 'Collapse pipeline' : 'Expand pipeline'}
                    >
                      {isPipelineExpanded(pipeline.id) ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </Button>
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
                  aria-label="Pipeline name"
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
                >
                  <div>
                    <label htmlFor={`parser-${pipeline.id}`} className="text-sm opacity-60 block mb-2">Parsing Strategy</label>
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
                      <SelectTrigger id={`parser-${pipeline.id}`}>
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
                >
                  <div className="space-y-3">
                    <div>
                      <label htmlFor={`chunker-${pipeline.id}`} className="text-sm opacity-60 block mb-2">Strategy</label>
                      <Select
                        value={pipeline.chunking.strategy}
                        onValueChange={(value) =>
                          handleUpdatePipeline(pipeline.id, {
                            chunking: { ...pipeline.chunking, strategy: value as Pipeline['chunking']['strategy'] },
                          })
                        }
                      >
                        <SelectTrigger id={`chunker-${pipeline.id}`}>
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
                      <p className="text-sm opacity-60 block mb-2">
                        Chunk Size: {pipeline.chunking.chunkSize} tokens
                      </p>
                      <Slider aria-label="Chunk Size"
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
                      <p className="text-sm opacity-60 block mb-2">
                        Overlap: {pipeline.chunking.overlap}%
                      </p>
                      <Slider aria-label="Overlap"
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
                >
                  <div>
                    <Select
                      value={pipeline.embedding.model}
                      onValueChange={(value) =>
                        handleUpdatePipeline(pipeline.id, { embedding: { model: value } })
                      }
                    >
                      <SelectTrigger aria-label="Embedding model">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="text-embedding-3-small">
                          {`text-embedding-3-small (${EMBEDDING_MODEL_COSTS['text-embedding-3-small']}, 1536d, Fast)`}
                        </SelectItem>
                        <SelectItem value="text-embedding-3-large">
                          {`text-embedding-3-large (${EMBEDDING_MODEL_COSTS['text-embedding-3-large']}, 3072d, Accurate)`}
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
                >
                  <div className="p-3 rounded border border-border bg-background">
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
                >
                  <div className="space-y-3">
                    <div>
                      <label htmlFor={`top-k-${pipeline.id}`} className="text-sm opacity-60 block mb-2">Top-K Results</label>
                      <Input id={`top-k-${pipeline.id}`}
                        type="number"
                        value={pipeline.retriever.topK}
                        onChange={(e) =>
                          handleUpdatePipeline(pipeline.id, {
                            retriever: { ...pipeline.retriever, topK: Math.max(1, Math.min(20, Number.parseInt(e.target.value, 10) || 1)) },
                          })
                        }
                        min={1}
                        max={20}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Checkbox id={`dedupe-${pipeline.id}`} disabled checked={false} />
                      <label htmlFor={`dedupe-${pipeline.id}`} className="text-sm">Deduplication is unavailable in this runner</label>
                    </div>
                  </div>
                </PipelineStage>

                {/* Reranker */}
                <PipelineStage
                  title="Reranker"
                  description="Refines retrieval results"
                  isExpanded={isStageExpanded(pipeline.id, 'reranker')}
                  onToggle={() => toggleStage(pipeline.id, 'reranker')}
                >
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Switch id={`rerank-${pipeline.id}`} checked={false} disabled />
                      <label htmlFor={`rerank-${pipeline.id}`} className="text-sm">Reranking is unavailable in this runner</label>
                    </div>

                  </div>
                </PipelineStage>

                {/* LLM Generator */}
                <PipelineStage
                  title="LLM Generator"
                  description="Generates final answers"
                  isExpanded={isStageExpanded(pipeline.id, 'llm')}
                  onToggle={() => toggleStage(pipeline.id, 'llm')}
                >
                  <div className="space-y-3">
                    <div>
                      <label htmlFor={`llm-${pipeline.id}`} className="text-sm opacity-60 block mb-2">Model</label>
                      <Select
                        value={pipeline.llm.model}
                        onValueChange={(value) =>
                          handleUpdatePipeline(pipeline.id, { llm: { ...pipeline.llm, model: value } })
                        }
                      >
                        <SelectTrigger id={`llm-${pipeline.id}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MODEL_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-sm text-muted-foreground">This runner uses server defaults for temperature and token limits.</p>
                  </div>
                </PipelineStage>

                {/* Judge Model */}
                <PipelineStage
                  title="Judge Model"
                  description="Evaluates response quality"
                  isExpanded={isStageExpanded(pipeline.id, 'judge')}
                  onToggle={() => toggleStage(pipeline.id, 'judge')}
                >
                  <div className="space-y-3">
                    <div>
                      <Select
                        value={pipeline.judge.model}
                        onValueChange={(value) =>
                          handleUpdatePipeline(pipeline.id, { judge: { model: value } })
                        }
                      >
                        <SelectTrigger aria-label="Judge model">
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
                    <div className="p-3 rounded text-sm space-y-1 bg-background">
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
          <Button asChild size="lg" className="gap-2">
            <Link to="/experiments">Run experiment →</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
