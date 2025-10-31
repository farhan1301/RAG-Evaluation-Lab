import { useState, useEffect } from 'react';
import { Play, CheckCircle, Clock, DollarSign, Zap } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';

interface ExperimentsPageProps {
  darkMode: boolean;
  onNext: () => void;
}

type Stage = 'idle' | 'embedding' | 'retrieval' | 'answering' | 'judging' | 'complete';

export function ExperimentsPage({ darkMode, onNext }: ExperimentsPageProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [currentTask, setCurrentTask] = useState(0);
  const totalTasks = 3;

  const [metrics, setMetrics] = useState({
    precisionAt5: { A: 0, B: 0, C: 0 },
    recallAt5: { A: 0, B: 0, C: 0 },
    latencyP95: { A: 0, B: 0, C: 0 },
    groundedness: { A: 0, B: 0, C: 0 },
    costPerQuery: { A: 0, B: 0, C: 0 },
    tokensUsed: { A: 0, B: 0, C: 0 },
  });

  const [statusLog, setStatusLog] = useState<string[]>([]);

  const startExperiment = () => {
    setStage('embedding');
    setProgress(0);
    setCurrentTask(0);
    setStatusLog(['Experiment started...']);

    // Simulate experiment stages
    const stages: Stage[] = ['embedding', 'retrieval', 'answering', 'judging', 'complete'];
    let stageIndex = 0;
    let taskProgress = 0;

    const interval = setInterval(() => {
      taskProgress += 2;
      setProgress(taskProgress);

      if (taskProgress % 20 === 0 && taskProgress < 100) {
        const taskNum = Math.floor(taskProgress / 20);
        setCurrentTask(taskNum);
        setStatusLog((prev) => [
          ...prev,
          `Processing task ${taskNum} of ${totalTasks}...`,
          `Stage: ${stages[stageIndex]}`,
        ]);
      }

      if (taskProgress % 25 === 0 && stageIndex < stages.length - 1) {
        stageIndex++;
        setStage(stages[stageIndex]);
      }

      // Update metrics progressively
      setMetrics({
        precisionAt5: {
          A: Math.min(0.82, (taskProgress / 100) * 0.82),
          B: Math.min(0.77, (taskProgress / 100) * 0.77),
          C: Math.min(0.85, (taskProgress / 100) * 0.85),
        },
        recallAt5: {
          A: Math.min(0.75, (taskProgress / 100) * 0.75),
          B: Math.min(0.71, (taskProgress / 100) * 0.71),
          C: Math.min(0.79, (taskProgress / 100) * 0.79),
        },
        latencyP95: {
          A: Math.min(3.4, (taskProgress / 100) * 3.4),
          B: Math.min(2.8, (taskProgress / 100) * 2.8),
          C: Math.min(4.1, (taskProgress / 100) * 4.1),
        },
        groundedness: {
          A: Math.min(0.91, (taskProgress / 100) * 0.91),
          B: Math.min(0.88, (taskProgress / 100) * 0.88),
          C: Math.min(0.93, (taskProgress / 100) * 0.93),
        },
        costPerQuery: {
          A: Math.min(0.006, (taskProgress / 100) * 0.006),
          B: Math.min(0.005, (taskProgress / 100) * 0.005),
          C: Math.min(0.009, (taskProgress / 100) * 0.009),
        },
        tokensUsed: {
          A: Math.min(1240, (taskProgress / 100) * 1240),
          B: Math.min(980, (taskProgress / 100) * 980),
          C: Math.min(1560, (taskProgress / 100) * 1560),
        },
      });

      if (taskProgress >= 100) {
        clearInterval(interval);
        setStatusLog((prev) => [...prev, 'Experiment complete!']);
      }
    }, 100);
  };

  const getStageColor = (s: Stage) => {
    const stages: Stage[] = ['embedding', 'retrieval', 'answering', 'judging', 'complete'];
    const currentIndex = stages.indexOf(stage);
    const stageIndex = stages.indexOf(s);

    if (stageIndex < currentIndex) return darkMode ? 'bg-green-500' : 'bg-green-600';
    if (stageIndex === currentIndex) return darkMode ? 'bg-blue-500' : 'bg-blue-600';
    return darkMode ? 'bg-zinc-700' : 'bg-zinc-300';
  };

  const getBestPipeline = (metric: keyof typeof metrics) => {
    const values = metrics[metric];
    const entries = Object.entries(values) as [string, number][];
    
    // For latency and cost, lower is better
    if (metric === 'latencyP95' || metric === 'costPerQuery') {
      return entries.reduce((min, curr) => (curr[1] < min[1] && curr[1] > 0 ? curr : min))[0];
    }
    
    // For other metrics, higher is better
    return entries.reduce((max, curr) => (curr[1] > max[1] ? curr : max))[0];
  };

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Experiment #12</h2>
            {stage !== 'idle' && (
              <p className={`${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                Started Today at 12:41 PM, 16 Oct 2025
              </p>
            )}
          </div>
          {stage === 'idle' && (
            <Button onClick={startExperiment} size="lg" className="gap-2">
              <Play size={20} />
              Start Experiment
            </Button>
          )}
        </div>

        {stage !== 'idle' && (
          <>
            {/* Progress Bar */}
            <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Experiment Progress</CardTitle>
                  <Badge variant={stage === 'complete' ? 'default' : 'secondary'}>
                    {stage === 'complete' ? 'Complete' : 'Running'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span>Overall Progress</span>
                    <span className="text-sm opacity-60">{Math.round(progress)}%</span>
                  </div>
                  <Progress value={progress} />
                </div>

                {/* Stage Indicators */}
                <div className="flex items-center gap-2">
                  {['embedding', 'retrieval', 'answering', 'judging', 'complete'].map((s, index) => (
                    <div key={s} className="flex items-center gap-2 flex-1">
                      <div
                        className={`h-2 flex-1 rounded ${getStageColor(s as Stage)}`}
                      />
                      {index < 4 && <div className="w-1 h-1 rounded-full bg-zinc-400" />}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="opacity-60">Current Stage:</span>
                  <span className="capitalize">{stage}</span>
                </div>

                {currentTask > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="opacity-60">Processing:</span>
                    <span>
                      Task {currentTask} of {totalTasks}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Metrics Comparison Sidebar */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-6">
                {/* Status Feed */}
                <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
                  <CardHeader>
                    <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Status Log</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div
                      className={`max-h-48 overflow-y-auto space-y-1 text-sm ${
                        darkMode ? 'text-zinc-400' : 'text-zinc-600'
                      }`}
                    >
                      {statusLog.map((log, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <span className="opacity-40">•</span>
                          <span>{log}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Metrics Comparison */}
                <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
                  <CardHeader>
                    <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Metrics Comparison</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      {/* Precision@5 */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <CheckCircle size={16} className="opacity-60" />
                            <span className={`text-sm ${darkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>Precision@5</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div className={`p-3 rounded ${darkMode ? 'bg-blue-500/10 border border-blue-500/20' : 'bg-blue-50 border border-blue-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline A</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.precisionAt5.A.toFixed(2)}</div>
                          </div>
                          <div className={`p-3 rounded ${darkMode ? 'bg-green-500/10 border border-green-500/20' : 'bg-green-50 border border-green-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline B</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.precisionAt5.B.toFixed(2)}</div>
                          </div>
                          <div className={`p-3 rounded ${darkMode ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline C</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.precisionAt5.C.toFixed(2)}</div>
                          </div>
                        </div>
                      </div>

                      {/* Recall@5 */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <CheckCircle size={16} className="opacity-60" />
                            <span className={`text-sm ${darkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>Recall@5</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div className={`p-3 rounded ${darkMode ? 'bg-blue-500/10 border border-blue-500/20' : 'bg-blue-50 border border-blue-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline A</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.recallAt5.A.toFixed(2)}</div>
                          </div>
                          <div className={`p-3 rounded ${darkMode ? 'bg-green-500/10 border border-green-500/20' : 'bg-green-50 border border-green-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline B</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.recallAt5.B.toFixed(2)}</div>
                          </div>
                          <div className={`p-3 rounded ${darkMode ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline C</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.recallAt5.C.toFixed(2)}</div>
                          </div>
                        </div>
                      </div>

                      {/* Groundedness */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <CheckCircle size={16} className="opacity-60" />
                            <span className={`text-sm ${darkMode ? 'text-zinc-300' : 'text-zinc-700'}`}>Groundedness</span>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div className={`p-3 rounded ${darkMode ? 'bg-blue-500/10 border border-blue-500/20' : 'bg-blue-50 border border-blue-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline A</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.groundedness.A.toFixed(2)}</div>
                          </div>
                          <div className={`p-3 rounded ${darkMode ? 'bg-green-500/10 border border-green-500/20' : 'bg-green-50 border border-green-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline B</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.groundedness.B.toFixed(2)}</div>
                          </div>
                          <div className={`p-3 rounded ${darkMode ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-amber-50 border border-amber-200'}`}>
                            <div className={`text-xs mb-1 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline C</div>
                            <div className={`text-lg ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>{metrics.groundedness.C.toFixed(2)}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Sidebar with key metrics */}
              <div className="space-y-4">
                <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
                  <CardHeader>
                    <CardTitle className={`text-sm ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>Average Latency</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline A</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>{metrics.latencyP95.A.toFixed(1)}s</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline B</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>{metrics.latencyP95.B.toFixed(1)}s</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline C</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>{metrics.latencyP95.C.toFixed(1)}s</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
                  <CardHeader>
                    <CardTitle className={`text-sm ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>Cost Per Query</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline A</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>${metrics.costPerQuery.A.toFixed(3)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline B</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>${metrics.costPerQuery.B.toFixed(3)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline C</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>${metrics.costPerQuery.C.toFixed(3)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
                  <CardHeader>
                    <CardTitle className={`text-sm ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>Tokens Used</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline A</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>{Math.round(metrics.tokensUsed.A)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline B</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>{Math.round(metrics.tokensUsed.B)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>Pipeline C</span>
                        <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>{Math.round(metrics.tokensUsed.C)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            {/* Comparison Summary Table */}
            {stage === 'complete' && (
              <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
                <CardHeader>
                  <CardTitle className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Comparison Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Metric</TableHead>
                        <TableHead>Pipeline A</TableHead>
                        <TableHead>Pipeline B</TableHead>
                        <TableHead>Pipeline C</TableHead>
                        <TableHead>Best</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell>Precision@5</TableCell>
                        <TableCell>{metrics.precisionAt5.A.toFixed(2)}</TableCell>
                        <TableCell>{metrics.precisionAt5.B.toFixed(2)}</TableCell>
                        <TableCell>{metrics.precisionAt5.C.toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge>{getBestPipeline('precisionAt5')}</Badge>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Latency p95 (s)</TableCell>
                        <TableCell>{metrics.latencyP95.A.toFixed(1)}</TableCell>
                        <TableCell>{metrics.latencyP95.B.toFixed(1)}</TableCell>
                        <TableCell>{metrics.latencyP95.C.toFixed(1)}</TableCell>
                        <TableCell>
                          <Badge>{getBestPipeline('latencyP95')}</Badge>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Groundedness</TableCell>
                        <TableCell>{metrics.groundedness.A.toFixed(2)}</TableCell>
                        <TableCell>{metrics.groundedness.B.toFixed(2)}</TableCell>
                        <TableCell>{metrics.groundedness.C.toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge>{getBestPipeline('groundedness')}</Badge>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>Cost ($/query)</TableCell>
                        <TableCell>${metrics.costPerQuery.A.toFixed(3)}</TableCell>
                        <TableCell>${metrics.costPerQuery.B.toFixed(3)}</TableCell>
                        <TableCell>${metrics.costPerQuery.C.toFixed(3)}</TableCell>
                        <TableCell>
                          <Badge>{getBestPipeline('costPerQuery')}</Badge>
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Bottom CTA */}
            {stage === 'complete' && (
              <div className="flex justify-end gap-3">
                <Button variant="outline" size="lg">
                  View Detailed Comparison
                </Button>
                <Button onClick={onNext} size="lg">
                  Generate Report →
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
