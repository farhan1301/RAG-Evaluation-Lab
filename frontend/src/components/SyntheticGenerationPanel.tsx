import * as c from '@rag-eval/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { listKey, request, useCapabilities } from '../data/workspace';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { Textarea } from './ui/textarea';

type FilterStatus = 'all' | c.ProposalReviewStatus;

const ACTIVE_STATES = new Set<c.JobState>([
  'queued',
  'running',
  'cancellation_requested',
]);

interface EditDraft {
  question: string;
  expectedAnswer: string;
  acceptanceRule: string;
  factsText: string;
  answerable: boolean;
}

function ProposalRow({
  dataset,
  proposal,
  busy,
  onReview,
}: {
  dataset: c.Dataset;
  proposal: c.SyntheticProposal;
  busy: boolean;
  onReview: (
    proposalId: string,
    patch: c.ReviewProposalPatch,
    onDone?: () => void,
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditDraft>({
    question: proposal.question,
    expectedAnswer: proposal.expectedAnswer,
    acceptanceRule: proposal.acceptanceRule,
    factsText: proposal.referenceFacts.join('\n'),
    answerable: proposal.answerable,
  });

  const isPromoted = proposal.reviewStatus === 'promoted';
  const docNameById = new Map(dataset.documents.map((d) => [d.id, d.name]));

  function startEdit() {
    setDraft({
      question: proposal.question,
      expectedAnswer: proposal.expectedAnswer,
      acceptanceRule: proposal.acceptanceRule,
      factsText: proposal.referenceFacts.join('\n'),
      answerable: proposal.answerable,
    });
    setEditing(true);
  }

  function saveEdit() {
    const facts = draft.factsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    onReview(
      proposal.id,
      {
        question: draft.question,
        expectedAnswer: draft.expectedAnswer,
        acceptanceRule: draft.acceptanceRule,
        referenceFacts: draft.answerable ? facts : [],
        answerable: draft.answerable,
      },
      () => setEditing(false),
    );
  }

  return (
    <TableRow data-proposal-id={proposal.id}>
      <TableCell className="max-w-md whitespace-normal align-top">
        {editing ? (
          <div className="space-y-2">
            <div>
              <label
                htmlFor={`prop-${proposal.id}-question`}
                className="block text-xs font-medium"
              >
                Question
              </label>
              <Textarea
                id={`prop-${proposal.id}-question`}
                value={draft.question}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, question: e.target.value })
                }
              />
            </div>
            <div>
              <label
                htmlFor={`prop-${proposal.id}-expected`}
                className="block text-xs font-medium"
              >
                Expected answer
              </label>
              <Textarea
                id={`prop-${proposal.id}-expected`}
                value={draft.expectedAnswer}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, expectedAnswer: e.target.value })
                }
              />
            </div>
            <div>
              <label
                htmlFor={`prop-${proposal.id}-rule`}
                className="block text-xs font-medium"
              >
                Acceptance criteria
              </label>
              <Input
                id={`prop-${proposal.id}-rule`}
                value={draft.acceptanceRule}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, acceptanceRule: e.target.value })
                }
              />
            </div>
            <div>
              <label
                htmlFor={`prop-${proposal.id}-facts`}
                className="block text-xs font-medium"
              >
                Reference facts (one per line)
              </label>
              <Textarea
                id={`prop-${proposal.id}-facts`}
                value={draft.factsText}
                disabled={busy || !draft.answerable}
                onChange={(e) =>
                  setDraft({ ...draft, factsText: e.target.value })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id={`prop-${proposal.id}-answerable`}
                type="checkbox"
                checked={draft.answerable}
                disabled={busy}
                onChange={(e) =>
                  setDraft({ ...draft, answerable: e.target.checked })
                }
              />
              <label
                htmlFor={`prop-${proposal.id}-answerable`}
                className="text-xs"
              >
                Answerable from frozen revision
              </label>
            </div>
            <div className="flex flex-wrap gap-1">
              <Button
                size="sm"
                disabled={busy || !draft.question.trim()}
                onClick={saveEdit}
              >
                Save edits
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel edit
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="font-medium">{proposal.question}</p>
            {proposal.expectedAnswer && (
              <p className="text-muted-foreground text-xs">
                <span className="font-medium">Reference answer:</span>{' '}
                {proposal.expectedAnswer}
              </p>
            )}
            {proposal.referenceFacts.length > 0 && (
              <p className="text-muted-foreground text-xs">
                <span className="font-medium">Facts:</span>{' '}
                {proposal.referenceFacts.join(' · ')}
              </p>
            )}
            <div className="flex flex-wrap gap-1 pt-1">
              <Badge variant="outline">
                {proposal.answerable ? 'Answerable' : 'Unanswerable'}
              </Badge>
              {proposal.qrels.map((q) => (
                <Badge key={q.documentId} variant="secondary">
                  {docNameById.get(q.documentId) ?? q.documentId.slice(0, 8)}:
                  grade {q.grade}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </TableCell>
      <TableCell className="max-w-xs whitespace-normal align-top text-xs">
        <div className="space-y-1">
          {proposal.sourceSpans.map((span) => (
            <div
              key={`${span.documentVersionId}-${span.start}-${span.end}`}
              className="rounded border p-1.5"
            >
              <p className="font-medium">
                {span.documentName} [{span.start}–{span.end}]
              </p>
              <p className="text-muted-foreground">
                “{span.quote.slice(0, 140)}
                {span.quote.length > 140 ? '…' : ''}”
              </p>
            </div>
          ))}
          <p className="text-muted-foreground pt-1">
            {proposal.provenance.provider} / {proposal.provenance.model} ·{' '}
            {proposal.provenance.promptVersion} · seed{' '}
            {proposal.provenance.seed} · r{proposal.datasetRevision} · sha256:
            {proposal.provenance.rawResponseHash.slice(0, 8)}
          </p>
        </div>
      </TableCell>
      <TableCell className="max-w-xs whitespace-normal align-top text-xs">
        {proposal.leakageFlagged ? (
          <div className="space-y-1">
            <Badge variant="destructive">
              Leakage flagged ({Math.round(proposal.leakageScore * 100)}%)
            </Badge>
            {proposal.leakageReason && (
              <p className="text-destructive">{proposal.leakageReason}</p>
            )}
          </div>
        ) : (
          <Badge variant="secondary">
            Clear ({Math.round(proposal.leakageScore * 100)}%)
          </Badge>
        )}
      </TableCell>
      <TableCell className="whitespace-normal align-top text-xs">
        <div className="flex flex-wrap gap-1">
          <Badge
            variant={
              proposal.reviewStatus === 'accepted' ||
              proposal.reviewStatus === 'promoted'
                ? 'default'
                : proposal.reviewStatus === 'rejected'
                  ? 'destructive'
                  : 'outline'
            }
          >
            {proposal.reviewStatus}
          </Badge>
          {proposal.edited && <Badge variant="secondary">edited</Badge>}
          {proposal.promotedRevision && (
            <Badge variant="outline">r{proposal.promotedRevision}</Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="whitespace-normal align-top">
        {isPromoted ? (
          <span className="text-muted-foreground text-xs">Promoted</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant={
                proposal.reviewStatus === 'accepted' ? 'default' : 'outline'
              }
              disabled={busy || editing}
              onClick={() =>
                onReview(proposal.id, { reviewStatus: 'accepted' })
              }
            >
              Accept
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || editing}
              onClick={startEdit}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant={
                proposal.reviewStatus === 'rejected' ? 'destructive' : 'ghost'
              }
              disabled={busy || editing}
              onClick={() =>
                onReview(proposal.id, { reviewStatus: 'rejected' })
              }
            >
              Reject
            </Button>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function SyntheticGenerationPanel({ dataset }: { dataset: c.Dataset }) {
  const cache = useQueryClient();
  const capabilities = useCapabilities();
  const chatProfiles = (capabilities.data?.profiles ?? []).filter(
    (p) => p.role === 'chat',
  );
  const [selectedModel, setSelectedModel] = useState('');
  const [targetCount, setTargetCount] = useState('5');
  const [seed, setSeed] = useState('42');
  const [includeUnanswerable, setIncludeUnanswerable] = useState(true);
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');

  const effectiveProfile =
    chatProfiles.find((p) => p.model === selectedModel) ?? chatProfiles[0];
  const hasChatProfile = Boolean(effectiveProfile);

  const batchesQuery = useQuery({
    queryKey: ['generations', dataset.id],
    queryFn: () =>
      request(
        c.page(c.generationBatch),
        `datasets/${dataset.id}/generations?limit=10`,
      ),
    refetchInterval: (q) => {
      const latest = q.state.data?.items[0];
      return latest && ACTIVE_STATES.has(latest.state) ? 1000 : false;
    },
  });

  const proposalsQuery = useQuery({
    queryKey: ['proposals', dataset.id],
    queryFn: () =>
      request(
        c.page(c.syntheticProposal),
        `datasets/${dataset.id}/proposals?limit=100`,
      ),
  });

  const latestBatch = batchesQuery.data?.items[0] ?? null;
  const isLatestActive = Boolean(
    latestBatch && ACTIVE_STATES.has(latestBatch.state),
  );

  // Refresh proposals automatically whenever a batch progresses or finishes.
  const prevBatchSnap = useRef<string>('');
  useEffect(() => {
    if (!latestBatch) return;
    const snap = `${latestBatch.id}:${latestBatch.state}:${latestBatch.processedDocuments}:${latestBatch.proposedCount}`;
    if (prevBatchSnap.current && prevBatchSnap.current !== snap) {
      void cache.invalidateQueries({ queryKey: ['proposals', dataset.id] });
    }
    prevBatchSnap.current = snap;
  }, [cache, dataset.id, latestBatch]);

  const startMutation = useMutation({
    mutationFn: () => {
      const parsedCount = Math.max(
        1,
        Math.min(50, Number.parseInt(targetCount, 10) || 5),
      );
      const parsedSeed = Math.max(0, Number.parseInt(seed, 10) || 0);
      return request(
        c.createGenerationResult,
        `datasets/${dataset.id}/generations`,
        'POST',
        {
          datasetRevision: dataset.revision,
          model: effectiveProfile?.model ?? '',
          count: parsedCount,
          seed: parsedSeed,
          includeUnanswerable,
        },
        undefined,
        crypto.randomUUID(),
      );
    },
    onSuccess: async () => {
      setActionError('');
      setNotice(
        `Queued synthetic generation from frozen revision ${dataset.revision}.`,
      );
      await cache.invalidateQueries({ queryKey: ['generations', dataset.id] });
    },
    onError: (err) => {
      setNotice('');
      setActionError(
        err instanceof Error ? err.message : 'Failed to start generation.',
      );
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (jobId: string) =>
      request(c.job, `jobs/${jobId}/cancel`, 'POST', {}),
    onSuccess: async () => {
      setActionError('');
      setNotice('Cancellation requested for generation job.');
      await cache.invalidateQueries({ queryKey: ['generations', dataset.id] });
    },
    onError: (err) => {
      setActionError(
        err instanceof Error ? err.message : 'Failed to cancel generation.',
      );
    },
  });

  const reviewMutation = useMutation({
    mutationFn: ({
      proposalId,
      patch,
    }: {
      proposalId: string;
      patch: c.ReviewProposalPatch;
      onDone?: () => void;
    }) =>
      request(
        c.syntheticProposal,
        `datasets/${dataset.id}/proposals/${proposalId}`,
        'PATCH',
        patch,
      ),
    onSuccess: async (_updated, vars) => {
      setActionError('');
      vars.onDone?.();
      await cache.invalidateQueries({ queryKey: ['proposals', dataset.id] });
    },
    onError: (err) => {
      setActionError(
        err instanceof Error ? err.message : 'Failed to update proposal.',
      );
    },
  });

  const promoteMutation = useMutation({
    mutationFn: (proposalIds: string[]) =>
      request(
        c.promoteProposalsResult,
        `datasets/${dataset.id}/proposals/promote`,
        'POST',
        { proposalIds },
        dataset.revision,
      ),
    onSuccess: async (result) => {
      setActionError('');
      setNotice(
        `Promoted ${result.promotedCount} accepted proposal${result.promotedCount === 1 ? '' : 's'} into revision ${result.dataset.revision}.`,
      );
      cache.setQueryData(['datasets', dataset.id], result.dataset);
      await cache.invalidateQueries({ queryKey: listKey('datasets') });
      await cache.invalidateQueries({ queryKey: ['proposals', dataset.id] });
    },
    onError: (err) => {
      setNotice('');
      setActionError(
        err instanceof Error ? err.message : 'Failed to promote proposals.',
      );
    },
  });

  const allProposals = proposalsQuery.data?.items ?? [];
  const filteredProposals =
    filterStatus === 'all'
      ? allProposals
      : allProposals.filter((p) => p.reviewStatus === filterStatus);
  const acceptedPromotable = allProposals.filter(
    (p) => p.reviewStatus === 'accepted' && !p.leakageFlagged,
  );
  const acceptedFlagged = allProposals.filter(
    (p) => p.reviewStatus === 'accepted' && p.leakageFlagged,
  );

  const progressPercent =
    latestBatch && latestBatch.totalDocuments > 0
      ? Math.round(
          (latestBatch.processedDocuments / latestBatch.totalDocuments) * 100,
        )
      : latestBatch?.state === 'succeeded'
        ? 100
        : 0;

  const isBusy =
    startMutation.isPending ||
    cancelMutation.isPending ||
    reviewMutation.isPending ||
    promoteMutation.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Generate questions</CardTitle>
        <p className="text-muted-foreground text-sm">
          Propose draft questions, reference facts, validated source spans, and
          graded qrels from frozen revision {dataset.revision}. Proposals stay
          outside every scored dataset until you review and promote them into a
          new revision.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!capabilities.isPending && !hasChatProfile && (
          <div
            role="alert"
            className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            A configured chat profile is required to generate synthetic
            questions. Set <code>OPENAI_CHAT_MODEL</code>,{' '}
            <code>ANTHROPIC_CHAT_MODEL</code>, or <code>LOCAL_CHAT_MODEL</code>{' '}
            on the server to enable this workflow.
          </div>
        )}

        <div className="bg-muted/40 rounded border p-3 text-sm">
          {effectiveProfile ? (
            effectiveProfile.provider === 'openai-compatible' ? (
              <p>
                <strong>Data leaving this installation:</strong> starting
                generation sends extracted text from frozen dataset{' '}
                <strong>{dataset.name}</strong> (revision {dataset.revision}) to
                your configured OpenAI-compatible chat endpoint (
                <code>{effectiveProfile.model}</code>). Draft proposals remain
                local and are never auto-scored.
              </p>
            ) : (
              <p>
                <strong>External data transfer:</strong> starting generation
                sends extracted text from frozen dataset{' '}
                <strong>{dataset.name}</strong> (revision {dataset.revision}) to{' '}
                <strong>{effectiveProfile.provider}</strong> (
                <code>{effectiveProfile.model}</code>) and may incur provider
                charges. Draft proposals remain local and are never auto-scored.
              </p>
            )
          ) : (
            <p>
              <strong>Data handling:</strong> when a chat profile is configured,
              extracted text from the frozen dataset revision is sent to that
              chat provider to propose draft questions. Drafts remain outside
              scored datasets until promoted.
            </p>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label
              htmlFor={`${dataset.id}-gen-model`}
              className="mb-1 block text-sm font-medium"
            >
              Generator chat profile
            </label>
            <select
              id={`${dataset.id}-gen-model`}
              className="w-full rounded border p-2 text-sm"
              disabled={!hasChatProfile || isBusy || isLatestActive}
              value={effectiveProfile?.model ?? ''}
              onChange={(e) => setSelectedModel(e.target.value)}
            >
              {chatProfiles.length === 0 ? (
                <option value="">No chat profile configured</option>
              ) : (
                chatProfiles.map((p) => (
                  <option key={`${p.provider}:${p.model}`} value={p.model}>
                    {p.model} ({p.provider})
                  </option>
                ))
              )}
            </select>
          </div>
          <div>
            <label
              htmlFor={`${dataset.id}-gen-count`}
              className="mb-1 block text-sm font-medium"
            >
              Target question count
            </label>
            <Input
              id={`${dataset.id}-gen-count`}
              type="number"
              min={1}
              max={50}
              disabled={!hasChatProfile || isBusy || isLatestActive}
              value={targetCount}
              onChange={(e) => setTargetCount(e.target.value)}
            />
          </div>
          <div>
            <label
              htmlFor={`${dataset.id}-gen-seed`}
              className="mb-1 block text-sm font-medium"
            >
              Generation seed
            </label>
            <Input
              id={`${dataset.id}-gen-seed`}
              type="number"
              min={0}
              disabled={!hasChatProfile || isBusy || isLatestActive}
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <input
              id={`${dataset.id}-gen-unanswerable`}
              type="checkbox"
              checked={includeUnanswerable}
              disabled={!hasChatProfile || isBusy || isLatestActive}
              onChange={(e) => setIncludeUnanswerable(e.target.checked)}
            />
            <label
              htmlFor={`${dataset.id}-gen-unanswerable`}
              className="text-sm"
            >
              Include unanswerable abstention questions
            </label>
          </div>
          <Button
            disabled={
              !hasChatProfile ||
              dataset.documents.length === 0 ||
              isBusy ||
              isLatestActive
            }
            onClick={() => startMutation.mutate()}
          >
            {startMutation.isPending ? 'Starting…' : 'Start generation'}
          </Button>
        </div>

        {dataset.documents.length === 0 && (
          <p className="text-muted-foreground text-sm">
            Upload and parse at least one document before generating questions.
          </p>
        )}

        {batchesQuery.isPending && (
          <p role="status" className="text-sm">
            Loading generation status…
          </p>
        )}

        {batchesQuery.error && (
          <p role="alert" className="text-destructive text-sm">
            {batchesQuery.error.message}
          </p>
        )}

        {latestBatch && (
          <div className="space-y-2 rounded border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Latest generation</span>
                <Badge
                  variant={
                    latestBatch.state === 'succeeded'
                      ? 'default'
                      : latestBatch.state === 'failed'
                        ? 'destructive'
                        : 'secondary'
                  }
                >
                  {latestBatch.state}
                </Badge>
                <span className="text-muted-foreground">
                  stage: {latestBatch.stage} · r{latestBatch.datasetRevision} ·{' '}
                  {latestBatch.provider}/{latestBatch.model}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {isLatestActive && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={batchesQuery.isFetching}
                    onClick={() => void batchesQuery.refetch()}
                  >
                    Refresh status
                  </Button>
                )}
                {['queued', 'running'].includes(latestBatch.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cancelMutation.isPending}
                    onClick={() => cancelMutation.mutate(latestBatch.jobId)}
                  >
                    Cancel generation
                  </Button>
                )}
              </div>
            </div>
            <Progress value={progressPercent} />
            <p role="status" className="text-muted-foreground text-xs">
              Documents processed: {latestBatch.processedDocuments} /{' '}
              {latestBatch.totalDocuments} · Drafts stored:{' '}
              {latestBatch.proposedCount} · Deduplicated:{' '}
              {latestBatch.deduplicatedCount} · Invalid spans dropped:{' '}
              {latestBatch.invalidSpanCount} · Leakage flagged:{' '}
              {latestBatch.leakageFlaggedCount}
            </p>
            {isLatestActive && !latestBatch.workerOnline && (
              <p
                role="alert"
                className="text-sm text-amber-700 dark:text-amber-300"
              >
                No worker is running — start it with npm run dev:worker
              </p>
            )}
            {latestBatch.errorMessage && (
              <p role="alert" className="text-destructive text-sm">
                {latestBatch.errorMessage}
              </p>
            )}
          </div>
        )}

        {notice && (
          <p role="status" className="text-sm font-medium">
            {notice}
          </p>
        )}
        {actionError && (
          <p role="alert" className="text-destructive text-sm">
            {actionError}
          </p>
        )}

        <div className="space-y-3 pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-medium">
              Draft proposals review queue ({allProposals.length})
            </h3>
            <div className="flex items-center gap-2">
              <label
                htmlFor={`${dataset.id}-proposal-filter`}
                className="text-sm"
              >
                Filter proposals
              </label>
              <select
                id={`${dataset.id}-proposal-filter`}
                className="rounded border p-1.5 text-sm"
                value={filterStatus}
                onChange={(e) =>
                  setFilterStatus(e.target.value as FilterStatus)
                }
              >
                <option value="all">All ({allProposals.length})</option>
                <option value="pending">Pending</option>
                <option value="accepted">Accepted</option>
                <option value="rejected">Rejected</option>
                <option value="promoted">Promoted</option>
              </select>
            </div>
          </div>

          {proposalsQuery.isPending && (
            <p role="status" className="text-sm">
              Loading draft proposals…
            </p>
          )}
          {proposalsQuery.error && (
            <p role="alert" className="text-destructive text-sm">
              {proposalsQuery.error.message}
            </p>
          )}

          {!proposalsQuery.isPending &&
            !proposalsQuery.error &&
            filteredProposals.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {allProposals.length === 0
                  ? 'No draft proposals yet. Start generation to propose questions for human review.'
                  : 'No proposals match the selected filter.'}
              </p>
            )}

          {filteredProposals.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Question &amp; Reference</TableHead>
                  <TableHead>Source Spans &amp; Provenance</TableHead>
                  <TableHead>Leakage</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProposals.map((proposal) => (
                  <ProposalRow
                    key={proposal.id}
                    dataset={dataset}
                    proposal={proposal}
                    busy={isBusy}
                    onReview={(proposalId, patch, onDone) =>
                      reviewMutation.mutate({ proposalId, patch, onDone })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          )}

          {acceptedFlagged.length > 0 && (
            <p
              role="alert"
              className="text-sm text-amber-700 dark:text-amber-300"
            >
              {acceptedFlagged.length} accepted proposal
              {acceptedFlagged.length === 1 ? ' is' : 's are'} flagged for
              near-verbatim reference answer leakage and cannot be promoted
              until edited.
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <p className="text-muted-foreground text-xs">
              Promotion creates a new dataset revision (r{dataset.revision + 1})
              and leaves revision {dataset.revision} untouched.
            </p>
            <Button
              disabled={acceptedPromotable.length === 0 || isBusy}
              onClick={() =>
                promoteMutation.mutate(acceptedPromotable.map((p) => p.id))
              }
            >
              {promoteMutation.isPending
                ? 'Promoting…'
                : `Promote accepted (${acceptedPromotable.length}) to revision ${dataset.revision + 1}`}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
