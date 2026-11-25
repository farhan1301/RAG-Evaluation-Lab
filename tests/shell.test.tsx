import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { createRoutes } from '../frontend/src/App';
import { ExperimentResultsProvider } from '../frontend/src/state/experimentResults';

async function openPage(path: string) {
  const router = createMemoryRouter(createRoutes(), { initialEntries: [path] });
  if (!router.state.initialized) {
    await new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe(({ initialized }) => {
        if (initialized) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  return router;
}

function markup(router: ReturnType<typeof createMemoryRouter>) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ExperimentResultsProvider>
        <RouterProvider router={router} />
      </ExperimentResultsProvider>
    </QueryClientProvider>,
  );
}

describe('application shell', () => {
  it.each([
    ['/', 'Compare retrieval pipelines', '/'],
    ['/datasets', 'Load sample dataset', '/datasets'],
    ['/pipelines', 'Pipeline Configuration', '/pipelines'],
    ['/experiments', 'Experiment Progress', '/experiments'],
    ['/reports', 'No experiment results yet', '/reports'],
    ['/reports/missing-run', 'Report unavailable', '/reports'],
    ['/history', 'No experiments yet', '/history'],
    ['/docs', 'Documentation sections', '/docs'],
    ['/settings', 'Appearance', '/settings'],
  ])('opens %s from a fresh session', async (path, content, activeLink) => {
    const router = await openPage(path);
    try {
      const html = markup(router);
      expect(html).toContain(content);
      expect(html).toContain('href="#main"');
      expect(html).toContain('aria-controls="navigation"');
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0]).toContain(
        `href="${activeLink}"`,
      );
    } finally {
      router.dispose();
    }
  });

  it('restores the previous route on back and keeps the URL on a fresh visit', async () => {
    const router = await openPage('/settings');
    await router.navigate('/history');
    expect(markup(router)).toContain('No experiments yet');
    await router.navigate(-1);
    expect(router.state.location.pathname).toBe('/settings');
    expect(markup(router)).toContain('Appearance');
    const fresh = await openPage(router.state.location.pathname);
    expect(markup(fresh)).toContain('Appearance');
    fresh.dispose();
    router.dispose();
  });

  it('keeps report detail and overview distinct across history navigation', async () => {
    const router = await openPage('/reports');
    await router.navigate('/reports/previous-run');
    expect(markup(router)).toContain('Report unavailable');
    await router.navigate(-1);
    expect(markup(router)).toContain('No experiment results yet');
    await router.navigate(1);
    expect(markup(router)).toContain('Report unavailable');
    router.dispose();
  });

  it('gives unknown URLs a route back home', async () => {
    const router = await openPage('/unknown');
    expect(markup(router)).toContain('Return home');
    router.dispose();
  });
});
