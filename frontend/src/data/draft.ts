import { useState } from 'react';
import { z } from '@rag-eval/contracts';

// Editors mount with a resource-specific key. Always retain the revision at first edit.
export function recoverDraft<T>(raw: string | null, schema: z.ZodType<T>) {
  if (!raw) return null;
  try {
    return z
      .strictObject({ revision: z.int().nonnegative(), value: schema })
      .parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
export function useDraft<T>(
  key: string,
  revision: number,
  saved: T,
  schema: z.ZodType<T>,
) {
  const storageKey = `rag-eval.draft.v1.${key}`;
  const [draft, setDraft] = useState(() => {
    try {
      return recoverDraft(localStorage.getItem(storageKey), schema);
    } catch {
      return null;
    }
  });
  const [storageError, setStorageError] = useState(false);
  function change(value: T) {
    const next = { revision: draft?.revision ?? revision, value };
    setDraft(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }
  function discard() {
    setDraft(null);
    try {
      localStorage.removeItem(storageKey);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }
  return {
    value: draft?.value ?? saved,
    revision: draft?.revision ?? revision,
    dirty: !!draft,
    stale: !!draft && draft.revision !== revision,
    change,
    discard,
    storageError,
  };
}
