import { useState } from 'react';
import { Plus, ChevronDown, ChevronUp, Copy, Trash2, Sparkles, Play, Check, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Slider } from './ui/slider';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { Progress } from './ui/progress';
import { ScrollArea } from './ui/scroll-area';

interface Pipeline {
  id: string;
  name: string;
  chunking: {
    strategy: string;
    chunkSize: number;
    overlap: number;
  };
  embedding: {
    model: string;
  };
  retriever: {
    topK: number;
    deduplicate: boolean;
  };
  reranker: {
    enabled: boolean;
    model: string;
  };
  llm: {
    model: string;
    temperature: number;
    maxTokens: number;
  };
  judge: {
    model: string;
  };
}

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
  const [pipelines, setPipelines] = useState<Pipeline[]>([
    {
      id: '1',
      name: 'Baseline Config',
      chunking: { strategy: 'recursive', chunkSize: 300, overlap: 20 },
      embedding: { model: 'text-embedding-3-small' },
      retriever: { topK: 5, deduplicate: true },
      reranker: { enabled: false, model: 'cohere-rerank' },
      llm: { model: 'gpt-4o-mini', temperature: 0.7, maxTokens: 500 },
      judge: { model: 'gpt-4o' },
    },
  ]);

  const [expandedStages, setExpandedStages] = useState<{ [key: string]: string }>({
    '1': 'chunking',
  });

  const [autoCompareOpen, setAutoCompareOpen] = useState(false);
  const [autoCompareRunning, setAutoCompareRunning] = useState(false);
  const [autoCompareProgress, setAutoCompareProgress] = useState(0);
  const [currentCombination, setCurrentCombination] = useState(0);
  const [totalCombinations, setTotalCombinations] = useState(0);
  const [bestPipeline, setBestPipeline] = useState<{ config: string; score: number } | null>(null);
  const [completedTests, setCompletedTests] = useState<Array<{ name: string; score: number; status: 'completed' | 'running' | 'pending' }>>([]);

  const toggleStage = (pipelineId: string, stage: string) => {
    setExpandedStages((prev) => ({
      ...prev,
      [pipelineId]: prev[pipelineId] === stage ? '' : stage,
    }));
  };

  const addPipeline = () => {
    const newPipeline: Pipeline = {
      id: Date.now().toString(),
      name: `Configuration ${pipelines.length + 1}`,
      chunking: { strategy: 'semantic', chunkSize: 400, overlap: 30 },
      embedding: { model: 'text-embedding-3-large' },
      retriever: { topK: 3, deduplicate: false },
      reranker: { enabled: true, model: 'cohere-rerank' },
      llm: { model: 'gpt-4-turbo', temperature: 0.5, maxTokens: 750 },
      judge: { model: 'gpt-4o' },
    };
    setPipelines([...pipelines, newPipeline]);
  };

  const removePipeline = (id: string) => {
    setPipelines(pipelines.filter((p) => p.id !== id));
  };

  const updatePipeline = (id: string, updates: Partial<Pipeline>) => {
    setPipelines(pipelines.map((p) => (p.id === id ? { ...p, ...updates } : p)));
  };

  const generateAllCombinations = () => {
    const chunkingStrategies = ['recursive', 'semantic', 'layout'];
    const chunkSizes = [200, 400, 600];
    const embeddingModels = ['text-embedding-3-small', 'text-embedding-3-large'];
    const topKValues = [3, 5, 10];
    const llmModels = ['gpt-4o-mini', 'gpt-4o'];
    const temperatures = [0.3, 0.7];

    const combinations: Pipeline[] = [];
    let id = 1;

    chunkingStrategies.forEach(strategy => {
      chunkSizes.forEach(size => {
        embeddingModels.forEach(embedding => {
          topKValues.forEach(topK => {
            llmModels.forEach(llm => {
              temperatures.forEach(temp => {
                combinations.push({
                  id: `combo-${id++}`,
                  name: `${strategy.slice(0, 3)}_${size}_${embedding.includes('large') ? 'lg' : 'sm'}_k${topK}_${llm.includes('mini') ? 'mini' : '4o'}_t${temp}`,
                  chunking: { strategy, chunkSize: size, overlap: 20 },
                  embedding: { model: embedding },
                  retriever: { topK, deduplicate: true },
                  reranker: { enabled: false, model: 'cohere-rerank' },
                  llm: { model: llm, temperature: temp, maxTokens: 500 },
                  judge: { model: 'gpt-4o' },
                });
              });
            });
          });
        });
      });
    });

    return combinations;
  };

  const startAutoCompare = async () => {
    const combinations = generateAllCombinations();
    setTotalCombinations(combinations.length);
    setAutoCompareRunning(true);
    setCurrentCombination(0);
    setBestPipeline(null);

    // Initialize test list
    const tests = combinations.map((combo, idx) => ({
      name: combo.name,
      score: 0,
      status: (idx === 0 ? 'running' : 'pending') as 'completed' | 'running' | 'pending'
    }));
    setCompletedTests(tests);

    let best = { config: '', score: 0 };

    for (let i = 0; i < combinations.length; i++) {
      setCurrentCombination(i + 1);
      
      // Update status to running
      setCompletedTests(prev => prev.map((test, idx) => 
        idx === i ? { ...test, status: 'running' } : test
      ));

      // Simulate experiment run (in real app, this would call actual API)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Generate mock score
      const score = Math.random() * 0.4 + 0.6; // Score between 0.6 and 1.0
      
      // Update completed test
      setCompletedTests(prev => prev.map((test, idx) => 
        idx === i ? { ...test, score, status: 'completed' } : test
      ));

      if (score > best.score) {
        best = { config: combinations[i].name, score };
        setBestPipeline(best);
      }

      setAutoCompareProgress((i + 1) / combinations.length * 100);
    }

    setAutoCompareRunning(false);
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
          <Button onClick={addPipeline} className="gap-2">
            <Plus size={16} />
            Add Pipeline to Compare
          </Button>
        </div>

        {/* Pipelines Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {pipelines.map((pipeline) => (
            <Card key={pipeline.id} className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{pipeline.id === '1' ? 'Baseline' : 'Variant'}</Badge>
                  </div>
                  {pipelines.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removePipeline(pipeline.id)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  )}
                </div>
                <Input
                  value={pipeline.name}
                  onChange={(e) => updatePipeline(pipeline.id, { name: e.target.value })}
                  className="text-lg mb-0"
                  placeholder="Pipeline name..."
                />
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Chunking Strategy */}
                <PipelineStage
                  title="Chunking Strategy"
                  description="How documents are split into pieces"
                  isExpanded={expandedStages[pipeline.id] === 'chunking'}
                  onToggle={() => toggleStage(pipeline.id, 'chunking')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm opacity-60 block mb-2">Strategy</label>
                      <Select
                        value={pipeline.chunking.strategy}
                        onValueChange={(value) =>
                          updatePipeline(pipeline.id, {
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
                          updatePipeline(pipeline.id, {
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
                          updatePipeline(pipeline.id, {
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
                  isExpanded={expandedStages[pipeline.id] === 'embedding'}
                  onToggle={() => toggleStage(pipeline.id, 'embedding')}
                  darkMode={darkMode}
                >
                  <div>
                    <Select
                      value={pipeline.embedding.model}
                      onValueChange={(value) =>
                        updatePipeline(pipeline.id, { embedding: { model: value } })
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
                        <SelectItem value="cohere-embed-v3">
                          cohere-embed-v3 (1024d, Multilingual, $)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </PipelineStage>

                {/* Vector Database */}
                <PipelineStage
                  title="Vector Database"
                  description="Stores document embeddings"
                  isExpanded={expandedStages[pipeline.id] === 'vectordb'}
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
                  isExpanded={expandedStages[pipeline.id] === 'retriever'}
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
                          updatePipeline(pipeline.id, {
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
                          updatePipeline(pipeline.id, {
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
                  isExpanded={expandedStages[pipeline.id] === 'reranker'}
                  onToggle={() => toggleStage(pipeline.id, 'reranker')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={pipeline.reranker.enabled}
                        onCheckedChange={(checked) =>
                          updatePipeline(pipeline.id, {
                            reranker: { ...pipeline.reranker, enabled: checked as boolean },
                          })
                        }
                      />
                      <label className="text-sm">Enable reranking</label>
                    </div>
                    {pipeline.reranker.enabled && (
                      <Select
                        value={pipeline.reranker.model}
                        onValueChange={(value) =>
                          updatePipeline(pipeline.id, {
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
                  isExpanded={expandedStages[pipeline.id] === 'llm'}
                  onToggle={() => toggleStage(pipeline.id, 'llm')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div>
                      <label className="text-sm opacity-60 block mb-2">Model</label>
                      <Select
                        value={pipeline.llm.model}
                        onValueChange={(value) =>
                          updatePipeline(pipeline.id, { llm: { ...pipeline.llm, model: value } })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gpt-4o-mini">GPT-4o Mini (Fast, $)</SelectItem>
                          <SelectItem value="gpt-4o">GPT-4o (Balanced, $$)</SelectItem>
                          <SelectItem value="gpt-4-turbo">GPT-4 Turbo (Advanced, $$$)</SelectItem>
                          <SelectItem value="claude-3-haiku">Claude 3 Haiku (Fast, $)</SelectItem>
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
                          updatePipeline(pipeline.id, { llm: { ...pipeline.llm, temperature: value } })
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
                          updatePipeline(pipeline.id, {
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
                  isExpanded={expandedStages[pipeline.id] === 'judge'}
                  onToggle={() => toggleStage(pipeline.id, 'judge')}
                  darkMode={darkMode}
                >
                  <div className="space-y-3">
                    <div>
                      <Select
                        value={pipeline.judge.model}
                        onValueChange={(value) =>
                          updatePipeline(pipeline.id, { judge: { model: value } })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="gpt-4o">GPT-4o (Recommended)</SelectItem>
                          <SelectItem value="claude-3-opus">Claude 3 Opus</SelectItem>
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
        <div className="flex justify-between items-center">
          <Button 
            onClick={() => setAutoCompareOpen(true)} 
            size="lg" 
            variant="outline"
            className="gap-2"
          >
            <Sparkles size={16} />
            Auto-Compare All Combinations
          </Button>
          <Button onClick={onNext} size="lg" className="gap-2">
            Run Experiment →
          </Button>
        </div>

        {/* Auto-Compare Dialog */}
        <Dialog open={autoCompareOpen} onOpenChange={setAutoCompareOpen}>
          <DialogContent className={`max-w-3xl ${darkMode ? 'bg-zinc-900 border-zinc-700' : ''}`}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles size={20} />
                Auto-Compare Pipeline Configurations
              </DialogTitle>
              <DialogDescription className={darkMode ? 'text-zinc-400' : ''}>
                Automatically test all combinations of key parameters to find the optimal configuration
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {!autoCompareRunning && completedTests.length === 0 && (
                <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200 bg-zinc-50'}`}>
                  <h4 className="mb-2">Parameters to Test:</h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="opacity-60">Chunking Strategies:</p>
                      <p>Recursive, Semantic, Layout</p>
                    </div>
                    <div>
                      <p className="opacity-60">Chunk Sizes:</p>
                      <p>200, 400, 600 tokens</p>
                    </div>
                    <div>
                      <p className="opacity-60">Embedding Models:</p>
                      <p>Small, Large</p>
                    </div>
                    <div>
                      <p className="opacity-60">Top-K Values:</p>
                      <p>3, 5, 10</p>
                    </div>
                    <div>
                      <p className="opacity-60">LLM Models:</p>
                      <p>GPT-4o Mini, GPT-4o</p>
                    </div>
                    <div>
                      <p className="opacity-60">Temperatures:</p>
                      <p>0.3, 0.7</p>
                    </div>
                  </div>
                  <div className={`mt-4 p-3 rounded ${darkMode ? 'bg-zinc-700' : 'bg-blue-50'}`}>
                    <p className="text-sm">
                      <strong>Total Combinations: {generateAllCombinations().length}</strong>
                    </p>
                    <p className="text-sm opacity-60 mt-1">
                      Estimated time: ~{Math.ceil(generateAllCombinations().length * 2 / 60)} minutes
                    </p>
                  </div>
                </div>
              )}

              {(autoCompareRunning || completedTests.length > 0) && (
                <>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Progress</span>
                      <span>{currentCombination} / {totalCombinations} combinations</span>
                    </div>
                    <Progress value={autoCompareProgress} className="h-2" />
                  </div>

                  {bestPipeline && (
                    <div className={`p-4 rounded-lg border-2 ${darkMode ? 'border-green-700 bg-green-950/30' : 'border-green-500 bg-green-50'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <Check className="text-green-500" size={18} />
                        <h4>Best Configuration So Far</h4>
                      </div>
                      <p className="text-sm opacity-60 mb-2">{bestPipeline.config}</p>
                      <div className="flex items-baseline gap-2">
                        <span className="text-2xl">{(bestPipeline.score * 100).toFixed(1)}%</span>
                        <span className="text-sm opacity-60">Overall Score</span>
                      </div>
                    </div>
                  )}

                  <ScrollArea className={`h-64 rounded-lg border ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`}>
                    <div className="p-4 space-y-2">
                      {completedTests.map((test, idx) => (
                        <div
                          key={idx}
                          className={`flex items-center justify-between p-3 rounded ${
                            darkMode ? 'bg-zinc-800' : 'bg-zinc-50'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            {test.status === 'running' && <Loader2 size={16} className="animate-spin text-blue-500" />}
                            {test.status === 'completed' && <Check size={16} className="text-green-500" />}
                            {test.status === 'pending' && <div className={`w-4 h-4 rounded-full ${darkMode ? 'bg-zinc-700' : 'bg-zinc-300'}`} />}
                            <span className="text-sm font-mono">{test.name}</span>
                          </div>
                          {test.status === 'completed' && (
                            <Badge variant={test.score === bestPipeline?.score ? 'default' : 'outline'}>
                              {(test.score * 100).toFixed(1)}%
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </>
              )}
            </div>

            <DialogFooter>
              {!autoCompareRunning && completedTests.length === 0 && (
                <>
                  <Button variant="outline" onClick={() => setAutoCompareOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={startAutoCompare} className="gap-2">
                    <Play size={16} />
                    Start Auto-Compare
                  </Button>
                </>
              )}
              {autoCompareRunning && (
                <Button variant="outline" disabled>
                  <Loader2 size={16} className="animate-spin mr-2" />
                  Running...
                </Button>
              )}
              {!autoCompareRunning && completedTests.length > 0 && (
                <Button onClick={() => {
                  setAutoCompareOpen(false);
                  setCompletedTests([]);
                  setAutoCompareProgress(0);
                }}>
                  Close
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
