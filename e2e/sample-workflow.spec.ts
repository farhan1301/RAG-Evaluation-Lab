import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  assertAllFormControlsLabeled,
  expandEvidence,
  pipelineCard,
} from './helpers/stack';

test.describe('Offline zero-API-key workflow, accessibility, layout, dark mode, and print', () => {
  test('empty, loading, error states, keyboard navigation, narrow layout, dark mode, and derived documentation', async ({
    page,
  }) => {
    const legacyRequests: string[] = [];
    page.on('request', (req) => {
      const pathname = new URL(req.url()).pathname;
      if (/^\/api\/(?!v1\/)/.test(pathname)) {
        legacyRequests.push(pathname);
      }
    });

    // 1. Empty states on fresh throwaway database
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Compare retrieval pipelines' }),
    ).toBeVisible();

    await page.goto('/datasets');
    await expect(
      page.getByText(
        'Create a dataset or load the labeled RAG fundamentals sample.',
      ),
    ).toBeVisible();

    await page.goto('/pipelines');
    await expect(
      page.getByText(
        'Create a pipeline to configure retrieval and generation.',
      ),
    ).toBeVisible();

    await page.goto('/experiments');
    await expect(page.getByText('Not Started')).toBeVisible();

    await page.goto('/reports');
    await expect(
      page.getByRole('heading', { name: 'No experiment results yet' }),
    ).toBeVisible();

    await page.goto('/reports/00000000-0000-4000-8000-000000000000');
    await expect(
      page.getByRole('heading', { name: 'Report unavailable' }),
    ).toBeVisible();

    await page.goto('/history');
    await expect(
      page.getByRole('heading', { name: 'No experiments yet' }),
    ).toBeVisible();

    // 2. Loading and error states on History via controlled route interception
    let interceptedAttempts = 0;
    await page.route('**/api/v1/runs*', async (route) => {
      interceptedAttempts += 1;
      if (interceptedAttempts === 1) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'internal_error',
            message: 'Simulated history failure.',
            requestId: 'req-e2e-err',
          },
        }),
      });
    });
    await page.goto('/history');
    await expect(page.getByRole('status')).toContainText('Loading saved runs');
    await expect(page.getByRole('alert')).toContainText(
      'Simulated history failure.',
      { timeout: 20_000 },
    );
    await page.unroute('**/api/v1/runs*');

    // 3. Derived Documentation page from /api/v1/documentation
    await page.goto('/docs');
    await expect(
      page.getByRole('heading', { name: 'Documentation' }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Configuration' }).click();
    await expect(page.getByText('Worker: online')).toBeVisible();
    await page.getByRole('tab', { name: 'Metrics & Rubrics' }).click();
    await expect(page.getByText('nDCG@k')).toBeVisible();
    await expect(page.getByText('Faithfulness / groundedness')).toBeVisible();
    await expect(page.getByText(/sha256:/)).toHaveCount(5);
    await expect(page.locator('body')).not.toContainText('Cohere API Key');

    // 4. Keyboard navigation: skip link + tab focus
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();

    // 5. Dark mode preference & persistence + live server capabilities in Settings
    await page.goto('/settings');
    await assertAllFormControlsLabeled(page, '/settings');
    await expect(page.getByText('Server provider capabilities')).toBeVisible();
    await expect(page.getByText('Worker: online')).toBeVisible();
    const darkRadio = page.getByRole('radio', { name: 'dark' });
    await darkRadio.check();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        ),
      )
      .toBe(true);
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        ),
      )
      .toBe(true);
    await page.getByRole('radio', { name: 'light' }).check();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        ),
      )
      .toBe(false);

    // 6. Narrow mobile viewport navigation & Escape key focus restoration
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const menuBtn = page.getByRole('button', { name: 'Menu' });
    await expect(menuBtn).toBeVisible();
    await menuBtn.focus();
    await page.keyboard.press('Enter');
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Datasets & Tasks' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(menuBtn).toBeFocused();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 2,
    );
    expect(overflow).toBe(true);
    await page.setViewportSize({ width: 1280, height: 800 });

    expect(legacyRequests).toEqual([]);
  });

  test('loads sample, duplicates baseline, changes retrieval settings, runs both, reloads, opens from History, inspects differing task, exports MD/JSON, and prints multipage PDF', async ({
    page,
  }) => {
    const legacyRequests: string[] = [];
    page.on('request', (req) => {
      const pathname = new URL(req.url()).pathname;
      if (/^\/api\/(?!v1\/)/.test(pathname)) {
        legacyRequests.push(pathname);
      }
    });

    // 1. Load sample dataset
    await page.goto('/datasets');
    await page.getByRole('button', { name: 'Load sample dataset' }).click();
    await expect(
      page.getByRole('heading', { name: 'RAG fundamentals', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Remove RAG_Best_Practices.txt' }),
    ).toBeVisible();
    await assertAllFormControlsLabeled(page, '/datasets');

    // 2. Create baseline pipeline (topK = 1), duplicate it, and change duplicate to topK = 5
    await page.goto('/pipelines');
    await page.getByRole('button', { name: 'Add pipeline' }).click();
    const baselineCard = pipelineCard(page, 'Baseline configuration');
    await expect(baselineCard).toBeVisible();

    // Verify Pipelines reranker checkbox has an explicit accessible name (not "on")
    const rerankerCheckbox = baselineCard.getByRole('checkbox', {
      name: /Enable HTTP reranker/,
    });
    await expect(rerankerCheckbox).toBeVisible();
    await assertAllFormControlsLabeled(page, '/pipelines');

    await baselineCard.getByLabel('Top-K results').fill('1');
    await baselineCard.getByRole('button', { name: 'Save changes' }).click();
    await expect(baselineCard.getByText('Revision 2')).toBeVisible();

    await baselineCard
      .getByRole('button', { name: 'Duplicate pipeline' })
      .click();
    const copyCard = pipelineCard(page, 'Baseline configuration Copy');
    await expect(copyCard).toBeVisible();
    await copyCard.getByLabel('Pipeline name').fill('Higher top-K retrieval');
    await copyCard.getByLabel('Top-K results').fill('5');
    await copyCard.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      pipelineCard(page, 'Higher top-K retrieval').getByText('Revision 2'),
    ).toBeVisible();

    // 3. Run both pipelines on Experiments page
    await page.goto('/experiments');
    // Explicitly assert both pipeline-selection checkboxes have readable accessible names
    await expect(
      page.getByRole('checkbox', { name: /Baseline configuration/ }),
    ).toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: /Higher top-K retrieval/ }),
    ).toBeChecked();
    await assertAllFormControlsLabeled(page, '/experiments');

    await page
      .getByLabel('Run name (optional)')
      .fill('Sample Top-K Comparison');
    await page.getByRole('button', { name: 'Start Run' }).click();

    await expect(
      page
        .locator('[data-slot="card"]')
        .filter({ hasText: 'Experiment Progress' })
        .getByText('succeeded', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    // 4. Reload browser and confirm persisted state survives reload
    await page.reload();
    await expect(page.getByText('Sample Top-K Comparison')).toBeVisible();
    await expect(
      page
        .locator('[data-slot="card"]')
        .filter({ hasText: 'Experiment Progress' })
        .getByText('succeeded', { exact: true }),
    ).toBeVisible();

    // 5. Open the same run from History
    await page.goto('/history');
    await assertAllFormControlsLabeled(page, '/history');
    await page.getByRole('link', { name: 'Sample Top-K Comparison' }).click();
    await expect(page).toHaveURL(/\/reports\/[a-f0-9-]+$/);
    await expect(
      page.getByRole('heading', { name: 'Sample Top-K Comparison' }),
    ).toBeVisible();
    await assertAllFormControlsLabeled(page, '/reports');

    // 6. Verify paired comparison, config diff, bootstrap CI, and differing task evidence
    await expect(page.getByText('Configuration Diff')).toBeVisible();
    await expect(page.getByText('config.retriever.topK')).toBeVisible();
    await expect(page.getByText('Paired Metric Deltas')).toBeVisible();
    await expect(page.getByText(/Resampling rule:/)).toBeVisible();
    await expect(page.getByText('9 / 1').first()).toBeVisible();

    const differingToggle = page.getByRole('checkbox', {
      name: /Show differing tasks only/,
    });
    await differingToggle.check();
    await expect(page.getByText('Differs').first()).toBeVisible();
    await expect(
      page.getByText(/Which model balances cost and performance/),
    ).toBeVisible();

    // Ensure the differing multi-doc task is expanded and displays side-by-side passages
    const multiDocArticle = page
      .locator('article')
      .filter({ hasText: /Which model balances cost and performance/ });
    const inspectBtn = multiDocArticle.getByRole('button', {
      name: /Inspect evidence|Hide evidence/,
    });
    await expandEvidence(inspectBtn);
    await expect(
      multiDocArticle.getByText('Baseline: Baseline configuration'),
    ).toBeVisible();
    await expect(
      multiDocArticle.getByText('Candidate: Higher top-K retrieval'),
    ).toBeVisible();
    await expect(
      multiDocArticle.getByText(/Gold grade 3/).first(),
    ).toBeVisible();

    // 7. Export Markdown and JSON via server /api/v1/runs/:id/export
    const [mdDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Markdown' }).click(),
    ]);
    expect(mdDownload.suggestedFilename()).toMatch(/\.md$/);
    const mdPath = await mdDownload.path();
    expect(mdPath).toBeTruthy();
    const mdText = readFileSync(mdPath as string, 'utf8');
    expect(mdText).toContain('# Sample Top-K Comparison');
    expect(mdText).toContain('Paired Metric Deltas');
    expect(mdText).toContain('config.retriever.topK');
    expect(mdText).toContain('[Differs]');

    const [jsonDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON' }).click(),
    ]);
    expect(jsonDownload.suggestedFilename()).toMatch(/\.json$/);
    const jsonPath = await jsonDownload.path();
    expect(jsonPath).toBeTruthy();
    const jsonExport = JSON.parse(readFileSync(jsonPath as string, 'utf8'));
    expect(jsonExport.schemaVersion).toBe(1);
    expect(jsonExport.run.name).toBe('Sample Top-K Comparison');
    expect(jsonExport.comparisons).toHaveLength(1);
    expect(jsonExport.tasks).toHaveLength(20);

    // 8. Multipage print output (also proving print CSS overrides dark mode cleanly)
    await differingToggle.uncheck();
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await page.emulateMedia({ media: 'print' });
    const headerDisplay = await page
      .locator('header')
      .evaluate((el) => getComputedStyle(el).display);
    expect(headerDisplay).toBe('none');
    const bodyBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    expect(bodyBg).toBe('rgb(255, 255, 255)');

    const pdfBytes = await page.pdf({
      format: 'Letter',
      printBackground: true,
    });
    const pdfLatin = pdfBytes.toString('latin1');
    expect(pdfLatin.startsWith('%PDF-')).toBe(true);
    const pageCount = (pdfLatin.match(/\/Type\s*\/Page\b/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(2);

    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );

    expect(legacyRequests).toEqual([]);
  });
});
