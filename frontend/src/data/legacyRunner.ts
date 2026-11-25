import { document as savedDocument } from '@rag-eval/contracts';
import { useQueries } from '@tanstack/react-query';
import type { DatasetDocument } from '../types/dataset';
import {
  request,
  pipelineQuery,
  useDatasetSelection,
  useList,
  useCapabilities,
  useSelection,
} from './workspace';

// Read-only bridge for the browser runner. Remove when experiments submit frozen runs.
export function useRunnerInputs() {
  const { detail, list: datasets } = useDatasetSelection();
  const list = useList('pipelines'),
    capabilities = useCapabilities();
  const [baseline] = useSelection('rag-eval.baseline', list.data);
  const details = useQueries({
    queries: (list.data ?? []).map((p) => pipelineQuery(p.id)),
  });
  const profiles = capabilities.data?.profiles ?? [];
  const pipelines = details.flatMap(({ data: p }) =>
    p
      ? [
          {
            ...p.config,
            id: p.id,
            name: p.name,
            isBaseline: p.id === baseline,
            embedding: {
              model:
                p.config.embedding.model ||
                profiles.find((p) => p.role === 'embedding')?.model ||
                '',
            },
            llm: {
              ...p.config.llm,
              model:
                p.config.llm.model ||
                profiles.find((p) => p.role === 'chat')?.model ||
                '',
            },
            judge: {
              model:
                p.config.judge.model ||
                profiles.find((p) => p.role === 'judge')?.model ||
                '',
            },
          },
        ]
      : [],
  );
  const dataset = detail.data;
  const files = useQueries({
    queries: dataset
      ? dataset.documents.map((doc) => ({
          queryKey: ['runner-document', doc.versionId],
          queryFn: () =>
            request(
              savedDocument,
              `datasets/${dataset.id}/documents/${doc.id}?revision=${dataset.revision}`,
            ),
          staleTime: Infinity,
        }))
      : [],
  });
  const documents: DatasetDocument[] = files.flatMap(({ data }) =>
    data ? [{ ...data, status: 'complete', progress: 100, snippet: '' }] : [],
  );
  let unavailable = '';
  if (
    datasets.error ||
    detail.error ||
    list.error ||
    capabilities.error ||
    [...details, ...files].some((q) => q.error)
  )
    unavailable = 'Could not load the saved runner inputs.';
  else if (
    datasets.isPending ||
    list.isPending ||
    capabilities.isPending ||
    (!!detail.isEnabled && detail.isPending) ||
    [...details, ...files].some((q) => q.isPending)
  )
    unavailable = 'Loading saved runner inputs…';
  else if (!pipelines.length)
    unavailable = 'Save a pipeline before running an experiment.';
  else if (
    !capabilities.data?.denseStore ||
    ['embedding', 'chat', 'judge'].some(
      (role) => !profiles.some((p) => p.role === role),
    )
  )
    unavailable =
      'Configure Qdrant and embedding, answer, and judge profiles to use the current runner.';
  else if (
    !capabilities.data.cloudParser &&
    documents.some((d) => d.fileBase64)
  )
    unavailable = 'Configure LlamaParse to run with uploaded files.';
  return { documents, tasks: detail.data?.tasks ?? [], pipelines, unavailable };
}
