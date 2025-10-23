import { ArrowRight, Database, Workflow, FlaskConical, FileText, Sparkles, CheckCircle2, TrendingUp, Zap, Shield } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';

interface HomePageProps {
  darkMode: boolean;
  onNavigate: (page: string) => void;
}

export function HomePage({ darkMode, onNavigate }: HomePageProps) {
  const workflowSteps = [
    {
      number: 1,
      title: 'Datasets & Tasks',
      description: 'Upload documents and define evaluation questions',
      icon: Database,
      color: 'blue',
      actions: ['Upload PDFs, docs, text files', 'Create ground truth Q&A pairs', 'Organize test datasets'],
    },
    {
      number: 2,
      title: 'Pipelines',
      description: 'Design RAG pipelines with configurable stages',
      icon: Workflow,
      color: 'purple',
      actions: ['Configure chunking strategies', 'Select embeddings & LLMs', 'Enable rerankers & judges'],
    },
    {
      number: 3,
      title: 'Experiments',
      description: 'Run comparisons and track live results',
      icon: FlaskConical,
      color: 'green',
      actions: ['Compare multiple pipelines', 'Monitor real-time progress', 'Auto-find best configs'],
    },
    {
      number: 4,
      title: 'Reports',
      description: 'View comprehensive analysis and insights',
      icon: FileText,
      color: 'orange',
      actions: ['Detailed metric breakdowns', 'AI-generated recommendations', 'Export findings'],
    },
  ];

  const features = [
    {
      icon: Sparkles,
      title: 'Compare',
      description: 'Quickly evaluate pipeline configurations side-by-side to find optimal setups',
      color: 'from-blue-500 to-cyan-500',
    },
    {
      icon: TrendingUp,
      title: 'Live Tracking',
      description: 'Monitor experiments in real-time with detailed progress indicators',
      color: 'from-green-500 to-emerald-500',
    },
    {
      icon: Shield,
      title: 'Transparency',
      description: 'Full visibility into every stage with explainable metrics and reasoning',
      color: 'from-purple-500 to-pink-500',
    },
    {
      icon: Zap,
      title: 'Modular Design',
      description: 'Mix and match components to build the perfect RAG pipeline',
      color: 'from-orange-500 to-red-500',
    },
  ];

  const stats = [
    { label: 'Pipeline Stages', value: '6+', description: 'Configurable components' },
    { label: 'Metrics Tracked', value: '10+', description: 'Comprehensive evaluation' },
    { label: 'Model Options', value: '15+', description: 'LLMs & embeddings' },
    { label: 'Compare', value: '100+', description: 'Pipeline variants tested' },
  ];

  return (
    <div className={`min-h-screen ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      {/* Hero Section */}
      <div className={`relative overflow-hidden ${darkMode ? 'bg-gradient-to-br from-zinc-900 via-zinc-800 to-zinc-900' : 'bg-gradient-to-br from-white via-zinc-50 to-white'}`}>
        <div className="absolute inset-0 opacity-20">
          <div className="absolute top-20 left-20 w-72 h-72 bg-blue-500 rounded-full blur-3xl"></div>
          <div className="absolute bottom-20 right-20 w-96 h-96 bg-purple-500 rounded-full blur-3xl"></div>
        </div>
        
        <div className="relative max-w-7xl mx-auto px-8 py-20">
          <div className="text-center space-y-6">
            <Badge variant="outline" className="px-4 py-1.5">
              RAG Evaluation Platform
            </Badge>
            <h1 className="text-5xl">
              Evaluate & Optimize Your
              <br />
              <span className="bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 bg-clip-text text-transparent">
                RAG Pipelines
              </span>
            </h1>
            <p className={`text-xl max-w-2xl mx-auto ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              A comprehensive lab for testing, comparing, and perfecting your Retrieval-Augmented Generation systems with transparency and scientific rigor.
            </p>
            <div className="flex gap-4 justify-center pt-4">
              <Button size="lg" onClick={() => onNavigate('datasets')} className="gap-2">
                Get Started
                <ArrowRight size={16} />
              </Button>
              <Button size="lg" variant="outline" onClick={() => onNavigate('experiments')}>
                View Demo
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-16">
            {stats.map((stat, idx) => (
              <Card key={idx} className={darkMode ? 'bg-zinc-800/50 border-zinc-700 backdrop-blur' : 'bg-white/50 backdrop-blur'}>
                <CardContent className="p-6 text-center">
                  <div className="text-3xl mb-1 bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent">
                    {stat.value}
                  </div>
                  <div className="text-sm opacity-60">{stat.label}</div>
                  <div className="text-xs opacity-40 mt-1">{stat.description}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-16 space-y-20">
        {/* Workflow Section */}
        <section>
          <div className="text-center mb-12">
            <h2 className="text-3xl mb-3">How It Works</h2>
            <p className={`text-lg ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              A systematic 4-step workflow for rigorous RAG evaluation
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {workflowSteps.map((step, idx) => {
              const Icon = step.icon;
              const colorMap: { [key: string]: string } = {
                blue: darkMode ? 'from-blue-500/20 to-blue-600/20 border-blue-500/30' : 'from-blue-50 to-blue-100 border-blue-200',
                purple: darkMode ? 'from-purple-500/20 to-purple-600/20 border-purple-500/30' : 'from-purple-50 to-purple-100 border-purple-200',
                green: darkMode ? 'from-green-500/20 to-green-600/20 border-green-500/30' : 'from-green-50 to-green-100 border-green-200',
                orange: darkMode ? 'from-orange-500/20 to-orange-600/20 border-orange-500/30' : 'from-orange-50 to-orange-100 border-orange-200',
              };
              const iconColorMap: { [key: string]: string } = {
                blue: 'text-blue-500',
                purple: 'text-purple-500',
                green: 'text-green-500',
                orange: 'text-orange-500',
              };

              return (
                <div key={idx} className="relative h-full">
                  <Card className={`${darkMode ? 'bg-zinc-800 border-zinc-700' : 'border-zinc-200'} hover:shadow-lg transition-shadow h-full`}>
                    <CardHeader>
                      <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${colorMap[step.color]} border flex items-center justify-center mb-4`}>
                        <Icon className={iconColorMap[step.color]} size={24} />
                      </div>
                      <div className="flex items-center gap-2 mb-2">
                        <Badge variant="outline" className="w-6 h-6 rounded-full flex items-center justify-center p-0">
                          {step.number}
                        </Badge>
                        <CardTitle className="text-lg">{step.title}</CardTitle>
                      </div>
                      <CardDescription className={darkMode ? 'text-zinc-400' : ''}>
                        {step.description}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ul className="space-y-2">
                        {step.actions.map((action, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm">
                            <CheckCircle2 size={16} className={`${iconColorMap[step.color]} mt-0.5 flex-shrink-0`} />
                            <span className="opacity-80">{action}</span>
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                  
                  {/* Arrow connector */}
                  {idx < workflowSteps.length - 1 && (
                    <div className="hidden xl:flex absolute inset-y-0 right-[-32px] items-center z-10">
                      <ArrowRight className={`${darkMode ? 'text-zinc-700' : 'text-zinc-300'}`} size={24} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="text-center mt-8">
            <Button size="lg" onClick={() => onNavigate('datasets')} className="gap-2">
              Start Your First Evaluation
              <ArrowRight size={16} />
            </Button>
          </div>
        </section>

        {/* Features Section */}
        <section>
          <div className="text-center mb-12">
            <h2 className="text-3xl mb-3">Key Features</h2>
            <p className={`text-lg ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Built for data scientists who demand precision and transparency
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {features.map((feature, idx) => {
              const Icon = feature.icon;
              return (
                <Card
                  key={idx}
                  className={`h-full ${darkMode ? 'bg-zinc-800 border-zinc-700' : 'border-zinc-200'} hover:shadow-lg transition-shadow`}
                >
                  <CardHeader className="items-center justify-items-center text-center justify-center gap-3 h-full">
                    <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${feature.color} flex items-center justify-center mb-4 mx-auto`}>
                      <Icon className="text-white" size={24} />
                    </div>
                    <CardTitle>{feature.title}</CardTitle>
                    <CardDescription className={`${darkMode ? 'text-zinc-400' : ''} text-center`}>
                      {feature.description}
                    </CardDescription>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        </section>

        {/* Pipeline Visualization */}
        <section>
          <div className="text-center mb-12">
            <h2 className="text-3xl mb-3">Configurable Pipeline Stages</h2>
            <p className={`text-lg ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Design end-to-end RAG systems with granular control
            </p>
          </div>

          <Card className={`${darkMode ? 'bg-zinc-800 border-zinc-700' : 'border-zinc-200'}`}>
            <CardContent className="p-8 overflow-x-auto">
              <div className="flex flex-col md:flex-row md:flex-nowrap items-center md:items-stretch justify-center gap-4 md:gap-6">
                {[
                  { label: 'Chunking', desc: 'Strategy & Size' },
                  { label: 'Embedding', desc: 'Vector Model' },
                  { label: 'Retriever', desc: 'Top-K Search' },
                  { label: 'Reranker', desc: 'Optional' },
                  { label: 'LLM', desc: 'Generator' },
                  { label: 'Judge', desc: 'Evaluator' },
                ].map((stage, idx, arr) => (
                  <div key={idx} className="flex items-center justify-center gap-4 w-full md:w-auto">
                    <div className={`flex-1 md:flex-initial p-4 rounded-lg border-2 ${darkMode ? 'border-zinc-700 bg-zinc-900' : 'border-zinc-200 bg-white'} text-center min-w-[140px] md:min-w-[150px]`}>
                      <div className="font-medium mb-1">{stage.label}</div>
                      <div className="text-xs opacity-60">{stage.desc}</div>
                    </div>
                    {idx < arr.length - 1 && (
                      <ArrowRight className={`hidden md:block ${darkMode ? 'text-zinc-600' : 'text-zinc-400'} flex-shrink-0`} size={20} />
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        {/* CTA Section */}
        <section className={`rounded-2xl p-12 text-center ${darkMode ? 'bg-gradient-to-br from-zinc-800 to-zinc-900 border border-zinc-700' : 'bg-gradient-to-br from-blue-50 to-purple-50 border border-zinc-200'}`}>
          <h2 className="text-3xl mb-4">Ready to Optimize Your RAG System?</h2>
          <p className={`text-lg mb-8 max-w-2xl mx-auto ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Upload your documents, configure your pipelines, and discover what works best for your use case.
          </p>
          <div className="flex gap-4 justify-center">
            <Button size="lg" onClick={() => onNavigate('datasets')} className="gap-2">
              Upload Documents
              <Database size={16} />
            </Button>
            <Button size="lg" variant="outline" onClick={() => onNavigate('pipelines')}>
              Design Pipeline
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
