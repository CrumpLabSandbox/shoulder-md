import { fontById } from './fonts';

export type Theme = 'system' | 'light' | 'dark' | 'sepia';
export type Layout = 'editor' | 'split' | 'preview';

export type Settings = {
  editorFont: string;
  previewFont: string;
  fontSize: number; // px, 12..24
  lineHeight: number; // 1.2..2.0
  measure: number; // characters, 50..100; 0 means full width
  theme: Theme;
  layout: Layout;
  preset: string; // preset id or 'custom'
  /** Show the reason tag chips on change cards. Off by default; free-text reasons stay available. */
  showReasonTags: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  editorFont: 'ia-duo',
  previewFont: 'source-serif',
  fontSize: 17,
  lineHeight: 1.6,
  measure: 72,
  theme: 'system',
  layout: 'editor',
  preset: 'draft',
  showReasonTags: false,
};

export type Preset = {
  id: string;
  label: string;
  description: string;
  values: Partial<Settings>;
};

export const PRESETS: readonly Preset[] = [
  {
    id: 'manuscript',
    label: 'Manuscript',
    description: 'Serif, roomy, sepia.',
    values: {
      editorFont: 'source-serif',
      previewFont: 'source-serif',
      fontSize: 18,
      lineHeight: 1.7,
      measure: 68,
      theme: 'sepia',
    },
  },
  {
    id: 'draft',
    label: 'Draft',
    description: 'Duospace for Markdown source, light.',
    values: {
      editorFont: 'ia-duo',
      previewFont: 'source-serif',
      fontSize: 17,
      lineHeight: 1.6,
      measure: 72,
      theme: 'light',
    },
  },
  {
    id: 'mono',
    label: 'Mono',
    description: 'JetBrains Mono, wide, dark.',
    values: {
      editorFont: 'jetbrains-mono',
      previewFont: 'inter',
      fontSize: 15,
      lineHeight: 1.55,
      measure: 90,
      theme: 'dark',
    },
  },
  {
    id: 'reading',
    label: 'Reading',
    description: 'Literata, narrow measure, follows system theme.',
    values: {
      editorFont: 'literata',
      previewFont: 'literata',
      fontSize: 19,
      lineHeight: 1.75,
      measure: 60,
      theme: 'system',
    },
  },
];

const STORAGE_KEY = 'shoulder-md:settings:v1';

/** Keys that a preset controls. Changing any of these by hand switches the preset to 'custom'. */
const PRESET_KEYS: readonly (keyof Settings)[] = [
  'editorFont',
  'previewFont',
  'fontSize',
  'lineHeight',
  'measure',
  'theme',
];

export function loadSettings(storage: Storage | undefined = globalThis.localStorage): Settings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return sanitize({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(
  settings: Settings,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, quota). Settings then live for the session only.
  }
}

export function sanitize(s: Settings): Settings {
  const clamp = (v: number, lo: number, hi: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  return {
    editorFont: fontById(s.editorFont).id,
    previewFont: fontById(s.previewFont).id,
    fontSize: clamp(s.fontSize, 12, 24, DEFAULT_SETTINGS.fontSize),
    lineHeight: clamp(s.lineHeight, 1.2, 2.0, DEFAULT_SETTINGS.lineHeight),
    measure: s.measure === 0 ? 0 : clamp(s.measure, 50, 100, DEFAULT_SETTINGS.measure),
    theme: (['system', 'light', 'dark', 'sepia'] as const).includes(s.theme) ? s.theme : 'system',
    layout: (['editor', 'split', 'preview'] as const).includes(s.layout) ? s.layout : 'editor',
    preset: s.preset,
    showReasonTags: typeof s.showReasonTags === 'boolean' ? s.showReasonTags : false,
  };
}

export function applyPreset(s: Settings, presetId: string): Settings {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return { ...s, preset: 'custom' };
  return sanitize({ ...s, ...preset.values, preset: preset.id });
}

/** Returns the settings with one key changed; preset becomes 'custom' if the key is preset-controlled. */
export function withChange<K extends keyof Settings>(
  s: Settings,
  key: K,
  value: Settings[K],
): Settings {
  const next = { ...s, [key]: value };
  if (PRESET_KEYS.includes(key)) next.preset = 'custom';
  return sanitize(next);
}

/** Writes settings into CSS custom properties on the document root. */
export function applyToDocument(
  s: Settings,
  root: HTMLElement | undefined = globalThis.document?.documentElement,
): void {
  if (!root) return;
  root.style.setProperty('--editor-font', fontById(s.editorFont).stack);
  root.style.setProperty('--preview-font', fontById(s.previewFont).stack);
  root.style.setProperty('--font-size', `${s.fontSize}px`);
  root.style.setProperty('--line-height', String(s.lineHeight));
  root.style.setProperty('--measure', s.measure === 0 ? 'none' : `${s.measure}ch`);
  root.dataset.theme = s.theme;
}

/** Reactive settings store (Svelte 5 runes). One instance for the app. */
export function createSettingsStore(storage: Storage | undefined = globalThis.localStorage) {
  let settings = $state<Settings>(loadSettings(storage));

  function commit(next: Settings) {
    settings = next;
    saveSettings(next, storage);
    applyToDocument(next);
  }

  applyToDocument(settings);

  return {
    get value() {
      return settings;
    },
    set<K extends keyof Settings>(key: K, value: Settings[K]) {
      commit(withChange(settings, key, value));
    },
    usePreset(id: string) {
      commit(applyPreset(settings, id));
    },
    reset() {
      commit({ ...DEFAULT_SETTINGS });
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
