import { expect, test } from '@playwright/test';
import {
  assertAllFormControlsLabeled,
  cardByTitle,
  startIsolatedStack,
  startOpenAIFixtureServer,
} from './helpers/stack';

test.describe('Phase 9: synthetic test-set generation, human review, leakage flagging, promotion, and cancellation', () => {
  test('generates draft proposals from frozen revision, flags verbatim leakage, edits/accepts/rejects, promotes into new revision, and cancels an in-flight batch', async ({
    page,
  }) => {
    const fixture = await startOpenAIFixtureServer();
    const stack = await startIsolatedStack({
      extraEnv: {
        LOCAL_CHAT_BASE_URL: fixture.baseURL,
        LOCAL_CHAT_MODEL: 'fixture-local-chat',
        LOCAL_CHAT_SUPPORTS_STRUCTURED_OUTPUT: 'true',
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
      // 1. Load the sample dataset on /datasets and confirm generation panel & data-transfer notice
      await page.goto(`${stack.frontendUrl}/datasets`);
      await page.getByRole('button', { name: 'Load sample dataset' }).click();
      const datasetSummary = cardByTitle(page, 'RAG fundamentals');
      await expect(datasetSummary).toBeVisible();
      await expect(
        datasetSummary.getByText('Revision 1', { exact: true }),
      ).toBeVisible();

      const genCard = cardByTitle(page, 'Generate questions');
      await expect(genCard).toBeVisible();
      const transferNotice = genCard.locator('p', {
        hasText: 'Data leaving this installation:',
      });
      await expect(transferNotice).toBeVisible();
      await expect(
        transferNotice.getByText('fixture-local-chat', { exact: true }),
      ).toBeVisible();
      await assertAllFormControlsLabeled(page, '/datasets (before generation)');

      // 2. Start generation from frozen revision 1 and wait for worker completion
      await genCard.getByRole('button', { name: 'Start generation' }).click();
      await expect(genCard.getByText('succeeded', { exact: true })).toBeVisible(
        { timeout: 30_000 },
      );
      expect(fixture.getCallCount()).toBe(3);

      // Drafts must stay outside the scored dataset (still Revision 1!)
      await expect(
        datasetSummary.getByText('Revision 1', { exact: true }),
      ).toBeVisible();

      // 3. Verify review table shows clean, unanswerable, and leakage-flagged drafts with spans & provenance
      const cleanRow = genCard.locator('tbody tr').filter({
        hasText:
          'What chunking parameters should teams tune in a RAG workflow?',
      });
      await expect(cleanRow).toBeVisible();
      await expect(cleanRow.getByText(/Clear \(/)).toBeVisible();
      // Validated source span and graded qrel for the gold document
      await expect(
        cleanRow.getByText(/^RAG_Best_Practices\.txt \[\d+–\d+\]$/),
      ).toBeVisible();
      await expect(
        cleanRow.getByText(/^RAG_Best_Practices\.txt: grade \d$/),
      ).toBeVisible();
      await expect(cleanRow.getByText(/synthetic-qa-v1/)).toBeVisible();

      const leakedRowByText = genCard.locator('tbody tr').filter({
        hasText: 'How should teams keep RAG vector representations current?',
      });
      await expect(leakedRowByText).toBeVisible();
      // Pin the row by proposal id: while editing, its question moves into a
      // textarea and no longer matches a text filter.
      const leakedId = await leakedRowByText.getAttribute('data-proposal-id');
      expect(leakedId).toBeTruthy();
      const leakedRow = genCard.locator(
        `tbody tr[data-proposal-id="${leakedId}"]`,
      );
      await expect(leakedRow.getByText(/Leakage flagged/)).toBeVisible();

      const unansRow = genCard.locator('tbody tr').filter({
        hasText:
          'Which monthly pricing tier is recommended for vector databases?',
      });
      await expect(unansRow).toBeVisible();
      await expect(unansRow.getByText('Unanswerable')).toBeVisible();

      // 4. Accept clean row, reject unanswerable row, and test editing the leakage-flagged row
      await cleanRow.getByRole('button', { name: 'Accept' }).click();
      await expect(
        cleanRow.getByText('accepted', { exact: true }),
      ).toBeVisible();

      await unansRow.getByRole('button', { name: 'Reject' }).click();
      await expect(
        unansRow.getByText('rejected', { exact: true }),
      ).toBeVisible();

      // Accept the leakage-flagged row -> warning explains it is blocked until edited
      await leakedRow.getByRole('button', { name: 'Accept' }).click();
      await expect(
        genCard.getByText(/flagged for near-verbatim reference answer leakage/),
      ).toBeVisible();
      // Only 1 promotable item so far (the clean row)
      await expect(
        genCard.getByRole('button', {
          name: 'Promote accepted (1) to revision 2',
        }),
      ).toBeVisible();

      // Edit the leaked row to paraphrase its reference answer -> leakage clears!
      await leakedRow.getByRole('button', { name: 'Edit' }).click();
      await assertAllFormControlsLabeled(page, '/datasets (editing proposal)');
      await leakedRow
        .getByLabel('Expected answer')
        .fill(
          'Teams should refresh vector embeddings whenever source content changes.',
        );
      await leakedRow.getByRole('button', { name: 'Save edits' }).click();
      await expect(leakedRow.getByText(/Clear \(/)).toBeVisible();
      await expect(
        leakedRow.getByText('edited', { exact: true }),
      ).toBeVisible();

      // Now both accepted items (2) are promotable into Revision 2
      const promoteBtn = genCard.getByRole('button', {
        name: 'Promote accepted (2) to revision 2',
      });
      await expect(promoteBtn).toBeVisible();
      await promoteBtn.click();

      // 5. Verify dataset advanced to Revision 2 with promoted tasks, while Revision 1 is untouched
      await expect(
        datasetSummary.getByText('Revision 2', { exact: true }),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        genCard.getByText('Promoted 2 accepted proposals into revision 2.'),
      ).toBeVisible();
      await expect(
        page.locator('details summary', {
          hasText:
            'What chunking parameters should teams tune in a RAG workflow?',
        }),
      ).toBeVisible();

      // Verify Revision 1 via API still has exactly the 10 original tasks
      const datasetsRes = await page.request.get(
        `${stack.backendUrl}/api/v1/datasets`,
      );
      const datasetId = (
        (await datasetsRes.json()) as { items: Array<{ id: string }> }
      ).items[0].id;
      const rev1Res = await page.request.get(
        `${stack.backendUrl}/api/v1/datasets/${datasetId}/revisions/1`,
      );
      const rev1 = (await rev1Res.json()) as { tasks: unknown[] };
      expect(rev1.tasks).toHaveLength(10);

      // 6. Cancellation path: slow down fixture, start generation, click Cancel generation
      fixture.setDelayMs(900);
      await genCard.getByRole('button', { name: 'Start generation' }).click();
      const cancelBtn = genCard.getByRole('button', {
        name: 'Cancel generation',
      });
      await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
      await cancelBtn.click();
      await expect(genCard.getByText('cancelled', { exact: true })).toBeVisible(
        { timeout: 20_000 },
      );

      expect(legacyRequests).toEqual([]);
    } finally {
      await stack.stop();
      await fixture.close();
    }
  });
});
