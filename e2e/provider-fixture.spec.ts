import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  assertAllFormControlsLabeled,
  expandEvidence,
  pipelineCard,
  startIsolatedStack,
  startOpenAIFixtureServer,
} from './helpers/stack';

test.describe('Local OpenAI-compatible provider fixture (answers, judges, spend) and cancelled runs', () => {
  test('executes full_rag with local fixture chat/judge endpoints, displays answer/judge evidence and exports, and handles cancelled runs', async ({
    page,
  }) => {
    const fixture = await startOpenAIFixtureServer();
    const priceSchedule = JSON.stringify({
      version: 'fixture-prices-v1',
      currency: 'USD',
      entries: [
        {
          model: 'fixture-local-chat',
          provider: 'openai-compatible',
          unit: 'per_1k_tokens',
          inputUsd: 0.001,
          outputUsd: 0.002,
        },
      ],
    });
    const stack = await startIsolatedStack({
      extraEnv: {
        LOCAL_CHAT_BASE_URL: fixture.baseURL,
        LOCAL_CHAT_MODEL: 'fixture-local-chat',
        LOCAL_JUDGE_MODEL: 'fixture-local-judge',
        LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT: 'true',
        PRICE_SCHEDULE_JSON: priceSchedule,
      },
    });

    const legacyRequests: string[] = [];
    page.on('request', (req) => {
      const pathname = new URL(req.url()).pathname;
      if (/^\/api\/(?!v1\/)/.test(pathname)) {
        legacyRequests.push(pathname);
      }
    });

    try {
      // 1. Confirm Settings & Documentation expose the local fixture profiles without leaking the baseURL
      await page.goto(`${stack.frontendUrl}/settings`);
      await expect(page.getByText('fixture-local-chat')).toBeVisible();
      await expect(page.getByText('fixture-local-judge')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(fixture.baseURL);

      // 2. Load sample dataset & create two keyword pipelines (topK=1 vs topK=5)
      await page.goto(`${stack.frontendUrl}/datasets`);
      await page.getByRole('button', { name: 'Load sample dataset' }).click();
      await expect(
        page.getByRole('heading', { name: 'RAG fundamentals', exact: true }),
      ).toBeVisible();

      await page.goto(`${stack.frontendUrl}/pipelines`);
      await page.getByRole('button', { name: 'Add pipeline' }).click();
      const baseCard = pipelineCard(page, 'Baseline configuration');
      await expect(baseCard).toBeVisible();
      await baseCard.getByLabel('Top-K results').fill('1');
      await baseCard.getByRole('button', { name: 'Save changes' }).click();
      await expect(baseCard.getByText('Revision 2')).toBeVisible();

      await baseCard
        .getByRole('button', { name: 'Duplicate pipeline' })
        .click();
      const copyCard = pipelineCard(page, 'Baseline configuration Copy');
      await expect(copyCard).toBeVisible();
      await copyCard.getByLabel('Pipeline name').fill('Expanded top-5 RAG');
      await copyCard.getByLabel('Top-K results').fill('5');
      await copyCard.getByRole('button', { name: 'Save changes' }).click();
      await expect(
        pipelineCard(page, 'Expanded top-5 RAG').getByText('Revision 2'),
      ).toBeVisible();

      // 3. Submit full_rag experiment with structured judge rubrics enabled
      await page.goto(`${stack.frontendUrl}/experiments`);
      await page.getByLabel('Execution mode').selectOption('full_rag');
      const judgeCheckbox = page.getByRole('checkbox', {
        name: /Run structured LLM-judge rubrics/,
      });
      await expect(judgeCheckbox).toBeChecked();
      await assertAllFormControlsLabeled(page, '/experiments (full_rag)');

      await page
        .getByLabel('Run name (optional)')
        .fill('Fixture Full RAG Evaluation');
      await page.getByRole('button', { name: 'Start Run' }).click();

      await expect(
        page
          .locator('[data-slot="card"]')
          .filter({ hasText: 'Experiment Progress' })
          .getByText('succeeded', { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      expect(fixture.getCallCount()).toBeGreaterThan(10);

      // 4. Open saved report from History and verify answer, citations, abstention, judge verdicts, and spend
      await page.goto(`${stack.frontendUrl}/history`);
      await page
        .getByRole('link', { name: 'Fixture Full RAG Evaluation' })
        .click();
      await expect(page).toHaveURL(/\/reports\/[a-f0-9-]+$/);

      await expect(
        page.getByText('Faithfulness / groundedness').first(),
      ).toBeVisible();
      await expect(
        page.getByText('Judged passage usefulness').first(),
      ).toBeVisible();
      await expect(page.getByText('Answer correctness').first()).toBeVisible();
      await expect(
        page.getByText('Abstention accuracy (unanswerable)').first(),
      ).toBeVisible();

      // Inspect the unanswerable task -> should display Abstained badge
      const unanswerableArticle = page
        .locator('article')
        .filter({ hasText: /What numeric chunk size is recommended/ });
      const unansBtn = unanswerableArticle.getByRole('button', {
        name: /Inspect evidence|Hide evidence/,
      });
      await expandEvidence(unansBtn);
      await expect(
        unanswerableArticle.getByText('Abstained').first(),
      ).toBeVisible();

      // Inspect multi-doc task -> should display validated citations and judge audit trail
      const multiDocArticle = page
        .locator('article')
        .filter({ hasText: /Which model balances cost and performance/ });
      const multiBtn = multiDocArticle.getByRole('button', {
        name: /Inspect evidence|Hide evidence/,
      });
      await expandEvidence(multiBtn);
      await expect(
        multiDocArticle.getByText(/validated citation/).first(),
      ).toBeVisible();
      await expect(
        multiDocArticle.getByText(/Judge evidence & audit trail/).first(),
      ).toBeVisible();
      await expect(
        multiDocArticle.getByText(/answer-correctness-v1/).first(),
      ).toBeVisible();

      // Export Markdown and verify answer/judge evidence & unknown judge spend are included
      const [mdDownload] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: 'Export Markdown' }).click(),
      ]);
      const mdPath = await mdDownload.path();
      const mdText = readFileSync(mdPath as string, 'utf8');
      expect(mdText).toContain('Fixture Full RAG Evaluation');
      expect(mdText).toContain('Validated citations:');
      expect(mdText).toContain('Judge audit trail:');
      expect(mdText).toContain('Unknown (');

      // 5. Cancelled run path: slow down the fixture server, start a run, cancel it, reload, and inspect from History & Reports
      fixture.setDelayMs(800);
      await page.goto(`${stack.frontendUrl}/experiments`);
      await page.getByLabel('Execution mode').selectOption('full_rag');
      await page
        .getByLabel('Run name (optional)')
        .fill('Cancelled Fixture Run');
      await page.getByRole('button', { name: 'Start Run' }).click();

      const cancelBtn = page.getByRole('button', { name: 'Cancel run' });
      await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
      await cancelBtn.click();

      await expect(
        page
          .locator('[data-slot="card"]')
          .filter({ hasText: 'Experiment Progress' })
          .getByText('cancelled', { exact: true }),
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        page.getByRole('button', { name: 'Retry run' }),
      ).toBeVisible();

      // Reload confirms cancelled state is persisted
      await page.reload();
      await expect(
        page
          .locator('[data-slot="card"]')
          .filter({ hasText: 'Experiment Progress' })
          .getByText('cancelled', { exact: true }),
      ).toBeVisible();

      // Open cancelled run from History into Reports
      await page.goto(`${stack.frontendUrl}/history`);
      const cancelledLink = page.getByRole('link', {
        name: 'Cancelled Fixture Run',
      });
      await expect(cancelledLink).toBeVisible();
      await cancelledLink.click();
      await expect(page.getByText('Run status: cancelled.')).toBeVisible();

      expect(legacyRequests).toEqual([]);
    } finally {
      await stack.stop();
      await fixture.close();
    }
  });
});
