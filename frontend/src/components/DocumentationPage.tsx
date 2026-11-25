import { useState } from 'react';
import {
  Book,
  Key,
  Database,
  Workflow,
  FlaskConical,
  FileText,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Copy,
  ChevronRight,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';

function CodeBlock({ code }: { code: string }) {
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setFeedback('Copied');
    } catch {
      setFeedback('Select the code to copy it manually.');
    }
  }
  return (
    <div className="mt-3 min-w-0 rounded-lg border bg-background p-4">
      <div className="mb-2 flex items-center justify-end gap-2">
        <span role="status" className="text-sm">{feedback}</span>
        <Button size="sm" variant="ghost" aria-label="Copy code" onClick={copy}><Copy size={14} /></Button>
      </div>
      <pre className="overflow-x-auto text-sm"><code>{code}</code></pre>
    </div>
  );
}

export function DocumentationPage() {
  return (
    <div className="px-4 py-6 sm:p-8 bg-background min-h-screen">
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Book className="text-blue-500 dark:text-blue-300" size={32} />
            <h1 className="text-3xl">Documentation</h1>
          </div>
          <p className="text-lg text-muted-foreground">Complete guide to using the RAG Evaluation Lab</p>
        </div>

        <Tabs defaultValue="overview" className="space-y-6">
          <TabsList aria-label="Documentation sections" className="grid h-auto w-full grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="api-keys">API Keys</TabsTrigger>
            <TabsTrigger value="datasets">Datasets</TabsTrigger>
            <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
            <TabsTrigger value="experiments">Experiments</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>What is RAG Evaluation Lab?</CardTitle>
                <CardDescription>
                  A comprehensive platform for testing and optimizing Retrieval-Augmented Generation systems
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p>
                  RAG Evaluation Lab provides a systematic workflow to design, test, and compare different RAG pipeline configurations.
                  Whether you&apos;re fine-tuning chunk sizes, comparing embedding models, or testing different LLM providers,
                  this platform gives you the tools to make data-driven decisions.
                </p>

                <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Key Philosophy</AlertTitle>
                  <AlertDescription>
                    Every component is configurable and measurable. We emphasize transparency, explainability, and scientific rigor in evaluating RAG
                    systems.
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
                      <div
                        key={step.num}
                        className="flex gap-3 p-3 rounded-lg border border-border bg-card"
                      >
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-300"
                        >
                          {step.num}
                        </div>
                        <div>
                          <div className="font-medium">{step.title}</div>
                          <div className="text-sm opacity-75">{step.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                {
                  icon: <Sparkles className="text-purple-500 dark:text-purple-300" size={20} />,
                  title: 'Key Capabilities',
                  items: ['Compare multiple RAG configurations', 'Track experiment history and results', 'Get AI-generated improvement suggestions'],
                },
                {
                  icon: <FlaskConical className="text-blue-500 dark:text-blue-300" size={20} />,
                  title: 'Common Use Cases',
                  items: ['Choosing the best embedding model', 'Optimizing chunking strategies', 'Benchmarking retrieval techniques'],
                },
              ].map((card) => (
                <Card key={card.title}>
                  <CardHeader className="flex flex-row items-center gap-3">
                    <div className="p-2 rounded-md bg-blue-500/10">{card.icon}</div>
                    <div>
                      <CardTitle className="text-lg">{card.title}</CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2 text-sm">
                      {card.items.map((item) => (
                        <li key={item} className="flex items-center gap-2">
                          <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Quick Start</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-3 text-sm">
                  {[
                    {
                      title: 'Connect API Keys',
                      description:
                        'Set LLAMA_CLOUD_API_KEY and OPENAI_API_KEY in the backend environment.',
                    },
                    {
                      title: 'Upload Documents',
                      description: 'Go to Datasets & Tasks and upload your test documents (PDFs, docs, text files).',
                    },
                    {
                      title: 'Create Test Questions',
                      description: 'Define evaluation questions with ground truth answers.',
                    },
                    {
                      title: 'Configure Pipelines',
                      description: 'Design one or more pipeline configurations to test.',
                    },
                    {
                      title: 'Run Experiments',
                      description: 'Execute experiments and monitor progress in real-time.',
                    },
                    {
                      title: 'Analyze Reports',
                      description: 'Review comprehensive metrics and AI-generated recommendations.',
                    },
                  ].map((step, index) => (
                    <li key={step.title} className="flex items-start gap-3">
                      <Badge className="h-6 w-6 rounded-full flex items-center justify-center p-0">{index + 1}</Badge>
                      <div>
                        <div className="font-medium mb-1">{step.title}</div>
                        <div className="opacity-80">{step.description}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>

          </TabsContent>

          <TabsContent value="api-keys" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Key size={20} />
                  Setting Up API Keys
                </CardTitle>
                <CardDescription>
                  Configure your API credentials for embeddings, LLMs, and other services.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Alert className="bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Security Note</AlertTitle>
                  <AlertDescription>
                    Set provider keys in the backend environment or the repository root .env.local and restart the backend.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>

            <Accordion type="single" collapsible className="space-y-3">
              <AccordionItem
                value="llamaparse"
                className="border rounded-lg px-4 border-border"
              >
                <AccordionTrigger>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-blue-100 dark:bg-blue-950">
                      <FileText className="text-blue-500 dark:text-blue-300" size={20} />
                    </div>
                    <div className="text-left">
                      <div className="font-medium">LlamaParse API Key</div>
                      <div className="text-sm opacity-60">Required for document ingestion</div>
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-4 pt-4">
                  <div>
                    <h4 className="mb-2">How to Get Your LlamaParse API Key:</h4>
                    <ol className="space-y-2 text-sm ml-4 list-decimal">
                      <li>
                        Create an account at{' '}
                        <a
                          href="https://cloud.llamaindex.ai"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 dark:text-blue-300 hover:underline inline-flex items-center gap-1"
                        >
                          cloud.llamaindex.ai <ExternalLink size={12} />
                        </a>
                      </li>
                      <li>Navigate to the API Keys section of the dashboard</li>
                      <li>Generate a new key dedicated to RAG Evaluation Lab</li>
                      <li>Copy the key and store it securely</li>
                      <li>Add it to the backend `.env` as `LLAMA_CLOUD_API_KEY`</li>
                    </ol>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="mb-2">Why You Need It:</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Powers all document parsing before chunking and experiments
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Enables page counts and job tracking within experiment logs
                      </li>
                    </ul>
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem
                value="openai"
                className="border rounded-lg px-4 border-border"
              >
                <AccordionTrigger>
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center bg-green-100 dark:bg-green-950"
                    >
                      <Key className="text-green-500 dark:text-green-300" size={20} />
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
                      <li>
                        Go to{' '}
                        <a
                          href="https://platform.openai.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 dark:text-blue-300 hover:underline inline-flex items-center gap-1"
                        >
                          platform.openai.com <ExternalLink size={12} />
                        </a>
                      </li>
                      <li>Sign up or log in to your account</li>
                      <li>Navigate to API Keys section in your account settings</li>
                      <li>Click &quot;Create new secret key&quot;</li>
                      <li>Copy the key (you won&apos;t be able to see it again!)</li>
                      <li>Set OPENAI_API_KEY in the backend environment</li>
                    </ol>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="mb-2">What You&apos;ll Need It For:</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Embedding models (text-embedding-3-small, text-embedding-3-large)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        LLM generators (GPT-5 Chat, GPT-5 Mini, GPT-4.1 family, GPT-4o series)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Judge models for evaluation
                      </li>
                    </ul>
                  </div>

                  <div>
                    <h4 className="mb-2">Example Usage:</h4>
                    <CodeBlock
                      code={`import openai

openai.api_key = "sk-..."

# Generate embeddings
response = openai.embeddings.create(
    model="text-embedding-3-small",
    input="Your text here"
)

# Use GPT for generation
response = openai.chat.completions.create(
    model="gpt-5-chat-latest",
    messages=[{"role": "user", "content": "Hello!"}]
)`}
                    />
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem
                value="cohere"
                className="border rounded-lg px-4 border-border"
              >
                <AccordionTrigger>
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center bg-purple-100 dark:bg-purple-950"
                    >
                      <Key className="text-purple-500 dark:text-purple-300" size={20} />
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
                      <li>
                        Visit{' '}
                        <a
                          href="https://dashboard.cohere.ai"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 dark:text-blue-300 hover:underline inline-flex items-center gap-1"
                        >
                          dashboard.cohere.ai <ExternalLink size={12} />
                        </a>
                      </li>
                      <li>Create an account or sign in</li>
                      <li>Go to API Keys in the dashboard</li>
                      <li>Generate a new API key</li>
                      <li>Copy and save it securely</li>
                      <li>Store the key securely</li>
                    </ol>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="mb-2">What You&apos;ll Need It For:</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Multilingual embeddings (cohere-embed-v3)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Reranking models (Cohere Rerank v3)
                      </li>
                    </ul>
                  </div>

                  <div>
                    <h4 className="mb-2">Example Usage:</h4>
                    <CodeBlock
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

              <AccordionItem
                value="anthropic"
                className="border rounded-lg px-4 border-border"
              >
                <AccordionTrigger>
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center bg-orange-100 dark:bg-orange-950"
                    >
                      <Key className="text-orange-500 dark:text-orange-300" size={20} />
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
                      <li>
                        Go to{' '}
                        <a
                          href="https://console.anthropic.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 dark:text-blue-300 hover:underline inline-flex items-center gap-1"
                        >
                          console.anthropic.com <ExternalLink size={12} />
                        </a>
                      </li>
                      <li>Sign up for an account</li>
                      <li>Navigate to API Keys</li>
                      <li>Create a new API key</li>
                      <li>Save the key securely</li>
                    </ol>
                  </div>

                  <Separator />

                  <div>
                    <h4 className="mb-2">What You&apos;ll Need It For:</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Claude 3 models (Haiku, Opus)
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                        Alternative LLM for generation and judging
                      </li>
                    </ul>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </TabsContent>

          <TabsContent value="datasets" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database size={20} />
                  Datasets &amp; Tasks
                </CardTitle>
                <CardDescription>Upload documents and create evaluation questions.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="mb-3">Uploading Documents</h4>
                  <p className="text-sm opacity-80 mb-3">
                    The Datasets page allows you to upload documents that will serve as your knowledge base for RAG evaluation.
                  </p>
                  <div
                    className="p-4 rounded-lg border border-border bg-background"
                  >
                    <h5 className="text-sm font-medium mb-2">Supported Formats:</h5>
                    <ul className="text-sm space-y-1">
                      {['PDF documents', 'Microsoft Word (.doc, .docx)', 'Text files (.txt)', 'Markdown files (.md)'].map((item) => (
                        <li key={item} className="flex items-center gap-2">
                          <CheckCircle2 size={14} className="text-green-500 dark:text-green-300" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <Separator />

                <div>
                  <h4 className="mb-3">Creating Test Questions</h4>
                  <p className="text-sm opacity-80 mb-3">Evaluation questions are the foundation of your RAG assessment. Each question should have:</p>
                  <div className="space-y-3">
                    {[
                      {
                        title: 'Question',
                        description: 'A clear, specific question that can be answered from your documents',
                      },
                      {
                        title: 'Ground Truth Answer',
                        description: 'The correct, expected answer based on your documents',
                      },
                      {
                        title: 'Context References (Optional)',
                        description: 'Specific passages that contain the answer',
                      },
                    ].map((card) => (
                    <div key={card.title} className="p-3 rounded-lg border border-border">
                        <div className="font-medium text-sm mb-1">{card.title}</div>
                        <div className="text-sm opacity-60">{card.description}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Best Practice</AlertTitle>
                  <AlertDescription>
                    Create a diverse set of questions covering different difficulty levels, topics, and answer types (factual, comparative,
                    summarization) for comprehensive evaluation.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="pipelines" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Workflow size={20} />
                  Pipeline Configuration
                </CardTitle>
                <CardDescription>Design RAG pipelines with configurable stages.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <p className="text-sm opacity-80">
                  A RAG pipeline consists of multiple stages, each responsible for a specific task. Configure each stage to test different approaches
                  and find the optimal setup.
                </p>

                <div className="space-y-4">
                  {[
                    {
                      stage: 'Chunking Strategy',
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
                      description: 'Stores and searches document embeddings',
                      options: ['Qdrant: High-performance vector search (default)'],
                      params: 'Distance metric (Cosine), top-K retrieval (1-100)',
                    },
                    {
                      stage: 'Reranking (Optional)',
                      description: 'Refines retrieved results to improve relevance',
                      options: [
                        'None: Skip reranking',
                        'Cohere Rerank v3: Optimized for long contexts',
                        'OpenAI Rerank: Balanced performance and cost',
                      ],
                      params: 'Max rerank candidates (10-200)',
                    },
                    {
                      stage: 'Generation Model',
                      description: 'Produces answers based on retrieved context',
                      options: [
                        'GPT-5 Chat Latest: Flagship reasoning and grounding',
                        'GPT-5 Mini: Balanced cost-to-quality',
                        'GPT-4.1 Mini: Efficient for bulk experimentation',
                        'GPT-4o Mini: Proven cost-effective baseline',
                      ],
                      params: 'Temperature (0-1), Max tokens (100-1000)',
                    },
                    {
                      stage: 'Evaluation Metrics',
                      description: 'Judge answers for accuracy and quality',
                      options: [
                        'Judge pass rate and coverage',
                        'Judged context precision',
                        'Groundedness',
                      ],
                      params: 'Weights for composite scoring',
                    },
                  ].map((item) => (
                    <Card key={item.stage} className="bg-card">
                      <CardContent className="p-6 space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-medium">{item.stage}</h4>
                            <p className="text-sm opacity-70">{item.description}</p>
                          </div>
                          <Badge variant="secondary">
                            Stage
                          </Badge>
                        </div>
                        <div className="space-y-2">
                          <div className="text-sm font-medium opacity-80">Common options:</div>
                          <ul className="text-sm space-y-1">
                            {item.options.map((option) => (
                              <li key={option} className="flex items-center gap-2">
                                <ChevronRight size={14} className="opacity-50" />
                                {option}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="text-sm opacity-70">
                          <span className="font-medium">Key parameters:</span> {item.params}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="experiments" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FlaskConical size={20} />
                  Running Experiments
                </CardTitle>
                <CardDescription>Execute and monitor RAG experiments.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid md:grid-cols-3 gap-3">
                  {[
                    {
                      title: 'Configure Experiment',
                      description:
                        'Select one or more pipelines, choose evaluation metrics, and define run parameters (iterations, judges, cost limits).',
                    },
                    {
                      title: 'Monitor Progress',
                      description: 'Track experiment execution in real-time with status updates, cost tracking, and retrieval stats.',
                    },
                    {
                      title: 'Compare Results',
                      description: 'View live comparisons across pipelines with key metrics highlighted and ranked.',
                    },
                  ].map((item) => (
                    <div
                      key={item.title}
                      className="p-4 rounded-lg border border-border bg-background"
                    >
                      <div className="font-medium mb-1">{item.title}</div>
                      <div className="text-sm opacity-80">{item.description}</div>
                    </div>
                  ))}
                </div>

                <Alert className="bg-purple-50 dark:bg-purple-950 border-purple-200 dark:border-purple-800">
                  <Sparkles className="h-4 w-4" />
                  <AlertTitle>Tip</AlertTitle>
                  <AlertDescription>
                    Enable automatic prompt optimization to have GPT-5 Chat suggest improvements after each run based on the latest results.
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="reports" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText size={20} />
                  Understanding Reports
                </CardTitle>
                <CardDescription>Analyze results and get AI-generated recommendations.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div>
                  <h4 className="mb-3">Report Sections</h4>
                  <div className="space-y-3">
                    {[
                      {
                        title: 'Overview',
                        description: 'High-level comparison of all pipelines with key metrics, execution time, and cost breakdown.',
                      },
                      {
                        title: 'Detailed Metrics',
                        description:
                          'In-depth analysis of each metric with charts showing performance across pipelines. Best values are highlighted in green.',
                      },
                      {
                        title: 'Question-by-Question Analysis',
                        description:
                          'Drill down into individual questions to see which pipelines performed best on specific types of queries.',
                      },
                      {
                        title: 'AI Recommendations',
                        description:
                          'GPT-5 Chat analyzes your results and provides actionable suggestions for improvement, including specific parameter adjustments.',
                      },
                      {
                        title: 'Export Options',
                        description: 'Download full reports as JSON, CSV, or formatted PDFs for sharing and documentation.',
                      },
                    ].map((section) => (
                      <div
                        key={section.title}
                        className="p-4 rounded-lg border border-border bg-background"
                      >
                        <h5 className="font-medium mb-2">{section.title}</h5>
                        <p className="text-sm opacity-80">{section.description}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <Separator />

                <div>
                  <h4 className="mb-3">Interpreting Results</h4>
                  <div className="space-y-3 text-sm">
                    <p className="opacity-80">
                      <strong>Look for trade-offs:</strong> The &quot;best&quot; pipeline depends on your priorities. A faster, cheaper pipeline might
                      sacrifice some accuracy, which could be acceptable for certain use cases.
                    </p>
                    <p className="opacity-80">
                      <strong>Consider consistency:</strong> A pipeline that performs well across all metrics is often more reliable than one that excels
                      in just one area.
                    </p>
                    <p className="opacity-80">
                      <strong>Analyze failure patterns:</strong> Understanding where and why a pipeline fails helps you make targeted improvements to
                      specific stages.
                    </p>
                  </div>
                </div>

                <Alert className="bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800">
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Best Practice</AlertTitle>
                  <AlertDescription>
                    Run experiments with representative test sets and iterate on your pipeline based on report insights. Track results in History to see
                    improvements over time.
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
