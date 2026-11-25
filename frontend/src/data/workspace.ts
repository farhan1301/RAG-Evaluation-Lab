import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import * as c from '@rag-eval/contracts';

export class RemoteError extends Error {
  constructor(
    readonly code: c.ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  schema: c.z.ZodType<T>,
  path: string,
  method = 'GET',
  body?: unknown,
  revision?: number,
  key?: string,
): Promise<T> {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': body instanceof Blob ? body.type || 'application/octet-stream' : 'application/json' }),
      ...(key && {'Idempotency-Key':key}),
      ...(revision !== undefined && { 'If-Match': `"${revision}"` }),
    },
    body: body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = c.errorEnvelope.safeParse(
      await response.json().catch(() => null),
    );
    if (!result.success)
      throw new Error(`Request failed (${response.status}).`);
    const { code, message, fields } = result.data.error;
    throw new RemoteError(
      code,
      fields?.length
        ? fields.map((f) => `${f.path} ${f.message}`).join('. ')
        : message,
    );
  }
  return schema.parse(
    response.status === 204 ? undefined : await response.json(),
  );
}
export type Kind = 'datasets' | 'pipelines';
export const listKey = (kind: Kind) => [kind, 'list'] as const;
export function useList(kind: Kind) {
  return useQuery({
    queryKey: listKey(kind),
    queryFn: async () => {
      const items: c.Summary[] = [];
      let cursor: string | null = null;
      do {
        const batch: { items: c.Summary[]; nextCursor: string | null } =
          await request(
            c.page(c.summary),
            `${kind}?limit=100${cursor ? `&cursor=${cursor}` : ''}`,
          );
        items.push(...batch.items);
        cursor = batch.nextCursor;
      } while (cursor);
      return items;
    },
  });
}
export function useSelection(key: string, items: c.Summary[] | undefined) {
  const [selected, setSelected] = useState(() => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const select = useCallback(
    (id: string) => {
      setSelected(id);
      try {
        localStorage.setItem(key, id);
      } catch {
        /* In-memory selection still works. */
      }
    },
    [key],
  );
  const active =
    items?.find((item) => item.id === selected)?.id ?? items?.[0]?.id;
  useEffect(() => {
    if (active && active !== selected) select(active);
  }, [active, selected, select]);
  return [active, select] as const;
}
export function useDatasetSelection() {
  const list = useList('datasets');
  const [id, select] = useSelection('rag-eval.dataset', list.data);
  const detail = useQuery({
    queryKey: ['datasets', id],
    queryFn: () => request(c.dataset, `datasets/${id}`),
    enabled: Boolean(id),
  });
  return { list, detail, select, id };
}
export const pipelineQuery = (id: string) => ({
  queryKey: ['pipelines', id],
  queryFn: () => request(c.pipeline, `pipelines/${id}`),
});
export const useCapabilities = () =>
  useQuery({
    queryKey: ['capabilities'],
    queryFn: () => request(c.capabilities, 'capabilities'),
  });

export function useWrite(kind: Kind) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: () => Promise<c.Dataset | c.SavedPipeline | undefined>,
    ) => action(),
    onSuccess: async (value) => {
      if (value) {
        const key = [kind, value.id];
        await cache.cancelQueries({ queryKey: key, exact: true });
        cache.setQueryData<c.Summary>(key, (old) =>
          old && old.revision > value.revision ? old : value,
        );
      }
      await cache.invalidateQueries({ queryKey: listKey(kind) });
    },
    onError: async (error) => {
      if (
        error instanceof RemoteError &&
        ['stale_revision', 'archived', 'not_found'].includes(error.code)
      )
        await cache.invalidateQueries({ queryKey: [kind] });
    },
  });
}
