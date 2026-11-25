import { useLayoutEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const storageKey = 'rag-eval-theme';

export function parseTheme(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean,
) {
  return preference === 'system'
    ? prefersDark
      ? 'dark'
      : 'light'
    : preference;
}

export function useTheme() {
  const [preference, setPreference] = useState(() => {
    try {
      return parseTheme(window.localStorage.getItem(storageKey));
    } catch {
      return 'system' as const;
    }
  });

  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        resolveTheme(preference, media.matches) === 'dark',
      );
    apply();
    if (preference === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [preference]);

  function changeTheme(next: ThemePreference) {
    setPreference(next);
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // The preference still applies to this tab when browser storage is unavailable.
    }
  }

  return { preference, changeTheme };
}
