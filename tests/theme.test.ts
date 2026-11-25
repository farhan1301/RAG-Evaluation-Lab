import { expect, it } from 'vitest';
import { parseTheme, resolveTheme } from '../frontend/src/lib/theme';

it('defaults to the system preference for absent or unknown stored values', () => {
  for (const stored of [null, '', 'system', 'invalid']) {
    expect(parseTheme(stored)).toBe('system');
  }
  expect(resolveTheme('system', false)).toBe('light');
  expect(resolveTheme('system', true)).toBe('dark');
});

it.each(['light', 'dark'] as const)(
  'restores the explicit %s preference in either system theme',
  (preference) => {
    expect(parseTheme(preference)).toBe(preference);
    expect(resolveTheme(preference, true)).toBe(preference);
    expect(resolveTheme(preference, false)).toBe(preference);
  },
);
