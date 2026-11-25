import * as c from '@rag-eval/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  useCapabilities,
  useList,
  useSelection,
  useWrite,
  request,
  pipelineQuery,
} from '../data/workspace';
import { useDraft } from '../data/draft';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { EditorActions } from './EditorActions';

// Keep incomplete numeric edits recoverable. Saving still uses the strict wire contract.
const form = c.pipelineInput.extend({
  name: c.z.string(),
  config: c.pipelineConfig.extend({
    chunking: c.pipelineConfig.shape.chunking
      .unwrap()
      .extend({ chunkSize: c.z.number(), overlap: c.z.number() }),
    retriever: c.pipelineConfig.shape.retriever
      .unwrap()
      .extend({ topK: c.z.number() }),
    llm: c.pipelineConfig.shape.llm
      .unwrap()
      .extend({ temperature: c.z.number(), maxTokens: c.z.number() }),
  }),
});
function PipelineEditor({
  saved,
  profiles,
  baseline,
  setBaseline,
}: {
  saved: c.SavedPipeline;
  profiles: c.Capabilities['profiles'];
  baseline: boolean;
  setBaseline: () => void;
}) {
  const write = useWrite('pipelines');
  const draft = useDraft(
    saved.id,
    saved.revision,
    { name: saved.name, description: saved.description, config: saved.config },
    form,
  );
  const { name, description, config } = draft.value;
  const update = (changes: Partial<c.PipelineConfig>) =>
    draft.change({ ...draft.value, config: { ...config, ...changes } });
  const path = `pipelines/${saved.id}`;
  const answerProfile = profiles.find(
    (p) =>
      p.role === 'chat' && (!config.llm.model || p.model === config.llm.model),
  );
  const fixedTemperature =
    answerProfile && !answerProfile.options.includes('temperature');
  const maxTemperature = fixedTemperature
    ? 1
    : (answerProfile?.capabilities.maxTemperature ?? 2);
  const selectProfile = (
    role: c.Role,
    stage: 'llm' | 'judge' | 'embedding',
  ) => (
    <label className="block">
      {role === 'chat'
        ? 'Answer model'
        : role === 'judge'
          ? 'Judge model'
          : 'Embedding model'}
      <select
        className="block rounded border p-2"
        value={config[stage].model}
        onChange={(e) => {
          const model = e.target.value,
            selected = profiles.find(
              (p) => p.role === role && (!model || p.model === model),
            );
          update({
            [stage]: {
              ...config[stage],
              model,
              ...(stage === 'llm' &&
                selected &&
                !selected.options.includes('temperature') && {
                  temperature: 1,
                }),
            },
          });
        }}
      >
        <option value="">
          Server default (
          {profiles.find((p) => p.role === role)?.model ?? 'unconfigured'})
        </option>
        {profiles
          .filter((p) => p.role === role)
          .map((p) => (
            <option key={p.name} value={p.model}>
              {p.name}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{saved.name}</CardTitle>
        <p>
          Revision {saved.revision}
          {baseline && ' · Baseline'}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset disabled={write.isPending} className="space-y-3">
          <label htmlFor={`${saved.id}-pipeline-name`} className="block">
            Pipeline name
            <Input
              id={`${saved.id}-pipeline-name`}
              value={name}
              onChange={(e) =>
                draft.change({ ...draft.value, name: e.target.value })
              }
            />
          </label>
          <label htmlFor={`${saved.id}-description`} className="block">
            Description
            <Input
              id={`${saved.id}-description`}
              value={description}
              onChange={(e) =>
                draft.change({ ...draft.value, description: e.target.value })
              }
            />
          </label>
          <details open>
            <summary>Parsing and chunking</summary>
            <div className="space-y-2 p-2">
              <p>Choose the document parser on the Datasets page.</p>
              <label>
                Chunking strategy{' '}
                <select
                  value={config.chunking.strategy}
                  onChange={(e) =>
                    update({
                      chunking: {
                        ...config.chunking,
                        strategy: c.pipelineConfig.shape.chunking
                          .unwrap()
                          .shape.strategy.parse(e.target.value),
                      },
                    })
                  }
                >
                  <option value="character-window">Character window</option>
                  <option value="sentence-packed">Sentence packed</option>
                  <option value="heading-aware">Heading aware</option>
                  <option value="table-aware">Table aware</option>
                </select>
              </label>
              <label
                htmlFor={`${saved.id}-chunk-size-tokens`}
                className="block"
              >
                Chunk size (characters)
                <Input
                  id={`${saved.id}-chunk-size-tokens`}
                  type="number"
                  min={100}
                  max={1000}
                  value={config.chunking.chunkSize}
                  onChange={(e) =>
                    update({
                      chunking: {
                        ...config.chunking,
                        chunkSize: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label htmlFor={`${saved.id}-overlap`} className="block">
                Overlap (characters)
                <Input
                  id={`${saved.id}-overlap`}
                  type="number"
                  min={0}
                  max={50}
                  value={config.chunking.overlap}
                  onChange={(e) =>
                    update({
                      chunking: {
                        ...config.chunking,
                        overlap: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
            </div>
          </details>
          <details open>
            <summary>Embedding and retrieval</summary>
            <div className="space-y-2 p-2">
              {selectProfile('embedding', 'embedding')}
              <label htmlFor={`${saved.id}-top-k-results`} className="block">
                Top-K results
                <Input
                  id={`${saved.id}-top-k-results`}
                  type="number"
                  min={1}
                  max={20}
                  value={config.retriever.topK}
                  onChange={(e) =>
                    update({
                      retriever: {
                        ...config.retriever,
                        topK: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <p className="text-sm">
                The current runner uses Qdrant dense retrieval. Reranking is
                unavailable.
              </p>
            </div>
          </details>
          <details>
            <summary>Answer generation and judging</summary>
            <div className="space-y-2 p-2">
              {selectProfile('chat', 'llm')}
              {selectProfile('judge', 'judge')}
              <label htmlFor={`${saved.id}-temperature`} className="block">
                Temperature{fixedTemperature && ' (this profile requires 1)'}
                <Input
                  id={`${saved.id}-temperature`}
                  type="number"
                  disabled={fixedTemperature && config.llm.temperature === 1}
                  min={fixedTemperature ? 1 : 0}
                  max={maxTemperature}
                  step={0.1}
                  value={config.llm.temperature}
                  onChange={(e) =>
                    update({
                      llm: {
                        ...config.llm,
                        temperature: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label
                htmlFor={`${saved.id}-maximum-answer-tokens`}
                className="block"
              >
                Maximum answer tokens
                <Input
                  id={`${saved.id}-maximum-answer-tokens`}
                  type="number"
                  min={1}
                  max={32768}
                  value={config.llm.maxTokens}
                  onChange={(e) =>
                    update({
                      llm: { ...config.llm, maxTokens: Number(e.target.value) },
                    })
                  }
                />
              </label>
            </div>
          </details>
        </fieldset>
        <EditorActions
          draft={draft}
          pending={write.isPending}
          save={() =>
            write.mutate(
              () =>
                request(c.pipeline, path, 'PATCH', draft.value, draft.revision),
              { onSuccess: draft.discard },
            )
          }
        />
        <div className="flex flex-wrap gap-2">
          {!baseline && (
            <Button variant="outline" onClick={setBaseline}>
              Set as baseline
            </Button>
          )}
          <Button
            variant="outline"
            disabled={write.isPending || draft.dirty}
            onClick={() =>
              write.mutate(() =>
                request(
                  c.pipeline,
                  `${path}/copies`,
                  'POST',
                  {},
                  saved.revision,
                ),
              )
            }
          >
            Duplicate pipeline
          </Button>
          <Button
            variant="outline"
            disabled={write.isPending || draft.dirty}
            onClick={() =>
              write.mutate(() =>
                request(
                  c.z.undefined(),
                  path,
                  'DELETE',
                  undefined,
                  saved.revision,
                ),
              )
            }
          >
            Archive pipeline
          </Button>
        </div>
        {write.error && <p role="alert">{write.error.message}</p>}
      </CardContent>
    </Card>
  );
}
function PipelineCard({
  id,
  ...props
}: {
  id: string;
  profiles: c.Capabilities['profiles'];
  baseline: boolean;
  setBaseline: () => void;
}) {
  const detail = useQuery(pipelineQuery(id));
  if (!detail.data)
    return <p role="status">{detail.error?.message ?? 'Loading pipeline…'}</p>;
  return <PipelineEditor saved={detail.data} {...props} />;
}
export function PipelinesPage() {
  const list = useList('pipelines'),
    capabilities = useCapabilities(),
    write = useWrite('pipelines');
  const [baseline, select] = useSelection('rag-eval.baseline', list.data);
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:p-8">
      <h1>Pipeline Configuration</h1>
      <Button
        disabled={write.isPending || !list.data}
        onClick={() =>
          write.mutate(() =>
            request(c.pipeline, 'pipelines', 'POST', {
              name: list.data?.length
                ? 'New configuration'
                : 'Baseline configuration',
            }),
          )
        }
      >
        Add pipeline
      </Button>
      {(write.error || list.error || capabilities.error) && (
        <p role="alert">
          {(write.error ?? list.error ?? capabilities.error)?.message}
        </p>
      )}
      {list.isPending && <p role="status">Loading pipelines…</p>}
      {list.data?.length === 0 && (
        <p>Create a pipeline to configure retrieval and generation.</p>
      )}
      <div className="grid items-start gap-4 md:grid-cols-2">
        {list.data?.map((p) => (
          <PipelineCard
            key={p.id}
            id={p.id}
            profiles={capabilities.data?.profiles ?? []}
            baseline={baseline === p.id}
            setBaseline={() => select(p.id)}
          />
        ))}
      </div>
      {!!list.data?.length && (
        <Button asChild>
          <Link to="/experiments">Proceed to experiments</Link>
        </Button>
      )}
    </div>
  );
}
