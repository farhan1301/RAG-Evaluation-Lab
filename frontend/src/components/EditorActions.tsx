import { Button } from './ui/button';

export function EditorActions({
  draft,
  pending,
  save,
  label = 'Save changes',
}: {
  draft: {
    dirty: boolean;
    stale: boolean;
    revision: number;
    storageError: boolean;
    discard: () => void;
  };
  pending: boolean;
  save: () => void;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={!draft.dirty || pending || draft.stale}
        onClick={save}
      >
        {label}
      </Button>
      {draft.dirty && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={draft.discard}
        >
          {draft.stale ? 'Discard draft and load latest' : 'Discard draft'}
        </Button>
      )}
      {draft.stale && (
        <p role="alert">
          Your draft is based on revision {draft.revision}. A newer revision is
          saved.
        </p>
      )}
      {draft.dirty && !draft.stale && (
        <span className="text-sm text-muted-foreground" role="status">
          {draft.storageError
            ? 'Draft is available in this tab only.'
            : 'Draft saved in this browser.'}
        </span>
      )}
    </div>
  );
}
