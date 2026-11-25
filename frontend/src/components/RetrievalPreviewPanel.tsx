import * as c from '@rag-eval/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  request,
  useCapabilities,
  useDatasetSelection,
} from '../data/workspace';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';

function formatScore(value: number | null) {
  return value === null ? '—' : value.toFixed(4);
}

function formatRank(value: number | null) {
  return value === null ? '—' : `#${value}`;
}

export function RetrievalPreviewPanel({
  defaultConfig,
}: {
  defaultConfig?: c.PipelineConfig;
}) {
  const cache = useQueryClient();
  const { detail: datasetDetail, id: datasetId } = useDatasetSelection();
  const capabilities = useCapabilities();
  const [selectedIndexId, setSelectedIndexId] = useState('');
  const [queryText, setQueryText] = useState('');
  const [topK, setTopK] = useState(5);
  const [mode, setMode] = useState<c.RetrievalMode>('keyword');
  const [buildingJobId, setBuildingJobId] = useState<string | null>(null);

  const indexesQuery = useQuery({
    queryKey: ['indexes', datasetId ?? 'all'],
    queryFn: () =>
      request(
        c.page(c.indexGeneration),
        `indexes?limit=50${datasetId ? `&datasetId=${datasetId}` : ''}`,
      ),
    enabled: Boolean(datasetId),
  });

  const readyIndexes = useMemo(
    () =>
      (indexesQuery.data?.items ?? []).filter((idx) => idx.state === 'ready'),
    [indexesQuery.data],
  );

  const activeIndexId =
    readyIndexes.find((idx) => idx.id === selectedIndexId)?.id ??
    readyIndexes[0]?.id ??
    '';
  const activeIndex = readyIndexes.find((idx) => idx.id === activeIndexId);

  useEffect(() => {
    if (activeIndex) {
      setMode(activeIndex.mode);
    }
  }, [activeIndex]);

  const buildJobQuery = useQuery({
    queryKey: ['jobs', buildingJobId],
    queryFn: () => request(c.job, `jobs/${buildingJobId}`),
    enabled: Boolean(buildingJobId),
    refetchInterval: (q) => {
      const st = q.state.data?.state;
      return st && ['queued', 'running', 'cancellation_requested'].includes(st)
        ? 1500
        : false;
    },
  });

  useEffect(() => {
    if (buildJobQuery.data?.state === 'succeeded') {
      if (buildJobQuery.data.generationId) {
        setSelectedIndexId(buildJobQuery.data.generationId);
      }
      setBuildingJobId(null);
      void cache.invalidateQueries({
        queryKey: ['indexes', datasetId ?? 'all'],
      });
    }
  }, [buildJobQuery.data, cache, datasetId]);

  const buildIndex = useMutation({
    mutationFn: async () => {
      if (!datasetDetail.data) {
        throw new Error('Select a dataset before building an index.');
      }
      const chunking = defaultConfig?.chunking ?? {
        strategy: 'character-window' as const,
        chunkSize: 300,
        overlap: 20,
      };
      const requestedMode = defaultConfig?.retriever.mode ?? 'keyword';
      const embeddingModel = defaultConfig?.embedding.model ?? '';
      return request(
        c.createIndexResult,
        'indexes',
        'POST',
        {
          datasetId: datasetDetail.data.id,
          datasetRevision: datasetDetail.data.revision,
          mode: requestedMode,
          chunking,
          embeddingModel,
          forceRebuild: false,
        },
        undefined,
        crypto.randomUUID(),
      );
    },
    onSuccess: (res) => {
      if (res.index.state === 'ready') {
        setSelectedIndexId(res.index.id);
        setBuildingJobId(null);
      } else if (res.jobId) {
        setBuildingJobId(res.jobId);
      }
      void cache.invalidateQueries({
        queryKey: ['indexes', datasetId ?? 'all'],
      });
    },
  });

  const searchMutation = useMutation({
    mutationFn: async () => {
      if (!activeIndexId) {
        throw new Error('Select or build a ready index first.');
      }
      const trimmed = queryText.trim();
      if (!trimmed) {
        throw new Error('Enter a search query to preview retrieval.');
      }
      return request(
        c.indexSearchResult,
        `indexes/${activeIndexId}/search`,
        'POST',
        {
          query: trimmed,
          mode,
          topK,
          fusionWeights: defaultConfig?.retriever.fusionWeights ?? {
            keyword: 1,
            dense: 1,
          },
          reranker: defaultConfig?.reranker ?? {
            enabled: false,
            model: '',
            failurePolicy: 'fail',
          },
        },
      );
    },
  });

  const isBuilding =
    buildIndex.isPending ||
    (Boolean(buildingJobId) &&
      buildJobQuery.data?.state !== 'failed' &&
      buildJobQuery.data?.state !== 'cancelled');
  const activeJobOffline =
    isBuilding && buildJobQuery.data && !buildJobQuery.data.workerOnline;
  const previewError =
    searchMutation.error?.message ??
    buildIndex.error?.message ??
    indexesQuery.error?.message ??
    (buildJobQuery.data?.state === 'failed'
      ? (buildJobQuery.data.message ?? 'Index build failed.')
      : null);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Retrieval Preview</CardTitle>
            <p className="text-sm text-muted-foreground">
              Query a ready index generation via{' '}
              <code>/api/v1/indexes/:id/search</code> and inspect keyword,
              dense, fused, and rerank scores.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!datasetDetail.data || isBuilding}
              onClick={() => buildIndex.mutate()}
            >
              {isBuilding ? 'Building index…' : 'Build / reuse index'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void indexesQuery.refetch();
                if (buildingJobId) void buildJobQuery.refetch();
              }}
            >
              <RefreshCw size={14} aria-hidden="true" /> Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!datasetId && (
          <p className="text-sm text-muted-foreground">
            Select or create a dataset on the Datasets page to preview
            retrieval.
          </p>
        )}

        {isBuilding && (
          <p role="status" className="text-sm text-muted-foreground">
            Building index generation
            {buildJobQuery.data
              ? ` (${buildJobQuery.data.state} · ${buildJobQuery.data.stage})`
              : '…'}
            {activeJobOffline
              ? ' — No worker is running — start it with npm run dev:worker'
              : ''}
          </p>
        )}

        {indexesQuery.isPending && datasetId && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading index generations…
          </p>
        )}

        {datasetId && !indexesQuery.isPending && readyIndexes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No ready index for this dataset yet. Click{' '}
            <strong>Build / reuse index</strong> to build one and preview
            retrieval.
          </p>
        )}

        {readyIndexes.length > 0 && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              searchMutation.mutate();
            }}
          >
            <div className="grid gap-3 md:grid-cols-4">
              <label className="block text-sm md:col-span-2">
                Index generation
                <select
                  aria-label="Preview index generation"
                  className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                  value={activeIndexId}
                  onChange={(e) => setSelectedIndexId(e.target.value)}
                >
                  {readyIndexes.map((idx) => (
                    <option key={idx.id} value={idx.id}>
                      r{idx.datasetRevision} · {idx.mode} ·{' '}
                      {idx.chunking.strategy} ({idx.chunkCount} chunks)
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-sm">
                Search mode
                <select
                  aria-label="Preview search mode"
                  className="mt-1 block w-full rounded border bg-background p-2 text-sm"
                  value={mode}
                  onChange={(e) =>
                    setMode(c.retrievalMode.parse(e.target.value))
                  }
                >
                  <option value="keyword">Keyword (FTS5)</option>
                  <option
                    value="dense"
                    disabled={activeIndex?.mode === 'keyword'}
                  >
                    Dense (Qdrant)
                  </option>
                  <option
                    value="hybrid"
                    disabled={activeIndex?.mode === 'keyword'}
                  >
                    Hybrid (RRF)
                  </option>
                </select>
              </label>

              <label
                htmlFor="retrieval-preview-top-k"
                className="block text-sm"
              >
                Top-K
                <Input
                  id="retrieval-preview-top-k"
                  aria-label="Preview top-K"
                  type="number"
                  min={1}
                  max={20}
                  value={topK}
                  onChange={(e) =>
                    setTopK(
                      Math.max(1, Math.min(20, Number(e.target.value) || 5)),
                    )
                  }
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="Preview query"
                className="flex-1 min-w-56"
                placeholder="Enter a test query to inspect ranked chunks…"
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
              />
              <Button
                type="submit"
                disabled={searchMutation.isPending || !queryText.trim()}
                className="gap-2"
              >
                <Search size={16} aria-hidden="true" />
                {searchMutation.isPending ? 'Searching…' : 'Preview search'}
              </Button>
            </div>
            {!capabilities.data?.denseStore && (
              <p className="text-xs text-muted-foreground">
                Keyword (FTS5) preview works offline without Qdrant or API keys.
              </p>
            )}
          </form>
        )}

        {searchMutation.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Searching index…
          </p>
        )}

        {previewError && (
          <p
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
          >
            {previewError}
          </p>
        )}

        {searchMutation.data && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">
                Mode: {searchMutation.data.mode}
              </Badge>
              <span>
                Keyword hits: {searchMutation.data.stages.keywordCount}
              </span>
              <span>Dense hits: {searchMutation.data.stages.denseCount}</span>
              <span>Fused: {searchMutation.data.stages.fusedCount}</span>
              <span>Rerank: {searchMutation.data.stages.rerankStatus}</span>
              <span>
                Total: {Math.round(searchMutation.data.stages.timingsMs.total)}
                ms
              </span>
            </div>

            {searchMutation.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No matching chunks found for this query.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Final</TableHead>
                      <TableHead>Keyword</TableHead>
                      <TableHead>Dense</TableHead>
                      <TableHead>Fused</TableHead>
                      <TableHead>Rerank</TableHead>
                      <TableHead>Document &amp; chunk</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {searchMutation.data.items.map((item) => (
                      <TableRow key={item.chunkId}>
                        <TableCell className="whitespace-nowrap font-medium">
                          #{item.finalRank} ({formatScore(item.finalScore)})
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatRank(item.keywordRank)} /{' '}
                          {formatScore(item.keywordScore)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatRank(item.denseRank)} /{' '}
                          {formatScore(item.denseScore)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatRank(item.fusedRank)} /{' '}
                          {formatScore(item.fusedScore)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatRank(item.rerankRank)} /{' '}
                          {formatScore(item.rerankScore)}
                        </TableCell>
                        <TableCell className="max-w-md">
                          <div className="text-xs font-medium">
                            {item.documentName} · p.{item.page} ({item.start}–
                            {item.end})
                          </div>
                          <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                            {item.content}
                          </p>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
