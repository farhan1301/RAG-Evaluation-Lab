import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

const STORAGE_KEY = 'rag-eval-lab::settings';

const DEFAULT_SETTINGS = {
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini',
  cohereApiKey: '',
  anthropicApiKey: '',
};

export type SettingsState = typeof DEFAULT_SETTINGS;

interface SettingsContextValue {
  settings: SettingsState;
  updateSettings: (updates: Partial<SettingsState>) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

const safeParse = (value: string | null) => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const resolveEnvValue = (key: string) => {
  try {
    const env = typeof import.meta !== 'undefined' ? (import.meta as any).env ?? {} : {};
    const value = env?.[key];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
};

const normalizeSettings = (settings: Partial<SettingsState>): SettingsState => ({
  openaiApiKey: settings.openaiApiKey?.trim?.() ?? '',
  openaiModel: settings.openaiModel?.trim?.() || DEFAULT_SETTINGS.openaiModel,
  cohereApiKey: settings.cohereApiKey?.trim?.() ?? '',
  anthropicApiKey: settings.anthropicApiKey?.trim?.() ?? '',
});

const applySettingsToWindow = (settings: SettingsState) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (settings.openaiApiKey) {
    (window as any).__OPENAI_API_KEY__ = settings.openaiApiKey;
  } else {
    Reflect.deleteProperty(window as any, '__OPENAI_API_KEY__');
  }

  if (settings.openaiModel) {
    (window as any).__OPENAI_MODEL__ = settings.openaiModel;
  } else {
    Reflect.deleteProperty(window as any, '__OPENAI_MODEL__');
  }
};

const getInitialSettings = (): SettingsState => {
  let merged: Partial<SettingsState> | null = null;

  if (typeof window !== 'undefined') {
    const stored = safeParse(window.localStorage.getItem(STORAGE_KEY));
    if (stored && typeof stored === 'object') {
      merged = {
        ...DEFAULT_SETTINGS,
        ...stored,
      };
    }
  }

  if (!merged) {
    const openaiApiKey = resolveEnvValue('VITE_OPENAI_API_KEY');
    const openaiModel = resolveEnvValue('VITE_OPENAI_MODEL');

    merged = {
      ...DEFAULT_SETTINGS,
      ...(openaiApiKey ? { openaiApiKey } : {}),
      ...(openaiModel ? { openaiModel } : {}),
    };
  }

  const normalized = normalizeSettings(merged);
  applySettingsToWindow(normalized);
  return normalized;
};

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsState>(() => getInitialSettings());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const normalized = normalizeSettings(settings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    applySettingsToWindow(normalized);
  }, [settings]);

  const updateSettings = useCallback((updates: Partial<SettingsState>) => {
    setSettings((prev) => normalizeSettings({ ...prev, ...updates }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(getInitialSettings());
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      updateSettings,
      resetSettings,
    }),
    [settings, updateSettings, resetSettings]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};
