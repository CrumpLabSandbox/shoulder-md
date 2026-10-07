/**
 * Seeding style guides from a folder of Markdown files:
 *
 *   base.md            the base guide
 *   <genre>/guide.md   one genre guide per folder (named by its first heading, else the folder)
 *
 * Other files are ignored. A guide the app does not have is created from the file; for one it
 * has, principles the file adds are appended (with their indented explanation) and nothing
 * already there is changed, so a folder can be imported again as it grows.
 */
import { numberingEdits, parsePrinciples, principleItems } from './principles';

export type SeedFile = { path: string; text: string };

export type SeedGuide = { role: 'base' | 'genre'; name: string; text: string; path: string };

const segments = (path: string) => path.split(/[\\/]+/).filter(Boolean);

function heading(text: string): string | undefined {
  return /^#\s+(.+?)\s*$/m.exec(text)?.[1];
}

/** Finds the guides in a picked folder: the shallowest `base.md`, and every `guide.md`. */
export function readSeed(files: readonly SeedFile[]): SeedGuide[] {
  const guides: SeedGuide[] = [];
  const sorted = [...files].sort(
    (a, b) => segments(a.path).length - segments(b.path).length || a.path.localeCompare(b.path),
  );
  for (const f of sorted) {
    const parts = segments(f.path);
    const file = parts[parts.length - 1]?.toLowerCase();
    if (parts.some((p) => p.startsWith('.'))) continue;
    if (file === 'base.md') {
      if (!guides.some((g) => g.role === 'base'))
        guides.push({ role: 'base', name: 'Base style guide', text: f.text, path: f.path });
    } else if (file === 'guide.md' && parts.length >= 2) {
      const name = heading(f.text) ?? parts[parts.length - 2]!;
      guides.push({ role: 'genre', name, text: f.text, path: f.path });
    }
  }
  return guides;
}

/** The id prefix a seed guide already uses (`BL` for `[BL1]`), if its principles have ids. */
export function seedPrefix(text: string): string | undefined {
  const id = parsePrinciples(text).principles[0]?.id;
  return id?.replace(/-?\d+$/, '');
}

function applyEdits(text: string, edits: { at: number; insert: string }[]): string {
  let out = text;
  // Edits come last first, so earlier offsets stay valid.
  for (const e of edits) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  return out;
}

/** A new guide's text, with ids given to any principles that lack one. */
export function numbered(text: string, prefix: string): string {
  return applyEdits(text, numberingEdits(text, prefix));
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * What to append to an existing guide so it has every principle of the seed file. A principle
 * is already there if its id is, or if one with the same wording is.
 */
export function seedAdditions(
  existing: string,
  seed: string,
  prefix: string,
): { append: string; added: number } {
  const have = parsePrinciples(existing).principles;
  const ids = new Set(have.map((p) => p.id));
  const texts = new Set(have.map((p) => norm(p.text)));
  const own = new RegExp(`^${prefix}\\d+$`);
  const fresh: string[] = [];
  for (const item of principleItems(seed)) {
    if (item.id && ids.has(item.id)) continue;
    if (texts.has(norm(item.text))) continue;
    // An id from another prefix would not belong to this guide: drop it and renumber.
    fresh.push(item.id && !own.test(item.id) ? item.raw.replace(/\[[^\]]*\]\s*/, '') : item.raw);
  }
  if (fresh.length === 0) return { append: '', added: 0 };
  const gap = existing.endsWith('\n\n') || !existing ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  const full = existing + gap + fresh.join('\n') + '\n';
  const edits = numberingEdits(full, prefix).filter((e) => e.at >= existing.length);
  return { append: applyEdits(full, edits).slice(existing.length), added: fresh.length };
}
