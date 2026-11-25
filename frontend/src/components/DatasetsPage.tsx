import * as c from '@rag-eval/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { useDatasetSelection, request, useWrite } from '../data/workspace';
import { useDraft } from '../data/draft';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCapabilities } from '../data/workspace';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { EditorActions } from './EditorActions';

function LabelEditor({ dataset, task }: { dataset: c.Dataset; task: c.Task }) {
  const draft = useDraft(
    `labels.${task.id}`,
    dataset.revision,
    { pool: task.pool, qrels: task.qrels },
    c.replaceLabels,
  );
  const write = useWrite('datasets');
  return (
    <details>
      <summary>Gold documents and relevance grades</summary>
      <fieldset disabled={write.isPending} className="space-y-2 py-2">
        <label>
          Labeling pool{' '}
          <select
            value={draft.value.pool}
            onChange={(e) =>
              draft.change({
                ...draft.value,
                pool: e.target.value === 'complete' ? 'complete' : 'partial',
              })
            }
          >
            <option value="partial">Partial</option>
            <option value="complete">Complete</option>
          </select>
        </label>
        {dataset.documents.map((doc) => (
          <label key={doc.id} className="block">
            {doc.name}{' '}
            <select
              value={
                draft.value.qrels.find((row) => row.documentId === doc.id)
                  ?.grade ?? ''
              }
              onChange={(e) => {
                const qrels = draft.value.qrels.filter(
                  (row) => row.documentId !== doc.id,
                );
                if (e.target.value !== '')
                  qrels.push({
                    documentId: doc.id,
                    grade: Number(e.target.value),
                  });
                draft.change({ ...draft.value, qrels });
              }}
            >
              <option value="">Unjudged</option>
              {[0, 1, 2, 3].map((grade) => (
                <option key={grade} value={grade}>
                  {grade}
                </option>
              ))}
            </select>
          </label>
        ))}
        <EditorActions
          draft={draft}
          pending={write.isPending}
          label="Save grades"
          save={() =>
            write.mutate(
              () =>
                request(
                  c.dataset,
                  `tasks/${task.id}/qrels`,
                  'PUT',
                  draft.value,
                  draft.revision,
                ),
              { onSuccess: draft.discard },
            )
          }
        />
      </fieldset>
      {write.error && <p role="alert">{write.error.message}</p>}
    </details>
  );
}
const taskForm = c.z.strictObject({
  question: c.z.string(),
  expectedAnswer: c.z.string(),
  acceptanceRule: c.z.string(),
  facts: c.z.string(),
  answerable: c.z.boolean(),
});
function TaskEditor({ dataset, task }: { dataset: c.Dataset; task?: c.Task }) {
  const write = useWrite('datasets');
  const draft = useDraft(
    `task.${task?.id ?? `new.${dataset.id}`}`,
    dataset.revision,
    {
      question: task?.question ?? '',
      expectedAnswer: task?.expectedAnswer ?? '',
      acceptanceRule: task?.acceptanceRule ?? '',
      facts: task?.referenceFacts.join('\n') ?? '',
      answerable: task?.answerable ?? true,
    },
    taskForm,
  );
  const path = `datasets/${dataset.id}/tasks${task ? `/${task.id}` : ''}`;
  function save() {
    const { facts, ...fields } = draft.value;
    write.mutate(
      () =>
        request(
          c.dataset,
          path,
          task ? 'PATCH' : 'POST',
          {
            ...fields,
            referenceFacts: facts
              .split('\n')
              .map((f) => f.trim())
              .filter(Boolean),
          },
          draft.revision,
        ),
      { onSuccess: draft.discard },
    );
  }
  return (
    <div className="space-y-3 rounded border p-4">
      <fieldset className="space-y-2" disabled={write.isPending}>
        <label htmlFor={`${task?.id ?? dataset.id}-question`} className="block">
          Question
          <Textarea
            id={`${task?.id ?? dataset.id}-question`}
            value={draft.value.question}
            onChange={(e) =>
              draft.change({ ...draft.value, question: e.target.value })
            }
          />
        </label>
        <label
          htmlFor={`${task?.id ?? dataset.id}-expected-answer`}
          className="block"
        >
          Expected answer
          <Input
            id={`${task?.id ?? dataset.id}-expected-answer`}
            value={draft.value.expectedAnswer}
            onChange={(e) =>
              draft.change({ ...draft.value, expectedAnswer: e.target.value })
            }
          />
        </label>
        <label
          htmlFor={`${task?.id ?? dataset.id}-acceptance-criteria`}
          className="block"
        >
          Acceptance criteria
          <Input
            id={`${task?.id ?? dataset.id}-acceptance-criteria`}
            value={draft.value.acceptanceRule}
            onChange={(e) =>
              draft.change({ ...draft.value, acceptanceRule: e.target.value })
            }
          />
        </label>
        <label
          htmlFor={`${task?.id ?? dataset.id}-reference-facts-one-per-line`}
          className="block"
        >
          Reference facts (one per line)
          <Textarea
            id={`${task?.id ?? dataset.id}-reference-facts-one-per-line`}
            value={draft.value.facts}
            onChange={(e) =>
              draft.change({ ...draft.value, facts: e.target.value })
            }
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.value.answerable}
            onChange={(e) =>
              draft.change({ ...draft.value, answerable: e.target.checked })
            }
          />
          Answerable from this dataset
        </label>
        <EditorActions
          draft={draft}
          pending={write.isPending}
          save={save}
          label={task ? 'Save question' : 'Add question'}
        />
        {task && (
          <Button
            variant="outline"
            size="sm"
            disabled={draft.dirty}
            onClick={() =>
              write.mutate(() =>
                request(c.dataset, path, 'DELETE', undefined, dataset.revision),
              )
            }
          >
            Remove question
          </Button>
        )}
      </fieldset>
      {write.error && <p role="alert">{write.error.message}</p>}
      {task && <LabelEditor task={task} dataset={dataset} />}
    </div>
  );
}

