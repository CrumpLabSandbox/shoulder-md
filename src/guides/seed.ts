/**
 * Seeding style guides from a folder of Markdown files. Two layouts are read:
 *
 *   base.md            the base guide
 *   <genre>/guide.md   one genre guide per folder (named by its first heading, else the folder)
 *
 * and the flat one the app itself writes to `Style/Guides/`: plain `.md` files side by side,
 * either directly in the picked folder or in a folder called `Guides` inside it. There, the
 * file named or headed "Base style guide" (or whose ids start with B) is the base guide and
 * each other file is a genre named by its first heading. Files with no list items are skipped.
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

/** Files the app writes beside a guide that are not guides themselves. */
const NOT_A_GUIDE = /(^readme\.md$)|(\.chat\.md$)|(\.revision\.md$)|(\.conflict-)/i;
const BASE_NAME = /^base([-_ ]?style[-_ ]?guide)?(-\d+)?\.md$/i;

function isBase(file: string, text: string): boolean {
  if (BASE_NAME.test(file)) return true;
  if (/^base style guide$/i.test(heading(text) ?? '')) return true;
  return seedPrefix(text) === 'B';
}

/** A readable name from a file stem: `grant-proposals-2` becomes "Grant proposals". */
function fromStem(file: string): string {
  const words = file.replace(/\.md$/i, '').replace(/-\d+$/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Guide';
}

/**
 * Finds the guides in a picked folder: the shallowest `base.md` and every `<genre>/guide.md`,
 * plus plain guide files at the top of the folder or in a `Guides` folder.
 */
export function readSeed(files: readonly SeedFile[]): SeedGuide[] {
  const guides: SeedGuide[] = [];
  const sorted = [...files].sort(
    (a, b) => segments(a.path).length - segments(b.path).length || a.path.localeCompare(b.path),
  );
  const hasBase = () => guides.some((g) => g.role === 'base');
  const hasGenre = (name: string) =>
    guides.some((g) => g.role === 'genre' && g.name.toLowerCase() === name.toLowerCase());
  for (const f of sorted) {
    const parts = segments(f.path);
    const file = parts[parts.length - 1] ?? '';
    const lower = file.toLowerCase();
    if (parts.some((p) => p.startsWith('.'))) continue;
    if (lower === 'base.md') {
      if (!hasBase())
        guides.push({ role: 'base', name: 'Base style guide', text: f.text, path: f.path });
    } else if (lower === 'guide.md' && parts.length >= 2) {
      const name = heading(f.text) ?? parts[parts.length - 2]!;
      if (!hasGenre(name)) guides.push({ role: 'genre', name, text: f.text, path: f.path });
    }
  }
  // The flat layout: files side by side, as the app writes them to Style/Guides/.
  for (const f of sorted) {
    const parts = segments(f.path);
    const file = parts[parts.length - 1] ?? '';
    const lower = file.toLowerCase();
    if (!lower.endsWith('.md') || lower === 'base.md' || lower === 'guide.md') continue;
    if (parts.some((p) => p.startsWith('.')) || NOT_A_GUIDE.test(file)) continue;
    const inGuides = parts[parts.length - 2]?.toLowerCase() === 'guides';
    if (parts.length > 2 && !inGuides) continue;
    if (principleItems(f.text).length === 0) continue;
    if (isBase(file, f.text)) {
      if (!hasBase())
        guides.push({ role: 'base', name: 'Base style guide', text: f.text, path: f.path });
    } else {
      const name = heading(f.text) ?? fromStem(file);
      if (!hasGenre(name)) guides.push({ role: 'genre', name, text: f.text, path: f.path });
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
