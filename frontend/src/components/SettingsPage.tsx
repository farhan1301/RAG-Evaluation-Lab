import { useOutletContext } from 'react-router';
import type { useTheme } from '../lib/theme';
import { Label } from './ui/label';

export function SettingsPage() {
  const { preference, changeTheme } =
    useOutletContext<ReturnType<typeof useTheme>>();
  return (
    <section className="page max-w-3xl">
      <h1>Settings</h1>
      <fieldset className="mt-6 rounded-xl border bg-card p-5">
        <legend className="px-2 font-semibold">Appearance</legend>
        <p className="mb-4 text-muted-foreground">
          System follows your device’s color scheme.
        </p>
        <div className="flex flex-wrap gap-3">
          {(['system', 'light', 'dark'] as const).map((value) => (
            <Label
              key={value}
              className="cursor-pointer rounded-lg border px-4 py-3 capitalize"
            >
              <input
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
    </section>
  );
}
