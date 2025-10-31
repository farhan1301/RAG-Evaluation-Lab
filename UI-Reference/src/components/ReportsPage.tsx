import { Download, FileText, FileJson } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from 'recharts';

interface ReportsPageProps {
  darkMode: boolean;
}

export function ReportsPage({ darkMode }: ReportsPageProps) {
  const barChartData = [
    { name: 'Precision@5', A: 0.82, B: 0.77, C: 0.85 },
    { name: 'Recall@5', A: 0.75, B: 0.71, C: 0.79 },
    { name: 'Groundedness', A: 0.91, B: 0.88, C: 0.93 },
  ];

  const costLatencyData = [
    { name: 'Latency (s)', A: 3.4, B: 2.8, C: 4.1 },
    { name: 'Cost ($×100)', A: 0.6, B: 0.5, C: 0.9 },
  ];

  const radarData = [
    { metric: 'Precision', A: 82, B: 77, C: 85 },
    { metric: 'Recall', A: 75, B: 71, C: 79 },
    { metric: 'Groundedness', A: 91, B: 88, C: 93 },
    { metric: 'Speed', A: 65, B: 80, C: 55 },
    { metric: 'Cost Efficiency', A: 70, B: 85, C: 50 },
  ];

  // Baseline is Pipeline A
  const pipelineMetrics = {
    A: {
      name: 'Baseline Config',
      precision: 0.82,
      recall: 0.75,
      groundedness: 0.91,
      latency: 3.4,
      cost: 0.006,
    },
    B: {
      name: 'Fast & Efficient',
      precision: 0.77,
      recall: 0.71,
      groundedness: 0.88,
      latency: 2.8,
      cost: 0.005,
    },
    C: {
      name: 'High Accuracy',
      precision: 0.85,
      recall: 0.79,
      groundedness: 0.93,
      latency: 4.1,
      cost: 0.009,
    },
  };

  const getComparison = (value: number, baseline: number, lowerIsBetter = false) => {
    const diff = ((value - baseline) / baseline) * 100;
    const isPositive = lowerIsBetter ? diff < 0 : diff > 0;
    return { diff: Math.abs(diff), isPositive };
  };

  const getBestValue = (values: number[], lowerIsBetter = false) => {
    return lowerIsBetter ? Math.min(...values) : Math.max(...values);
  };

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Experiment Report #12</h2>
            <p className={`${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Generated on Thursday, October 16, 2025 at 12:58 PM
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="gap-2">
              <FileText size={16} />
              Export PDF
            </Button>
            <Button variant="outline" className="gap-2">
              <Download size={16} />
              Export Markdown
            </Button>
            <Button variant="outline" className="gap-2">
              <FileJson size={16} />
              Export JSON
            </Button>
          </div>
        </div>

        {/* AI-Generated Recommendation - Moved to Top */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>AI-Generated Recommendation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className={darkMode ? 'text-zinc-300' : 'text-zinc-700'}>
              Given your dataset and evaluation questions, <strong>Pipeline B (Fast & Efficient)</strong> achieved the best balance
              between cost and grounding quality. While Pipeline C showed marginally better groundedness
              (0.93 vs 0.91), Pipeline B delivered significantly faster response times (2.8s vs 4.1s p95)
              and 44% lower cost per query ($0.005 vs $0.009).
            </p>
            
            <div className={`p-4 rounded-lg border ${darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-zinc-50'}`}>
              <p className={`mb-2 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Recommended Configuration:</p>
              <ul className={`space-y-1 text-sm ${darkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>
                <li>• <strong>Chunking:</strong> Semantic chunking with 400 tokens, 30% overlap</li>
                <li>• <strong>Embedding:</strong> text-embedding-3-large (higher dimensional)</li>
                <li>• <strong>Retrieval:</strong> Top-K=3 without deduplication</li>
                <li>• <strong>Reranker:</strong> Enabled with Cohere Rerank v3</li>
                <li>• <strong>LLM:</strong> GPT-4 Turbo at temperature 0.5, max 750 tokens</li>
                <li>• <strong>Judge:</strong> GPT-4o for evaluation</li>
              </ul>
            </div>

            <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
              This configuration is optimized for production use cases where response quality and latency
              are both critical. For lower-budget scenarios, consider Pipeline B with GPT-4o-mini instead
              of GPT-4 Turbo.
            </p>
          </CardContent>
        </Card>

        {/* Pipeline Comparison Overview */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Pipeline Comparison Overview</CardTitle>
            <CardDescription className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
              All metrics compared against Pipeline A (Baseline)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(pipelineMetrics).map(([key, pipeline]) => {
                const isBaseline = key === 'A';
                const baseline = pipelineMetrics.A;
                
                const precisionComp = getComparison(pipeline.precision, baseline.precision);
                const recallComp = getComparison(pipeline.recall, baseline.recall);
                const groundednessComp = getComparison(pipeline.groundedness, baseline.groundedness);
                const latencyComp = getComparison(pipeline.latency, baseline.latency, true);
                const costComp = getComparison(pipeline.cost, baseline.cost, true);

                const bestPrecision = getBestValue([pipelineMetrics.A.precision, pipelineMetrics.B.precision, pipelineMetrics.C.precision]);
                const bestRecall = getBestValue([pipelineMetrics.A.recall, pipelineMetrics.B.recall, pipelineMetrics.C.recall]);
                const bestGroundedness = getBestValue([pipelineMetrics.A.groundedness, pipelineMetrics.B.groundedness, pipelineMetrics.C.groundedness]);
                const bestLatency = getBestValue([pipelineMetrics.A.latency, pipelineMetrics.B.latency, pipelineMetrics.C.latency], true);
                const bestCost = getBestValue([pipelineMetrics.A.cost, pipelineMetrics.B.cost, pipelineMetrics.C.cost], true);

                return (
                  <div
                    key={key}
                    className={`p-4 rounded-lg border ${
                      darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-white'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Pipeline {key}</h4>
                        <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>{pipeline.name}</p>
                      </div>
                      {isBaseline && <Badge variant="outline">Baseline</Badge>}
                    </div>
                    
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Precision@5</p>
                        <div className="flex items-center gap-2">
                          <span className={pipeline.precision === bestPrecision ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-zinc-300' : 'text-zinc-900')}>
                            {pipeline.precision.toFixed(2)}
                          </span>
                          {!isBaseline && (
                            <span className={`text-xs flex items-center ${precisionComp.isPositive ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-red-400' : 'text-red-600')}`}>
                              {precisionComp.isPositive ? '↑' : '↓'}{precisionComp.diff.toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Recall@5</p>
                        <div className="flex items-center gap-2">
                          <span className={pipeline.recall === bestRecall ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-zinc-300' : 'text-zinc-900')}>
                            {pipeline.recall.toFixed(2)}
                          </span>
                          {!isBaseline && (
                            <span className={`text-xs flex items-center ${recallComp.isPositive ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-red-400' : 'text-red-600')}`}>
                              {recallComp.isPositive ? '↑' : '↓'}{recallComp.diff.toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Groundedness</p>
                        <div className="flex items-center gap-2">
                          <span className={pipeline.groundedness === bestGroundedness ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-zinc-300' : 'text-zinc-900')}>
                            {pipeline.groundedness.toFixed(2)}
                          </span>
                          {!isBaseline && (
                            <span className={`text-xs flex items-center ${groundednessComp.isPositive ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-red-400' : 'text-red-600')}`}>
                              {groundednessComp.isPositive ? '↑' : '↓'}{groundednessComp.diff.toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Latency (p95)</p>
                        <div className="flex items-center gap-2">
                          <span className={pipeline.latency === bestLatency ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-zinc-300' : 'text-zinc-900')}>
                            {pipeline.latency.toFixed(1)}s
                          </span>
                          {!isBaseline && (
                            <span className={`text-xs flex items-center ${latencyComp.isPositive ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-red-400' : 'text-red-600')}`}>
                              {latencyComp.isPositive ? '↓' : '↑'}{latencyComp.diff.toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>

                      <div>
                        <p className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Cost/Query</p>
                        <div className="flex items-center gap-2">
                          <span className={pipeline.cost === bestCost ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-zinc-300' : 'text-zinc-900')}>
                            ${pipeline.cost.toFixed(3)}
                          </span>
                          {!isBaseline && (
                            <span className={`text-xs flex items-center ${costComp.isPositive ? (darkMode ? 'text-green-400' : 'text-green-600') : (darkMode ? 'text-red-400' : 'text-red-600')}`}>
                              {costComp.isPositive ? '↓' : '↑'}{costComp.diff.toFixed(0)}%
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Dataset Info */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Dataset Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <p className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>Documents</p>
                <p className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>3 files</p>
              </div>
              <div>
                <p className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>Evaluation Tasks</p>
                <p className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>3 questions</p>
              </div>
              <div>
                <p className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>Pipelines Tested</p>
                <p className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>3 configurations</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Bar Chart - Quality Metrics */}
          <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
            <CardHeader>
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Quality Metrics Comparison</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={barChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#3f3f46' : '#e4e4e7'} />
                  <XAxis dataKey="name" stroke={darkMode ? '#a1a1aa' : '#52525b'} />
                  <YAxis stroke={darkMode ? '#a1a1aa' : '#52525b'} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: darkMode ? '#27272a' : '#ffffff',
                      border: `1px solid ${darkMode ? '#3f3f46' : '#e4e4e7'}`,
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  <Bar dataKey="A" fill="#3b82f6" name="Pipeline A" />
                  <Bar dataKey="B" fill="#10b981" name="Pipeline B" />
                  <Bar dataKey="C" fill="#f59e0b" name="Pipeline C" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Bar Chart - Cost & Latency */}
          <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
            <CardHeader>
              <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Cost & Latency Comparison</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={costLatencyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={darkMode ? '#3f3f46' : '#e4e4e7'} />
                  <XAxis dataKey="name" stroke={darkMode ? '#a1a1aa' : '#52525b'} />
                  <YAxis stroke={darkMode ? '#a1a1aa' : '#52525b'} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: darkMode ? '#27272a' : '#ffffff',
                      border: `1px solid ${darkMode ? '#3f3f46' : '#e4e4e7'}`,
                      borderRadius: '8px',
                    }}
                  />
                  <Legend />
                  <Bar dataKey="A" fill="#3b82f6" name="Pipeline A" />
                  <Bar dataKey="B" fill="#10b981" name="Pipeline B" />
                  <Bar dataKey="C" fill="#f59e0b" name="Pipeline C" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

        {/* Radar Chart */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Overall Performance Radar</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={400}>
              <RadarChart data={radarData}>
                <PolarGrid stroke={darkMode ? '#3f3f46' : '#e4e4e7'} />
                <PolarAngleAxis dataKey="metric" stroke={darkMode ? '#a1a1aa' : '#52525b'} />
                <PolarRadiusAxis angle={90} domain={[0, 100]} stroke={darkMode ? '#a1a1aa' : '#52525b'} />
                <Radar name="Pipeline A" dataKey="A" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} />
                <Radar name="Pipeline B" dataKey="B" stroke="#10b981" fill="#10b981" fillOpacity={0.3} />
                <Radar name="Pipeline C" dataKey="C" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.3} />
                <Legend />
              </RadarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>



        {/* Task-by-Task Breakdown */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardHeader>
            <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Task-by-Task Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              {
                question: 'What is the optimal chunk size for dense documents?',
                best: 'Pipeline C',
                score: 0.95,
                note: 'All pipelines retrieved relevant context',
              },
              {
                question: 'Which embedding model provides the best cost-performance ratio?',
                best: 'Pipeline B',
                score: 0.92,
                note: 'Pipeline B provided most concise and accurate answer',
              },
              {
                question: 'What are the key factors in vector database selection?',
                best: 'Pipeline A',
                score: 0.88,
                note: 'Pipeline A retrieved more comprehensive context',
              },
            ].map((task, index) => (
              <div
                key={index}
                className={`p-4 rounded-lg border ${
                  darkMode ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-200 bg-white'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <p className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>{task.question}</p>
                  <Badge>{task.best}</Badge>
                </div>
                <div className={`flex items-center gap-4 text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  <span>Score: {task.score}</span>
                  <span>•</span>
                  <span>{task.note}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Export Options Footer */}
        <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Ready to export this report?</p>
                <p className={`text-sm ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Share results with your team or save for future reference
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline">
                  Copy Sharing Link
                </Button>
                <Button>
                  Download All Formats
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
