import * as c from '@rag-eval/contracts';
import { useQuery } from '@tanstack/react-query';
import { BookOpen } from 'lucide-react';
import { Link } from 'react-router';
import { request } from '../data/workspace';
import { Badge } from './ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DocumentationPage() {
  const docQuery = useQuery({
    queryKey: ['documentation'],
    queryFn: () => request(c.documentationPayload, 'documentation'),
  });

  const doc = docQuery.data;

  return (
    <div className="page max-w-6xl space-y-6">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <BookOpen className="text-primary" size={28} aria-hidden="true" />
          <h1>Documentation</h1>
        </div>
        <p className="text-muted-foreground">
          Live operational reference derived from shipped server configuration,
          metric formulas, and versioned judge rubrics.
        </p>
      </div>

      {docQuery.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading shipped configuration and metric definitions…
        </p>
      )}

      {docQuery.error && (
        <p role="alert" className="text-sm text-destructive">
          {docQuery.error.message}
        </p>
      )}

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList
          aria-label="Documentation sections"
          className="grid h-auto w-full grid-cols-2 sm:grid-cols-4"
        >
          <TabsTrigger value="overview">Workflow</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="retrieval">Ingestion &amp; Retrieval</TabsTrigger>
          <TabsTrigger value="metrics">Metrics &amp; Rubrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Reproducible RAG Evaluation Workflow</CardTitle>
              <CardDescription>
                SQLite owns every dataset revision, pipeline revision, job, and
                scored observation.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>
                Load the built-in sample dataset or upload local text, Markdown,
                or text PDF documents to run deterministic keyword retrieval
                experiments offline with zero API keys. Adding server-side
                provider profiles unlocks dense/hybrid retrieval, grounded
                answer generation, and structured rubric judging on the same
                saved runs.
              </p>
              <ol className="grid gap-3 sm:grid-cols-2">
                {[
                  {
                    to: '/datasets',
                    title: '1. Datasets & Tasks',
                    detail:
                      'Upload documents, author questions, reference facts, answerability flags, and graded 0-3 document qrels.',
                  },
                  {
                    to: '/pipelines',
                    title: '2. Pipelines',
                    detail:
                      'Configure chunking, retrieval mode, top-K, optional HTTP reranker, and server-managed model profiles. Duplicate baselines to compare changes.',
                  },
                  {
                    to: '/experiments',
                    title: '3. Experiments',
                    detail:
                      'Submit frozen retrieval-only or full-RAG runs to the durable worker queue with cancellation, retry, and checkpointed progress.',
                  },
                  {
                    to: '/reports',
                    title: '4. Reports & History',
                    detail:
                      'Inspect paired deltas, seeded bootstrap confidence intervals, side-by-side task evidence, Markdown/JSON exports, and paginated print output.',
                  },
                ].map((step) => (
                  <li key={step.to} className="rounded-lg border p-4 space-y-1">
                    <Link
                      to={step.to}
                      className="font-semibold text-primary underline"
                    >
                      {step.title}
                    </Link>
                    <p className="text-muted-foreground">{step.detail}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="configuration" className="space-y-4">
          {doc ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Active Server Capabilities</CardTitle>
                  <CardDescription>
                    Reported directly from <code>/api/v1/documentation</code>{' '}
                    (credentials and endpoint URLs remain server-only).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant={
                        doc.capabilities.workerOnline ? 'default' : 'secondary'
                      }
                    >
                      Worker:{' '}
                      {doc.capabilities.workerOnline ? 'online' : 'offline'}
                    </Badge>
                    <Badge
                      variant={
                        doc.capabilities.denseStore ? 'default' : 'outline'
                      }
                    >
                      Qdrant dense store:{' '}
                      {doc.capabilities.denseStore
                        ? 'configured'
                        : 'not configured'}
                    </Badge>
                    <Badge
                      variant={
                        doc.capabilities.cloudParser ? 'default' : 'outline'
                      }
                    >
                      LlamaParse cloud parser:{' '}
                      {doc.capabilities.cloudParser
                        ? 'configured'
                        : 'not configured'}
                    </Badge>
                    <Badge variant="outline">
                      Software v{doc.softwareVersion}
                    </Badge>
                  </div>

                  {doc.capabilities.profiles.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Role</TableHead>
                            <TableHead>Model</TableHead>
                            <TableHead>Provider</TableHead>
                            <TableHead>Supported options</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {doc.capabilities.profiles.map((profile) => (
                            <TableRow key={`${profile.role}-${profile.model}`}>
                              <TableCell className="capitalize font-medium">
                                {profile.role}
                              </TableCell>
                              <TableCell>{profile.model}</TableCell>
                              <TableCell>{profile.provider}</TableCell>
                              <TableCell>
                                {profile.options.length > 0
                                  ? profile.options.join(', ')
                                  : 'Default'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="text-muted-foreground">
                      No remote or local model profiles are currently
                      configured. Offline keyword retrieval evaluation works
                      without any profiles; configure provider variables on the
                      backend to enable dense retrieval, generation, or judging.
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Operational Limits &amp; Pricing</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">
                      JSON / Upload Limits
                    </div>
                    <div className="font-medium">
                      {formatBytes(doc.limits.jsonLimitBytes)} JSON ·{' '}
                      {formatBytes(doc.limits.documentLimitBytes)} upload
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">
                      Rate Limit
                    </div>
                    <div className="font-medium">
                      {doc.limits.rateLimit} req /{' '}
                      {Math.round(doc.limits.rateWindowMs / 1000)}s
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">
                      Worker Lease &amp; Timeout
                    </div>
                    <div className="font-medium">
                      {Math.round(doc.limits.workerLeaseMs / 1000)}s lease ·{' '}
                      {Math.round(doc.limits.providerTimeoutMs / 1000)}s timeout
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">
                      Embedding Batch Size
                    </div>
                    <div className="font-medium">
                      {doc.limits.embedBatchSize} chunks / batch
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">
                      Run Budgets
                    </div>
                    <div className="font-medium">
                      {doc.limits.runMaxTokens !== null
                        ? `${doc.limits.runMaxTokens.toLocaleString()} tokens`
                        : 'No token cap'}{' '}
                      ·{' '}
                      {doc.limits.runMaxCostUsd !== null
                        ? `$${doc.limits.runMaxCostUsd.toFixed(2)} USD`
                        : 'No USD cap'}
                    </div>
                  </div>
                  <div className="rounded border p-3">
                    <div className="text-xs text-muted-foreground">
                      Price Schedule ({doc.pricing.currency})
                    </div>
                    <div className="font-medium">{doc.pricing.version}</div>
                    <div className="text-xs text-muted-foreground">
                      {doc.pricing.configuredModels.length > 0
                        ? `Priced models: ${doc.pricing.configuredModels.join(', ')}`
                        : 'Unpriced models remain explicitly Unknown.'}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Configuration details will appear once the backend responds.
            </p>
          )}
        </TabsContent>

        <TabsContent value="retrieval" className="space-y-4">
          {doc ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Ingestion &amp; Chunking</CardTitle>
                  <CardDescription>
                    Chunk size {doc.ingestion.chunkSizeRange.min}–
                    {doc.ingestion.chunkSizeRange.max} characters · Overlap{' '}
                    {doc.ingestion.overlapRange.min}–
                    {doc.ingestion.overlapRange.max} characters
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded border p-3">
                      <div className="font-medium">Local offline formats</div>
                      <p className="mt-1 text-muted-foreground">
                        {doc.ingestion.localFormats.join(', ')}
                      </p>
                    </div>
                    <div className="rounded border p-3">
                      <div className="font-medium">Optional cloud formats</div>
                      <p className="mt-1 text-muted-foreground">
                        {doc.ingestion.cloudFormats.join(', ')}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {doc.ingestion.chunkingStrategies.map((strat) => (
                      <div key={strat.id} className="rounded border p-3">
                        <div className="font-medium">
                          {strat.name}{' '}
                          <code className="text-xs text-muted-foreground">
                            ({strat.id})
                          </code>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {strat.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Retrieval Modes, Fusion &amp; Reranking</CardTitle>
                  <CardDescription>
                    Reciprocal Rank Fusion:{' '}
                    <code>{doc.retrieval.rrfFormula}</code>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="grid gap-3 md:grid-cols-3">
                    {doc.retrieval.modes.map((mode) => (
                      <div
                        key={mode.id}
                        className="rounded border p-3 space-y-1"
                      >
                        <div className="font-medium">{mode.name}</div>
                        <p className="text-xs text-muted-foreground">
                          {mode.description}
                        </p>
                        <div className="flex flex-wrap gap-1 pt-1">
                          {!mode.requiresDenseStore &&
                            !mode.requiresEmbeddingProfile && (
                              <Badge variant="secondary">Offline ready</Badge>
                            )}
                          {mode.requiresDenseStore && (
                            <Badge variant="outline">Requires Qdrant</Badge>
                          )}
                          {mode.requiresEmbeddingProfile && (
                            <Badge variant="outline">Requires embedding</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">
                      Reranker failure policies
                    </h3>
                    <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
                      {doc.retrieval.rerankFailurePolicies.map((policy) => (
                        <li key={policy.id}>
                          <strong>{policy.id}</strong>: {policy.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ingestion and retrieval reference will appear once loaded.
            </p>
          )}
        </TabsContent>

        <TabsContent value="metrics" className="space-y-4">
          {doc ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>
                    Paired Comparison &amp; Resampling Rules
                  </CardTitle>
                  <CardDescription>
                    Prompt {doc.evaluation.promptVersion} · Retrieval{' '}
                    {doc.evaluation.retrievalMetricVersion} · Abstention{' '}
                    {doc.evaluation.abstentionMetricVersion}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <p>{doc.evaluation.comparisonRule}</p>
                  <p>
                    <strong className="text-foreground">
                      Bootstrap interval:
                    </strong>{' '}
                    {doc.evaluation.resamplingRule.description}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    Shipped Metric Definitions &amp; Rubrics
                  </CardTitle>
                  <CardDescription>
                    Derived directly from{' '}
                    <code>backend/src/evaluation/metrics.ts</code> and versioned
                    JSON rubric files.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {(['retrieval', 'judge', 'abstention'] as const).map(
                    (category) => {
                      const group = doc.evaluation.metrics.filter(
                        (m) => m.category === category,
                      );
                      return (
                        <div key={category} className="space-y-2">
                          <h3 className="text-base font-semibold capitalize">
                            {category} metrics
                          </h3>
                          <div className="space-y-2">
                            {group.map((metric) => (
                              <div
                                key={metric.metricId}
                                className="rounded-lg border p-3 text-sm space-y-1.5"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <strong>{metric.displayLabel}</strong>
                                  <Badge variant="outline">
                                    {metric.version}
                                  </Badge>
                                  <Badge variant="secondary">
                                    Unit: {metric.evaluationUnit}
                                  </Badge>
                                  {metric.rubricHash && (
                                    <span className="text-xs font-mono text-muted-foreground">
                                      sha256:{metric.rubricHash.slice(0, 12)}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {metric.description}
                                </p>
                                <div className="text-xs">
                                  <strong>Formula:</strong>{' '}
                                  <code>{metric.formula}</code>
                                </div>
                                {metric.anchors && (
                                  <div className="text-xs text-muted-foreground">
                                    <strong>Scale anchors:</strong>{' '}
                                    {Object.entries(metric.anchors)
                                      .map(([k, v]) => `${k} = ${v}`)
                                      .join(' · ')}
                                  </div>
                                )}
                                {metric.passPolicy && (
                                  <div className="text-xs text-muted-foreground">
                                    <strong>
                                      Pass policy ({metric.passPolicy.version}):
                                    </strong>{' '}
                                    score &gt;= {metric.passPolicy.minScore},
                                    critical contradiction forbidden:{' '}
                                    {String(
                                      metric.passPolicy
                                        .forbidCriticalContradiction,
                                    )}
                                    , acceptance criteria required:{' '}
                                    {String(
                                      metric.passPolicy
                                        .requireAcceptanceCriteria,
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    },
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Metric and rubric definitions will appear once loaded.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
