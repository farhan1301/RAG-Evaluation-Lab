import { useState } from 'react';
import { HomePage } from './components/HomePage';
import { DatasetsPage } from './components/DatasetsPage';
import { PipelinesPage } from './components/PipelinesPage';
import { ExperimentsPage } from './components/ExperimentsPage';
import { ReportsPage } from './components/ReportsPage';
import { HistoryPage } from './components/HistoryPage';
import { SettingsPage } from './components/SettingsPage';
import { FlaskConical, Database, Zap, FileText, Settings, Clock, Moon, Sun, Home } from 'lucide-react';
import { Button } from './components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';

type Page = 'home' | 'datasets' | 'pipelines' | 'experiments' | 'reports' | 'history' | 'settings';

export default function App() {
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [darkMode, setDarkMode] = useState(false);

  const navItems = [
    { id: 'home' as Page, label: 'Home', icon: Home },
    { id: 'datasets' as Page, label: 'Datasets & Tasks', icon: Database },
    { id: 'pipelines' as Page, label: 'Pipelines', icon: FlaskConical },
    { id: 'experiments' as Page, label: 'Experiments', icon: Zap },
    { id: 'reports' as Page, label: 'Reports', icon: FileText },
  ];

  return (
    <div className={`min-h-screen ${darkMode ? 'bg-zinc-900 text-zinc-100' : 'bg-zinc-50 text-zinc-900'}`}>
      {/* Top Bar */}
      <div className={`border-b ${darkMode ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-white'}`}>
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <FlaskConical className={darkMode ? 'text-blue-400' : 'text-blue-600'} size={24} />
            <div>
              <h1 className="tracking-tight">RAG Evaluation Lab</h1>
              <p className={`text-sm ${darkMode ? 'text-zinc-500' : 'text-zinc-500'}`}>
                Build, test, and compare retrieval pipelines
              </p>
            </div>
          </div>

          {/* Utility Bar */}
          <div className="flex items-center gap-4">
            {/* Experiment History */}
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setCurrentPage('history')}
            >
              <Clock size={16} />
              History
            </Button>

            {/* Settings */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage('settings')}
            >
              <Settings size={16} />
            </Button>

            {/* Theme Toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDarkMode(!darkMode)}
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex">
        {/* Left Sidebar Navigation */}
        <div className={`w-64 min-h-[calc(100vh-73px)] border-r ${darkMode ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-white'}`}>
          <nav className="p-4 space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = currentPage === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setCurrentPage(item.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${
                    isActive
                      ? darkMode
                        ? 'bg-blue-500/10 text-blue-400'
                        : 'bg-blue-50 text-blue-600'
                      : darkMode
                      ? 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
                      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                  }`}
                >
                  <Icon size={20} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Flow Indicator */}
          <div className={`mx-4 mt-6 p-4 rounded-lg border ${darkMode ? 'border-zinc-800 bg-zinc-800/50' : 'border-zinc-200 bg-zinc-50'}`}>
            <h3 className="text-sm mb-3 opacity-60">Workflow</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${darkMode ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>1</div>
                <span>Upload</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${darkMode ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>2</div>
                <span>Configure</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${darkMode ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>3</div>
                <span>Run</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${darkMode ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>4</div>
                <span>Compare</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${darkMode ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>5</div>
                <span>Report</span>
              </div>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1">
          {currentPage === 'home' && <HomePage darkMode={darkMode} onNavigate={(page) => setCurrentPage(page as Page)} />}
          {currentPage === 'datasets' && <DatasetsPage darkMode={darkMode} onNext={() => setCurrentPage('pipelines')} />}
          {currentPage === 'pipelines' && <PipelinesPage darkMode={darkMode} onNext={() => setCurrentPage('experiments')} />}
          {currentPage === 'experiments' && <ExperimentsPage darkMode={darkMode} onNext={() => setCurrentPage('reports')} />}
          {currentPage === 'reports' && <ReportsPage darkMode={darkMode} />}
          {currentPage === 'history' && <HistoryPage darkMode={darkMode} onViewReport={(id) => setCurrentPage('reports')} />}
          {currentPage === 'settings' && <SettingsPage darkMode={darkMode} />}
        </div>
      </div>
    </div>
  );
}
