import { Clock, ChevronRight, Download, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';

interface HistoryPageProps {
  darkMode: boolean;
  onViewReport: (id: number) => void;
}

export function HistoryPage({ darkMode, onViewReport }: HistoryPageProps) {
  const experiments = [
    {
      id: 12,
      name: 'Experiment #12',
      date: 'Today at 12:41 PM',
      status: 'Complete',
      datasets: 3,
      pipelines: 3,
      bestPipeline: 'B',
      score: 0.91,
    },
    {
      id: 11,
      name: 'Experiment #11',
      date: 'Yesterday at 3:22 PM',
      status: 'Complete',
      datasets: 2,
      pipelines: 2,
      bestPipeline: 'A',
      score: 0.87,
    },
    {
      id: 10,
      name: 'Experiment #10',
      date: 'Oct 14 at 9:15 AM',
      status: 'Complete',
      datasets: 5,
      pipelines: 4,
      bestPipeline: 'C',
      score: 0.93,
    },
    {
      id: 9,
      name: 'Experiment #9',
      date: 'Oct 13 at 2:30 PM',
      status: 'Failed',
      datasets: 3,
      pipelines: 2,
      bestPipeline: '-',
      score: 0,
    },
    {
      id: 8,
      name: 'Experiment #8',
      date: 'Oct 12 at 11:45 AM',
      status: 'Complete',
      datasets: 4,
      pipelines: 3,
      bestPipeline: 'B',
      score: 0.89,
    },
  ];

  return (
    <div className={`p-8 ${darkMode ? 'bg-zinc-900' : 'bg-zinc-50'}`}>
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>Experiment History</h2>
          <p className={`${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
            View and manage your past experiments
          </p>
        </div>

        {/* Experiments List */}
        <div className="space-y-3">
          {experiments.map((experiment) => (
            <Card
              key={experiment.id}
              className={`${darkMode ? 'bg-zinc-800 border-zinc-700' : ''} hover:shadow-md transition-shadow`}
            >
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-start gap-4 flex-1">
                    <div className={`p-3 rounded-lg ${darkMode ? 'bg-zinc-900' : 'bg-zinc-100'}`}>
                      <Clock size={24} className="opacity-60" />
                    </div>
                    
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
                          {experiment.name}
                        </h3>
                        <Badge
                          variant={experiment.status === 'Complete' ? 'default' : 'destructive'}
                        >
                          {experiment.status}
                        </Badge>
                      </div>
                      
                      <p className={`text-sm mb-3 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        {experiment.date}
                      </p>
                      
                      <div className="flex items-center gap-6 text-sm">
                        <div>
                          <span className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                            Datasets:{' '}
                          </span>
                          <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
                            {experiment.datasets}
                          </span>
                        </div>
                        <div>
                          <span className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                            Pipelines:{' '}
                          </span>
                          <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
                            {experiment.pipelines}
                          </span>
                        </div>
                        {experiment.status === 'Complete' && (
                          <>
                            <div>
                              <span className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                                Best:{' '}
                              </span>
                              <span className={darkMode ? 'text-zinc-100' : 'text-zinc-900'}>
                                Pipeline {experiment.bestPipeline}
                              </span>
                            </div>
                            <div>
                              <span className={darkMode ? 'text-zinc-400' : 'text-zinc-600'}>
                                Score:{' '}
                              </span>
                              <span className={darkMode ? 'text-green-400' : 'text-green-600'}>
                                {experiment.score.toFixed(2)}
                              </span>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {experiment.status === 'Complete' && (
                      <>
                        <Button variant="ghost" size="sm">
                          <Download size={16} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onViewReport(experiment.id)}
                        >
                          View Report
                          <ChevronRight size={16} className="ml-1" />
                        </Button>
                      </>
                    )}
                    <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-600">
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Empty State for no experiments */}
        {experiments.length === 0 && (
          <Card className={darkMode ? 'bg-zinc-800 border-zinc-700' : ''}>
            <CardContent className="py-12 text-center">
              <Clock size={48} className="mx-auto mb-4 opacity-40" />
              <h3 className={`mb-2 ${darkMode ? 'text-zinc-100' : 'text-zinc-900'}`}>
                No experiments yet
              </h3>
              <p className={`mb-4 ${darkMode ? 'text-zinc-400' : 'text-zinc-600'}`}>
                Start by uploading documents and creating your first pipeline
              </p>
              <Button>Get Started</Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