function DocumentProgress({
  dataset,
  doc,
  parser,
}: {
  dataset: c.Dataset;
  doc: c.SavedDocument;
  parser: c.Parser;
}) {
  const cache = useQueryClient(),
    write = useWrite('datasets');
  const [open, setOpen] = useState(false);
  const status = useQuery({
    queryKey: ['jobs', doc.jobId],
    enabled: !!doc.jobId,
    queryFn: () => request(c.job, `jobs/${doc.jobId}`),
    refetchInterval: (q) =>
      q.state.data &&
      ['failed', 'cancelled', 'succeeded'].includes(q.state.data.state)
        ? false
        : 1500,
  });
  const job = status.data;
  const preview = useQuery({
    queryKey: ['preview', doc.versionId, doc.jobId],
    enabled: open && (!doc.jobId || job?.state === 'succeeded'),
    queryFn: () =>
      request(
        c.document,
        `datasets/${dataset.id}/documents/${doc.id}?revision=${dataset.revision}&preview=true`,
      ),
  });
  function action(path: string, body: unknown) {
    write.mutate(async () => {
      const next = await request(
        c.job,
        path,
        'POST',
        body,
        dataset.revision,
        crypto.randomUUID(),
      );
      cache.setQueryData(['jobs', next.id], next);
      await cache.invalidateQueries({
        queryKey: ['runner-document', doc.versionId],
      });
      return request(c.dataset, `datasets/${dataset.id}`);
    });
  }
  return (
    <div className="space-y-1">
      {doc.jobId && status.isPending && (
        <p role="status">Loading parse status…</p>
      )}
      {job && (
        <p role="status">
          {job.parser} · {job.state.replaceAll('_', ' ')} · {job.stage} ·
          attempt {job.attempt}
          {job.message && ` · ${job.message}`}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {doc.jobId &&
          (!job ||
            !['failed', 'cancelled', 'succeeded'].includes(job.state)) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={status.isFetching}
              onClick={() => void status.refetch()}
            >
              Refresh status
            </Button>
          )}
        {job && ['queued', 'running'].includes(job.state) && (
          <Button
            size="sm"
            disabled={write.isPending}
            onClick={() => action(`jobs/${job.id}/cancel`, {})}
          >
            Cancel parsing
          </Button>
        )}
        {job && ['failed', 'cancelled'].includes(job.state) && (
          <Button
            size="sm"
            disabled={write.isPending}
            onClick={() => action(`jobs/${job.id}/retry`, {})}
          >
            Retry {job.parser} parse
          </Button>
        )}
        {(!doc.jobId ||
          (job &&
            ['failed', 'cancelled', 'succeeded'].includes(job.state))) && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={write.isPending}
              onClick={() => action(`documents/${doc.id}/parses`, { parser })}
            >
              Parse with {parser}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!doc.jobId && job?.state !== 'succeeded'}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Hide' : 'Preview'} extracted text
            </Button>
          </>
        )}
      </div>
      {open && preview.isPending && <p role="status">Loading preview…</p>}
      {open && preview.data && (
        <pre className="whitespace-pre-wrap">
          {preview.data.content || 'Choose a parser to extract text.'}
        </pre>
      )}
      {(status.error || write.error || preview.error) && (
        <p role="alert">
          {(status.error ?? write.error ?? preview.error)?.message}
        </p>
      )}
    </div>
  );
}

