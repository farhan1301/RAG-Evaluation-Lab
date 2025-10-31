import { Sparkles, Layers, Brain, Database, Zap, Palette, Star } from 'lucide-react';
import { Card } from './ui/card';
import { Badge } from './ui/badge';

interface ComingSoonPageProps {
  darkMode: boolean;
}

export function ComingSoonPage({ darkMode }: ComingSoonPageProps) {
  const upcomingFeatures = [
    {
      icon: Layers,
      title: 'Re-ranking',
      description: 'Advanced re-ranking algorithms to improve retrieval quality and relevance scoring',
      category: 'Retrieval',
      priority: 'High',
      eta: 'Q1 2026'
    },
    {
      icon: Brain,
      title: 'Claude API & Models',
      description: 'Integration with Anthropic\'s Claude models for enhanced language understanding and generation',
      category: 'LLM',
      priority: 'High',
      eta: 'Q1 2026'
    },
    {
      icon: Brain,
      title: 'Cohere API & Models',
      description: 'Support for Cohere\'s embedding and reranking models to expand your pipeline options',
      category: 'LLM',
      priority: 'High',
      eta: 'Q1 2026'
    },
    {
      icon: Brain,
      title: 'Additional Embedding Models',
      description: 'Out-of-the-box support for emerging embedding providers to widen retrieval experimentation',
      category: 'LLM',
      priority: 'Medium',
      eta: 'Q2 2026'
    },
    {
      icon: Zap,
      title: 'Additional Metrics',
      description: 'Expanded evaluation metrics including MRR, MAP, NDCG, and custom metric definitions',
      category: 'Evaluation',
      priority: 'Medium',
      eta: 'Q1 2026'
    },
    {
      icon: Sparkles,
      title: 'Enhanced Auto-Compare Mode',
      description: 'Intelligent auto-compare with early stopping, adaptive sampling, and parallelization',
      category: 'Automation',
      priority: 'High',
      eta: 'Q2 2026'
    },
    {
      icon: Database,
      title: 'Advanced Retriever Techniques',
      description: 'Hybrid search, query expansion, HyDE, and multi-vector retrieval strategies',
      category: 'Retrieval',
      priority: 'Medium',
      eta: 'Q2 2026'
    },
    {
      icon: Star,
      title: 'Enhanced AI Insights',
      description: 'Improved AI-generated recommendations with deeper analysis and actionable suggestions',
      category: 'Intelligence',
      priority: 'Medium',
      eta: 'Q2 2026'
    },
    {
      icon: Palette,
      title: 'Proper Dark Mode',
      description: 'Fully refined dark mode with optimized colors, contrast, and visual consistency',
      category: 'UI/UX',
      priority: 'Low',
      eta: 'Q1 2026'
    }
  ];

  const categoryColors = {
    'Retrieval': darkMode ? 'bg-purple-500/20 text-purple-300 border-purple-500/30' : 'bg-purple-50 text-purple-700 border-purple-200',
    'LLM': darkMode ? 'bg-blue-500/20 text-blue-300 border-blue-500/30' : 'bg-blue-50 text-blue-700 border-blue-200',
    'Evaluation': darkMode ? 'bg-green-500/20 text-green-300 border-green-500/30' : 'bg-green-50 text-green-700 border-green-200',
    'Automation': darkMode ? 'bg-orange-500/20 text-orange-300 border-orange-500/30' : 'bg-orange-50 text-orange-700 border-orange-200',
    'Intelligence': darkMode ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30' : 'bg-yellow-50 text-yellow-700 border-yellow-200',
    'UI/UX': darkMode ? 'bg-pink-500/20 text-pink-300 border-pink-500/30' : 'bg-pink-50 text-pink-700 border-pink-200'
  };

  return (
    <div className={`min-h-[calc(100vh-73px)] p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Sparkles className={darkMode ? 'text-blue-400' : 'text-blue-600'} size={32} />
            <h1 className="tracking-tight">Coming Soon</h1>
          </div>
          <p className={`text-lg ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
            Exciting features and improvements on the roadmap for RAG Evaluation Lab
          </p>
        </div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {upcomingFeatures.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <Card 
                key={index}
                className={`p-6 transition-all hover:shadow-lg ${
                  darkMode 
                    ? 'bg-zinc-800 border-zinc-700 hover:border-zinc-600' 
                    : 'bg-white border-zinc-200 hover:border-zinc-300'
                }`}
              >
                {/* Icon */}
                <div className="mb-4">
                  <div className={`p-3 rounded-lg w-fit ${
                    darkMode ? 'bg-zinc-700' : 'bg-zinc-100'
                  }`}>
                    <Icon 
                      size={24} 
                      className={darkMode ? 'text-blue-400' : 'text-blue-600'} 
                    />
                  </div>
                </div>

                {/* Title */}
                <h3 className="mb-2 tracking-tight">
                  {feature.title}
                </h3>

                {/* Description */}
                <p className={`text-sm mb-4 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  {feature.description}
                </p>

                {/* Footer */}
                <div className={`flex items-center justify-between pt-4 border-t ${darkMode ? 'border-zinc-700' : 'border-zinc-200'}`}>
                  <Badge 
                    variant="outline" 
                    className={categoryColors[feature.category as keyof typeof categoryColors]}
                  >
                    {feature.category}
                  </Badge>
                  <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                    {feature.eta}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>

        {/* Roadmap Note */}
        <Card className={`mt-8 p-6 ${
          darkMode 
            ? 'bg-blue-500/10 border-blue-500/20' 
            : 'bg-blue-50 border-blue-200'
        }`}>
          <div className="flex gap-4">
            <div className={`p-2 rounded-lg h-fit ${
              darkMode ? 'bg-blue-500/20' : 'bg-blue-100'
            }`}>
              <Sparkles className={darkMode ? 'text-blue-400' : 'text-blue-600'} size={20} />
            </div>
            <div>
              <h3 className={`mb-2 ${darkMode ? 'text-blue-400' : 'text-blue-900'}`}>
                Have a Feature Request?
              </h3>
              <p className={`text-sm ${darkMode ? 'text-blue-300/80' : 'text-blue-900/70'}`}>
                We're actively developing RAG Evaluation Lab and would love to hear your feedback. 
                These timelines are estimates and may change based on user priorities and technical considerations. 
                If you have suggestions or would like to see a feature prioritized, please let us know!
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
