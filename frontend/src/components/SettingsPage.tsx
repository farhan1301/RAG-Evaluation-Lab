import { useOutletContext } from 'react-router';
import { useCapabilities } from '../data/workspace';
import type { useTheme } from '../lib/theme';
import { Badge } from './ui/badge';
import { Label } from './ui/label';

export function SettingsPage() {
  const { preference, changeTheme } =
    useOutletContext<ReturnType<typeof useTheme>>();
  const capabilities = useCapabilities();

  return (
    <section className="page max-w-3xl space-y-6">
      <h1>Settings</h1>
      <fieldset className="rounded-xl border bg-card p-5">
        <legend className="px-2 font-semibold">Appearance</legend>
        <p className="mb-4 text-muted-foreground">
          System follows your device’s color scheme.
        </p>
        <div className="flex flex-wrap gap-3">
          {(['system', 'light', 'dark'] as const).map((value) => (
            <Label
              key={value}
              htmlFor={`theme-${value}`}
              className="cursor-pointer rounded-lg border px-4 py-3 capitalize"
            >
              <input
                id={`theme-${value}`}
                type="radio"
                name="theme"
                value={value}
                checked={preference === value}
                onChange={() => changeTheme(value)}
                className="accent-primary"
              />
              {value}
            </Label>
          ))}
        </div>
      </fieldset>

      <section
        aria-labelledby="provider-capabilities-heading"
        className="rounded-xl border bg-card p-5 space-y-4"
      >
        <div>
          <h2 id="provider-capabilities-heading" className="text-lg">
            Server provider capabilities
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            API keys and provider endpoints are configured on the backend only
            and are never stored in the browser.
          </p>
        </div>

        {capabilities.isPending && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading server capabilities…
          </p>
        )}

        {capabilities.error && (
          <p role="alert" className="text-sm text-destructive">
            {capabilities.error.message}
          </p>
        )}

        {capabilities.data && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge
                variant={
                  capabilities.data.workerOnline ? 'default' : 'secondary'
                }
              >
                Worker: {capabilities.data.workerOnline ? 'online' : 'offline'}
              </Badge>
              <Badge
                variant={capabilities.data.denseStore ? 'default' : 'outline'}
              >
                Qdrant dense store:{' '}
                {capabilities.data.denseStore ? 'ready' : 'not configured'}
              </Badge>
              <Badge
                variant={capabilities.data.cloudParser ? 'default' : 'outline'}
              >
                LlamaParse cloud parser:{' '}
                {capabilities.data.cloudParser ? 'ready' : 'not configured'}
              </Badge>
            </div>

            {capabilities.data.profiles.length > 0 ? (
              <ul className="space-y-2">
                {capabilities.data.profiles.map((profile) => (
                  <li
                    key={`${profile.role}-${profile.model}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                  >
                    <div>
                      <span className="font-medium capitalize">
                        {profile.role}:
                      </span>{' '}
                      <span>{profile.model}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({profile.provider})
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {profile.options.map((opt) => (
                        <Badge key={opt} variant="secondary">
                          {opt}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">
                No model profiles configured. Keyword retrieval works offline
                with zero API keys.
              </p>
            )}
          </div>
        )}
      </section>
    </section>
  );
}
