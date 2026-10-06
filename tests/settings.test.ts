import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  applyPreset,
  loadSettings,
  saveSettings,
  sanitize,
  withChange,
  applyToDocument,
} from '../src/settings/settings.svelte';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('settings', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const s = withChange(DEFAULT_SETTINGS, 'fontSize', 20);
    saveSettings(s, storage);
    expect(loadSettings(storage)).toEqual(s);
  });

  it('returns defaults for missing or corrupt storage', () => {
    const storage = memoryStorage();
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
    storage.setItem('shoulder-md:settings:v1', '{not json');
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps out-of-range values and unknown fonts', () => {
    const s = sanitize({
      ...DEFAULT_SETTINGS,
      fontSize: 99,
      lineHeight: 0,
      editorFont: 'comic-sans',
      theme: 'neon' as never,
    });
    expect(s.fontSize).toBe(24);
    expect(s.lineHeight).toBe(1.2);
    expect(s.editorFont).toBe('source-serif');
    expect(s.theme).toBe('system');
  });

  it('hides reason tags by default and keeps the choice out of presets', () => {
    expect(DEFAULT_SETTINGS.showReasonTags).toBe(false);
    const on = withChange(applyPreset(DEFAULT_SETTINGS, 'mono'), 'showReasonTags', true);
    expect(on.showReasonTags).toBe(true);
    expect(on.preset).toBe('mono');
    expect(applyPreset(on, 'manuscript').showReasonTags).toBe(true);
    expect(sanitize({ ...DEFAULT_SETTINGS, showReasonTags: 'yes' as never }).showReasonTags).toBe(
      false,
    );
  });

  it('switches preset to custom when a preset-controlled key changes', () => {
    const s = applyPreset(DEFAULT_SETTINGS, 'mono');
    expect(s.preset).toBe('mono');
    expect(s.editorFont).toBe('jetbrains-mono');
    expect(withChange(s, 'fontSize', 16).preset).toBe('custom');
    expect(withChange(s, 'layout', 'split').preset).toBe('mono');
  });

  it('writes CSS custom properties', () => {
    const root = document.createElement('div');
    applyToDocument(applyPreset(DEFAULT_SETTINGS, 'manuscript'), root);
    expect(root.style.getPropertyValue('--font-size')).toBe('18px');
    expect(root.style.getPropertyValue('--measure')).toBe('68ch');
    expect(root.dataset.theme).toBe('sepia');
    applyToDocument(withChange(DEFAULT_SETTINGS, 'measure', 0), root);
    expect(root.style.getPropertyValue('--measure')).toBe('none');
  });
});