function Documents({ dataset }: { dataset: c.Dataset }) {
  const write = useWrite('datasets'),
    capabilities = useCapabilities(),
    path = `datasets/${dataset.id}/documents`;
  const [parser, setParser] = useState<c.Parser>('local');
  const [uploading, setUploading] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Document Upload</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <label>
          Parser{' '}
          <select
            value={parser}
            disabled={write.isPending}
            onChange={(e) => setParser(c.parser.parse(e.target.value))}
          >
            <option value="local">Local TXT, Markdown or text PDF</option>
            <option
              value="llama-parse"
              disabled={!capabilities.data?.cloudParser}
            >
              LlamaParse cloud (also supports DOCX)
            </option>
          </select>
        </label>
        {parser === 'llama-parse' && (
          <p>
            Parsing sends the original document to LlamaParse and may incur a
            provider charge.
          </p>
        )}
        {uploading && <p role="status">Uploading {uploading}…</p>}
        <label
          htmlFor={`${dataset.id}-choose-a-document-for-the-runner`}
          className="block"
        >
          Choose a document for the runner
          <Input
            id={`${dataset.id}-choose-a-document-for-the-runner`}
            type="file"
            accept=".txt,.md,.markdown,.pdf,.docx"
            disabled={write.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setUploading(file.name);
              write.mutate(
                async () => {
                  const query = new URLSearchParams({
                    name: file.name,
                    parser,
                  });
                  const result = await request(
                    c.uploadResult,
                    `${path}?${query}`,
                    'POST',
                    file,
                    dataset.revision,
                    crypto.randomUUID(),
                  );
                  return result.dataset;
                },
                { onSettled: () => setUploading('') },
              );
            }}
          />
        </label>
        {dataset.documents.map((doc) => (
          <div
            className="flex flex-wrap items-center justify-between gap-2"
            key={doc.id}
          >
            <span>
              {doc.name} · {doc.size} bytes
            </span>
            <DocumentProgress dataset={dataset} doc={doc} parser={parser} />
            <Button
              size="sm"
              variant="outline"
              disabled={write.isPending}
              onClick={() =>
                write.mutate(() =>
                  request(
                    c.dataset,
                    `${path}/${doc.id}`,
                    'DELETE',
                    undefined,
                    dataset.revision,
                  ),
                )
              }
            >
              Remove {doc.name}
            </Button>
          </div>
        ))}
        {write.error && <p role="alert">{write.error.message}</p>}
      </CardContent>
    </Card>
  );
}

