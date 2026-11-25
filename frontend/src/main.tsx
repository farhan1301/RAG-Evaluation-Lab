import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { createRoutes } from './App';
import './index.css';
import { ExperimentResultsProvider } from './state/experimentResults';

const router = createBrowserRouter(createRoutes());
const queryClient = new QueryClient();
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <ExperimentResultsProvider>
      <RouterProvider router={router} />
    </ExperimentResultsProvider>
  </QueryClientProvider>,
);
