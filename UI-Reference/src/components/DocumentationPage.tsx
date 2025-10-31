import { useState } from 'react';
import { Book, Key, Database, Workflow, FlaskConical, FileText, Sparkles, AlertCircle, CheckCircle2, ExternalLink, Copy, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';

interface DocumentationPageProps {
  darkMode: boolean;
}

export function DocumentationPage({ darkMode }: DocumentationPageProps) {
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(id);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const CodeBlock = ({ code, id }: { code: string; id: string }) => (
    <div className={`relative rounded-lg border ${darkMode ? 'bg-zinc-950 border-zinc-700' : 'bg-zinc-50 border-zinc-200'} p-4 mt-3`}>
      <pre className="text-sm overflow-x-auto">
        <code>{code}</code>
      </pre>
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-2 right-2"
        onClick={() => copyToClipboard(code, id)}
      >
        {copiedText === id ? <CheckCircle2 size={14} /> : <Copy size={14} />}
      </Button>
    </div>
  );

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'} min-h-screen`}>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Book className="text-blue-500" size={32} />
            <h1 className="text-3xl">Documentation</h1>
          </div>
          <p className={`text-lg ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Complete guide to using the RAG Evaluation Lab
          </p>
        </div>

        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 lg:grid-cols-6">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="api-keys">API Keys</TabsTrigger>
            <TabsTrigger value="datasets">Datasets</TabsTrigger>
            <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
            <TabsTrigger value="experiments">Experiments</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle>What is RAG Evaluation Lab?</CardTitle>
                <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                  A comprehensive platform for testing and optimizing Retrieval-Augmented Generation systems
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p>
                  RAG Evaluation Lab provides a systematic workflow to design, test, and compare different RAG pipeline configurations. 
                  Whether you're fine-tuning chunk sizes, comparing embedding models, or testing different LLM providers, 
                  this platform gives you the tools to make data-driven decisions.
                </p>

                <Alert className={darkMode ? 'bg-blue-950/30 border-blue-900' : 'bg-blue-50 border-blue-200'}>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Key Philosophy</AlertTitle>
                  <AlertDescription>
                    Every component is configurable and measurable. We emphasize transparency, explainability, 
                    and scientific rigor in evaluating RAG systems.
                  </AlertDescription>
                </Alert>

                <div className="space-y-3 pt-4">
                  <h4>The 4-Step Workflow</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {[
                      { num: 1, title: 'Datasets & Tasks', desc: 'Upload documents and define test questions' },
                      { num: 2, title: 'Pipelines', desc: 'Configure RAG pipeline components' },
                      { num: 3, title: 'Experiments', desc: 'Run and compare multiple configurations' },
                      { num: 4, title: 'Reports', desc: 'Analyze results and get recommendations' },
                    ].map((step) => (
                      <div key={step.num} className={`flex gap-3 p-3 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-white'}`}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${darkMode ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>
                          {step.num}
                        </div>
                        <div>
                          <div className="font-medium">{step.title}</div>
                          <div className="text-sm opacity-60">{step.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle>Quick Start Guide</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-4">
                  <li className="flex gap-3">
                    <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">1</Badge>
                    <div>
                      <div className="font-medium mb-1">Set up API Keys</div>
                      <div className="text-sm opacity-80">Configure your OpenAI, Cohere, or other provider API keys in the API Keys tab</div>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">2</Badge>
                    <div>
                      <div className="font-medium mb-1">Upload Documents</div>
                      <div className="text-sm opacity-80">Go to Datasets & Tasks and upload your test documents (PDFs, docs, text files)</div>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">3</Badge>
                    <div>
                      <div className="font-medium mb-1">Create Test Questions</div>
                      <div className="text-sm opacity-80">Define evaluation questions with ground truth answers</div>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">4</Badge>
                    <div>
                      <div className="font-medium mb-1">Configure Pipelines</div>
                      <div className="text-sm opacity-80">Design one or more pipeline configurations to test</div>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">5</Badge>
                    <div>
                      <div className="font-medium mb-1">Run Experiments</div>
                      <div className="text-sm opacity-80">Execute experiments and monitor progress in real-time</div>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">6</Badge>
                    <div>
                      <div className="font-medium mb-1">Analyze Reports</div>
                      <div className="text-sm opacity-80">Review comprehensive metrics and AI-generated recommendations</div>
                    </div>
                  </li>
                </ol>
              </CardContent>
            </Card>
          </TabsContent>

          {/* API Keys Tab */}
          <TabsContent value="api-keys" className="space-y-6">
            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Key size={20} />
                  Setting Up API Keys
                </CardTitle>
                <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                  Configure your API credentials for embeddings, LLMs, and other services
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Alert className={darkMode ? 'bg-yellow-950/30 border-yellow-900' : 'bg-yellow-50 border-yellow-200'}>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Security Note</AlertTitle>
                  <AlertDescription>
                    API keys are stored locally in your browser and never sent to external servers. 
                    Always keep your keys secure and never share them publicly.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>

            <Accordion type="single" collapsible className="space-y-3">
              {/* OpenAI */}
              <AccordionItem value="openai" className={`border rounded-lg px-4 ${darkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200'}`}>
                <AccordionTrigger>
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${darkMode ? 'bg-green-500/20' : 'bg-green-100'}`}>
                      <Key className="text-green-500" size={20} />
                    </div>
                    <div className="text-left">
                      <div className="font-medium">OpenAI API Key</div>
                      <div className="text-sm opacity-60">For GPT models and embeddings</div>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-4">
                  <div>
                    <h4 className="mb-2">How to Get Your OpenAI API Key:</h4>
                    <ol className="space-y-2 text-sm ml-4 list-decimal">
                      <li>Go to <a href="https://platform.openai.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline inline-flex items-center gap-1">platform.openai.com <ExternalLink size={12} /></a></li>
                      <li>Sign up or log in to your account</li>
                      <li>Navigate to API Keys section in your account settings</li>
                      <li>Click "Create new secret key"</li>
                      <li>Copy the key (you won't be able to see it again!)</li>
                      <li>Paste it in the Settings page of this app</li>
                    </ol>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="mb-2">What You'll Need It For:</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Embedding models (text-embedding-3-small, text-embedding-3-large)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        LLM generators (GPT-4o, GPT-4o-mini, GPT-4-turbo)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Judge models for evaluation
                      </li>
                    </ul>
                  </div>

                  <div>
                    <h4 className="mb-2">Example Usage:</h4>
                    <CodeBlock
                      id="openai-example"
                      code={`import openai

openai.api_key = "sk-..."

# Generate embeddings
response = openai.embeddings.create(
    model="text-embedding-3-small",
    input="Your text here"
)

# Use GPT for generation
response = openai.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}]
)`}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Cohere */}
              <AccordionItem value="cohere" className={`border rounded-lg px-4 ${darkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200'}`}>
                <AccordionTrigger>
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${darkMode ? 'bg-purple-500/20' : 'bg-purple-100'}`}>
                      <Key className="text-purple-500" size={20} />
                    </div>
                    <div className="text-left">
                      <div className="font-medium">Cohere API Key</div>
                      <div className="text-sm opacity-60">For embeddings and reranking</div>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-4">
                  <div>
                    <h4 className="mb-2">How to Get Your Cohere API Key:</h4>
                    <ol className="space-y-2 text-sm ml-4 list-decimal">
                      <li>Visit <a href="https://dashboard.cohere.ai" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline inline-flex items-center gap-1">dashboard.cohere.ai <ExternalLink size={12} /></a></li>
                      <li>Create an account or sign in</li>
                      <li>Go to API Keys in the dashboard</li>
                      <li>Generate a new API key</li>
                      <li>Copy and save it securely</li>
                      <li>Add it to Settings in this app</li>
                    </ol>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="mb-2">What You'll Need It For:</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Multilingual embeddings (cohere-embed-v3)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Reranking models (Cohere Rerank v3)
                      </li>
                    </ul>
                  </div>

                  <div>
                    <h4 className="mb-2">Example Usage:</h4>
                    <CodeBlock
                      id="cohere-example"
                      code={`import cohere

co = cohere.Client("your-api-key")

# Generate embeddings
response = co.embed(
    texts=["Your text here"],
    model="embed-english-v3.0"
)

# Rerank results
response = co.rerank(
    query="search query",
    documents=["doc1", "doc2"],
    model="rerank-english-v3.0"
)`}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>

              {/* Anthropic */}
              <AccordionItem value="anthropic" className={`border rounded-lg px-4 ${darkMode ? 'border-zinc-700 bg-zinc-800' : 'border-zinc-200'}`}>
                <AccordionTrigger>
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${darkMode ? 'bg-orange-500/20' : 'bg-orange-100'}`}>
                      <Key className="text-orange-500" size={20} />
                    </div>
                    <div className="text-left">
                      <div className="font-medium">Anthropic API Key</div>
                      <div className="text-sm opacity-60">For Claude models</div>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-4">
                  <div>
                    <h4 className="mb-2">How to Get Your Anthropic API Key:</h4>
                    <ol className="space-y-2 text-sm ml-4 list-decimal">
                      <li>Go to <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline inline-flex items-center gap-1">console.anthropic.com <ExternalLink size={12} /></a></li>
                      <li>Sign up for an account</li>
                      <li>Navigate to API Keys</li>
                      <li>Create a new API key</li>
                      <li>Save the key securely</li>
                    </ol>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="mb-2">What You'll Need It For:</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Claude 3 models (Haiku, Opus)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Alternative LLM for generation and judging
                      </li>
                    </ul>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </TabsContent>

          {/* Datasets Tab */}
          <TabsContent value="datasets" className="space-y-6">
            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database size={20} />
                  Datasets & Tasks
                </CardTitle>
                <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                  Upload documents and create evaluation questions
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="mb-3">Uploading Documents</h4>
                  <p className="text-sm opacity-80 mb-3">
                    The Datasets page allows you to upload documents that will serve as your knowledge base for RAG evaluation.
                  </p>
                  <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
                    <h5 className="text-sm font-medium mb-2">Supported Formats:</h5>
                    <ul className="text-sm space-y-1">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        PDF documents
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Microsoft Word (.doc, .docx)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Text files (.txt)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500" />
                        Markdown files (.md)
                      </li>
                    </ul>
                  </div>
                </div>

                <Separator />

                <div>
                  <h4 className="mb-3">Creating Test Questions</h4>
                  <p className="text-sm opacity-80 mb-3">
                    Evaluation questions are the foundation of your RAG assessment. Each question should have:
                  </p>
                  <div className="space-y-3">
                    <div className={`p-3 rounded-lg border ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`}>
                      <div className="font-medium text-sm mb-1">Question</div>
                      <div className="text-sm opacity-60">A clear, specific question that can be answered from your documents</div>
                    </div>
                    <div className={`p-3 rounded-lg border ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`}>
                      <div className="font-medium text-sm mb-1">Ground Truth Answer</div>
                      <div className="text-sm opacity-60">The correct, expected answer based on your documents</div>
                    </div>
                    <div className={`p-3 rounded-lg border ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`}>
                      <div className="font-medium text-sm mb-1">Context References (Optional)</div>
                      <div className="text-sm opacity-60">Specific passages that contain the answer</div>
                    </div>
                  </div>
                </div>

                <Alert className={darkMode ? 'bg-blue-950/30 border-blue-900' : 'bg-blue-50 border-blue-200'}>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Best Practice</AlertTitle>
                  <AlertDescription>
                    Create a diverse set of questions covering different difficulty levels, topics, and answer types 
                    (factual, comparative, summarization) for comprehensive evaluation.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Pipelines Tab */}
          <TabsContent value="pipelines" className="space-y-6">
            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Workflow size={20} />
                  Pipeline Configuration
                </CardTitle>
                <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                  Design RAG pipelines with configurable stages
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-sm opacity-80">
                  A RAG pipeline consists of multiple stages, each responsible for a specific task. 
                  Configure each stage to test different approaches and find the optimal setup.
                </p>

                <div className="space-y-4">
                  {[
                    {
                      stage: 'Chunking Strategy',
                      icon: '📄',
                      description: 'How documents are split into manageable pieces',
                      options: [
                        'Recursive: Character-based splitting with overlap',
                        'Semantic: Meaning-based chunking using embeddings',
                        'Layout-aware: Preserves PDF structure',
                        'Table Splitter: Specialized for tabular data',
                      ],
                      params: 'Chunk Size (100-1000 tokens), Overlap (0-50%)',
                    },
                    {
                      stage: 'Embedding Model',
                      icon: '🔢',
                      description: 'Converts text chunks into vector representations',
                      options: [
                        'text-embedding-3-small: Fast, cost-effective (1536d)',
                        'text-embedding-3-large: High accuracy (3072d)',
                        'cohere-embed-v3: Multilingual support (1024d)',
                      ],
                      params: 'Model selection',
                    },
                    {
                      stage: 'Vector Database',
                      icon: '💾',
                      description: 'Stores and searches document embeddings',
                      options: [
                        'Qdrant: High-performance vector search (default)',
                      ],
                      params: 'Fixed configuration',
                    },
                    {
                      stage: 'Retriever',
                      icon: '🔍',
                      description: 'Finds relevant chunks for a given query',
                      options: [
                        'Similarity search with configurable Top-K',
                        'Optional deduplication of similar results',
                      ],
                      params: 'Top-K (1-20), Deduplication (on/off)',
                    },
                    {
                      stage: 'Reranker (Optional)',
                      icon: '⚡',
                      description: 'Refines retrieval results for better relevance',
                      options: [
                        'Cohere Rerank v3: State-of-the-art reranking',
                        'BGE Reranker: Open-source alternative',
                      ],
                      params: 'Enable/disable, Model selection',
                    },
                    {
                      stage: 'LLM Generator',
                      icon: '🤖',
                      description: 'Generates the final answer using retrieved context',
                      options: [
                        'GPT-4o Mini: Fast and cost-effective',
                        'GPT-4o: Balanced performance',
                        'GPT-4 Turbo: Most capable',
                        'Claude 3 Haiku: Alternative provider',
                      ],
                      params: 'Model, Temperature (0-1), Max Tokens',
                    },
                    {
                      stage: 'Judge Model',
                      icon: '⚖️',
                      description: 'Evaluates response quality and accuracy',
                      options: [
                        'GPT-4o: Recommended for reliability',
                        'Claude 3 Opus: Alternative evaluator',
                      ],
                      params: 'Model selection',
                    },
                  ].map((stage, idx) => (
                    <Card key={idx} className={darkMode ? 'bg-zinc-900 border-zinc-700' : 'border-zinc-200'}>
                      <CardHeader>
                        <CardTitle className="text-base flex items-center gap-2">
                          <span>{stage.icon}</span>
                          {stage.stage}
                        </CardTitle>
                        <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                          {stage.description}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div>
                          <div className="text-sm font-medium mb-2">Options:</div>
                          <ul className="space-y-1 text-sm">
                            {stage.options.map((option, i) => (
                              <li key={i} className="flex items-start gap-2">
                                <ChevronRight size={14} className="mt-1 flex-shrink-0 opacity-60" />
                                <span className="opacity-80">{option}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className={`text-sm p-2 rounded ${darkMode ? 'bg-zinc-800' : 'bg-zinc-50'}`}>
                          <span className="opacity-60">Parameters:</span> {stage.params}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles size={20} />
                  Auto-Compare Feature
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm opacity-80">
                  The Auto-Compare feature automatically tests all combinations of key parameters to find the optimal configuration.
                </p>
                <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
                  <h5 className="text-sm font-medium mb-2">What It Tests:</h5>
                  <ul className="text-sm space-y-1">
                    <li>• 3 chunking strategies × 3 chunk sizes</li>
                    <li>• 2 embedding models</li>
                    <li>• 3 Top-K values</li>
                    <li>• 2 LLM models × 2 temperatures</li>
                    <li><strong>= 108 unique configurations</strong></li>
                  </ul>
                </div>
                <p className="text-sm opacity-80">
                  The system runs each configuration sequentially, tracks metrics, and identifies the best-performing setup 
                  based on overall score. Results are displayed in real-time with progress tracking.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Experiments Tab */}
          <TabsContent value="experiments" className="space-y-6">
            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FlaskConical size={20} />
                  Running Experiments
                </CardTitle>
                <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                  Compare pipelines and track results in real-time
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="mb-3">How Experiments Work</h4>
                  <ol className="space-y-3 text-sm">
                    <li className="flex gap-3">
                      <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0 flex-shrink-0">1</Badge>
                      <div>
                        <div className="font-medium">Select Dataset</div>
                        <div className="opacity-60">Choose which documents and questions to use</div>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0 flex-shrink-0">2</Badge>
                      <div>
                        <div className="font-medium">Choose Pipelines</div>
                        <div className="opacity-60">Select multiple pipeline configurations to compare</div>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0 flex-shrink-0">3</Badge>
                      <div>
                        <div className="font-medium">Run Experiment</div>
                        <div className="opacity-60">Execute tests across all questions and pipelines</div>
                      </div>
                    </li>
                    <li className="flex gap-3">
                      <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0 flex-shrink-0">4</Badge>
                      <div>
                        <div className="font-medium">Monitor Progress</div>
                        <div className="opacity-60">Watch live updates as each question is processed</div>
                      </div>
                    </li>
                  </ol>
                </div>

                <Separator />

                <div>
                  <h4 className="mb-3">Metrics Explained</h4>
                  <div className="space-y-3">
                    {[
                      { metric: 'Accuracy', desc: 'Percentage of questions answered correctly', range: '0-100%' },
                      { metric: 'Faithfulness', desc: 'How well answers align with retrieved context', range: '0-1' },
                      { metric: 'Answer Relevance', desc: 'How directly the answer addresses the question', range: '0-1' },
                      { metric: 'Context Precision', desc: 'Accuracy of retrieved context', range: '0-1' },
                      { metric: 'Context Recall', desc: 'Completeness of retrieved context', range: '0-1' },
                      { metric: 'Latency', desc: 'Average response time per question', range: 'milliseconds' },
                      { metric: 'Cost', desc: 'Total API costs for the experiment', range: 'USD' },
                    ].map((item, idx) => (
                      <div key={idx} className={`p-3 rounded-lg border ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`}>
                        <div className="flex justify-between items-start mb-1">
                          <div className="font-medium text-sm">{item.metric}</div>
                          <Badge variant="outline" className="text-xs">{item.range}</Badge>
                        </div>
                        <div className="text-sm opacity-60">{item.desc}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <Alert className={darkMode ? 'bg-blue-950/30 border-blue-900' : 'bg-blue-50 border-blue-200'}>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Live Tracking</AlertTitle>
                  <AlertDescription>
                    The Experiments page shows real-time progress with expandable details for each question, 
                    including retrieved contexts, generated answers, and evaluation scores.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Reports Tab */}
          <TabsContent value="reports" className="space-y-6">
            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText size={20} />
                  Understanding Reports
                </CardTitle>
                <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                  Analyze results and get AI-generated recommendations
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="mb-3">Report Sections</h4>
                  <div className="space-y-3">
                    <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
                      <h5 className="font-medium mb-2">Overview</h5>
                      <p className="text-sm opacity-80">
                        High-level comparison of all pipelines with key metrics, execution time, and cost breakdown.
                      </p>
                    </div>
                    <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
                      <h5 className="font-medium mb-2">Detailed Metrics</h5>
                      <p className="text-sm opacity-80">
                        In-depth analysis of each metric with charts showing performance across pipelines. 
                        Best values are highlighted in green.
                      </p>
                    </div>
                    <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
                      <h5 className="font-medium mb-2">Question-by-Question Analysis</h5>
                      <p className="text-sm opacity-80">
                        Drill down into individual questions to see which pipelines performed best on specific types of queries.
                      </p>
                    </div>
                    <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
                      <h5 className="font-medium mb-2">AI Recommendations</h5>
                      <p className="text-sm opacity-80">
                        GPT-4o analyzes your results and provides actionable suggestions for improvement, 
                        including specific parameter adjustments.
                      </p>
                    </div>
                    <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
                      <h5 className="font-medium mb-2">Export Options</h5>
                      <p className="text-sm opacity-80">
                        Download full reports as JSON, CSV, or formatted PDFs for sharing and documentation.
                      </p>
                    </div>
                  </div>
                </div>

                <Separator />

                <div>
                  <h4 className="mb-3">Interpreting Results</h4>
                  <div className="space-y-3 text-sm">
                    <p className="opacity-80">
                      <strong>Look for trade-offs:</strong> The "best" pipeline depends on your priorities. 
                      A faster, cheaper pipeline might sacrifice some accuracy, which could be acceptable for certain use cases.
                    </p>
                    <p className="opacity-80">
                      <strong>Consider consistency:</strong> A pipeline that performs well across all metrics 
                      is often more reliable than one that excels in just one area.
                    </p>
                    <p className="opacity-80">
                      <strong>Analyze failure patterns:</strong> Understanding where and why a pipeline fails 
                      helps you make targeted improvements to specific stages.
                    </p>
                  </div>
                </div>

                <Alert className={darkMode ? 'bg-green-950/30 border-green-900' : 'bg-green-50 border-green-200'}>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Best Practice</AlertTitle>
                  <AlertDescription>
                    Run experiments with representative test sets and iterate on your pipeline based on report insights. 
                    Track results in History to see improvements over time.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
