import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { createRoutes } from './App';
import './index.css';
import { DatasetProvider } from './state/dataset';
import { ExperimentResultsProvider } from './state/experimentResults';
import { PipelineProvider } from './state/pipelines';

const router = createBrowserRouter(createRoutes());
const queryClient = new QueryClient();
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <PipelineProvider>
      <DatasetProvider>
        <ExperimentResultsProvider>
          <RouterProvider router={router} />
        </ExperimentResultsProvider>
      </DatasetProvider>
    </PipelineProvider>
  </QueryClientProvider>,
);