function CsvImport({ dataset }: { dataset: c.Dataset }) {
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<
    (c.z.infer<typeof c.csvPreview> & { revision: number; csv: string }) | null
  >(null);
  const write = useWrite('datasets');
  return (
    <div className="space-y-2">
      <label
        htmlFor={`${dataset.id}-import-questions-from-csv`}
        className="block"
      >
        Import questions from CSV
        <Input
          id={`${dataset.id}-import-questions-from-csv`}
          type="file"
          accept=".csv"
          disabled={write.isPending || reading}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setPreview(null);
            setError('');
            setReading(true);
            try {
              if (file.size > 16 * 1024 * 1024)
                throw new Error('CSV exceeds the request size limit.');
              const csv = await file.text();
              setPreview({
                ...(await request(
                  c.csvPreview,
                  `datasets/${dataset.id}/task-imports`,
                  'POST',
                  { mode: 'preview', csv },
                  dataset.revision,
                )),
                csv,
                revision: dataset.revision,
              });
            } catch (err) {
              setError(
                err instanceof Error ? err.message : 'Invalid CSV file.',
              );
            } finally {
              setReading(false);
            }
          }}
        />
      </label>
      {preview && (
        <div>
          <p>
            Replace the current questions with {preview.tasks.length} imported
            rows.
          </p>
          <details>
            <summary>Preview imported questions</summary>
            <pre className="whitespace-pre-wrap">
              {preview.tasks
                .map(
                  (row, index) =>
                    `${index + 1}. ${row.question}
${row.expectedAnswer}
${row.acceptanceRule}`,
                )
                .join('\n\n')}
            </pre>
          </details>
          {preview.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
          <Button
            variant="outline"
            disabled={write.isPending || reading}
            onClick={() =>
              write.mutate(
                () =>
                  request(
                    c.dataset,
                    `datasets/${dataset.id}/task-imports`,
                    'POST',
                    { mode: 'commit', csv: preview.csv },
                    preview.revision,
                  ),
                { onSuccess: () => setPreview(null) },
              )
            }
          >
            Confirm replacement
          </Button>
          <Button
            variant="ghost"
            disabled={write.isPending || reading}
            onClick={() => setPreview(null)}
          >
            Cancel import
          </Button>
        </div>
      )}
      {(error || write.error) && (
        <p role="alert">{error || write.error?.message}</p>
      )}
    </div>
  );
}
function DatasetEditor({ dataset }: { dataset: c.Dataset }) {
  const write = useWrite('datasets'),
    path = `datasets/${dataset.id}`;
  const draft = useDraft(
    `name.${dataset.id}`,
    dataset.revision,
    dataset.name,
    c.z.string(),
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{dataset.name}</CardTitle>
          <p>Revision {dataset.revision}</p>
        </CardHeader>
        <CardContent className="space-y-2">
          <label htmlFor={`${dataset.id}-dataset-name`} className="block">
            Dataset name
            <Input
              id={`${dataset.id}-dataset-name`}
              disabled={write.isPending}
              value={draft.value}
              onChange={(e) => draft.change(e.target.value)}
            />
          </label>
          <EditorActions
            draft={draft}
            pending={write.isPending}
            save={() =>
              write.mutate(
                () =>
                  request(
                    c.dataset,
                    path,
                    'PATCH',
                    { name: draft.value },
                    draft.revision,
                  ),
                { onSuccess: draft.discard },
              )
            }
          />
          <Button
            variant="outline"
            size="sm"
            disabled={write.isPending || draft.dirty}
            onClick={() =>
              write.mutate(() =>
                request(
                  c.z.undefined(),
                  path,
                  'DELETE',
                  undefined,
                  dataset.revision,
                ),
              )
            }
          >
            Archive dataset
          </Button>
          {write.error && <p role="alert">{write.error.message}</p>}
        </CardContent>
      </Card>
      <Documents dataset={dataset} />
      <Card>
        <CardHeader>
          <CardTitle>Evaluation questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <CsvImport dataset={dataset} />
          {dataset.tasks.map((task) => (
            <details key={task.id}>
              <summary>{task.question}</summary>
              <TaskEditor dataset={dataset} task={task} />
            </details>
          ))}
          <h3>New question</h3>
          <TaskEditor dataset={dataset} />
        </CardContent>
      </Card>
      {!!dataset.documents.length && !!dataset.tasks.length && (
        <Button asChild>
          <Link to="/pipelines">Proceed to pipeline setup</Link>
        </Button>
      )}
    </div>
  );
}
export function DatasetsPage() {
  const { id, list, detail, select } = useDatasetSelection(),
    write = useWrite('datasets');
  function create(sample: boolean) {
    write.mutate(
      () =>
        request(
          c.dataset,
          sample ? 'datasets/sample' : 'datasets',
          'POST',
          sample ? {} : { name: 'New dataset' },
        ),
      {
        onSuccess: (saved) => {
          if (saved) select(saved.id);
        },
      },
    );
  }
  return (
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:p-8">
      <h1>Datasets &amp; Tasks</h1>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={write.isPending} onClick={() => create(false)}>
          Create dataset
        </Button>
        <Button
          variant="outline"
          disabled={write.isPending}
          onClick={() => create(true)}
        >
          Load sample dataset
        </Button>
        {!!list.data?.length && (
          <label>
            Active dataset{' '}
            <select
              className="rounded border p-2"
              value={id}
              onChange={(e) => select(e.target.value)}
            >
              {list.data.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {(list.isPending || (id && detail.isPending)) && (
        <p role="status">Loading datasets…</p>
      )}
      {(list.error || detail.error || write.error) && (
        <p role="alert">
          {(list.error ?? detail.error ?? write.error)?.message}
        </p>
      )}
      {list.data?.length === 0 && (
        <p>Create a dataset or load the labeled RAG fundamentals sample.</p>
      )}
      {detail.data && (
        <DatasetEditor key={detail.data.id} dataset={detail.data} />
      )}
    </div>
  );
}
