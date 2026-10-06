import type { Author } from '../model/types';

const KEY = 'shoulder-md:author';

/** The local author. A real identity UI arrives with tracked changes in phase 2. */
export function loadAuthor(storage: Storage | undefined = globalThis.localStorage): Author {
  try {
    const raw = storage?.getItem(KEY);
    if (raw) {
      const a = JSON.parse(raw) as Partial<Author>;
      if (a.id && a.name) return { id: a.id, name: a.name, ...(a.color ? { color: a.color } : {}) };
    }
  } catch {
    // fall through
  }
  return { id: 'me', name: 'Me' };
}

export function saveAuthor(
  author: Author,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(author));
  } catch {
    // ignore
  }
}

/** Author colours: an explicit colour wins, otherwise a stable pick from the palette. */
export const AUTHOR_PALETTE = [
  '#2563eb', // blue
  '#c2410c', // orange
  '#15803d', // green
  '#7c3aed', // violet
  '#b91c1c', // red
  '#0f766e', // teal
  '#a16207', // amber
  '#be185d', // pink
] as const;

export function authorColor(id: string, known: readonly Author[] = []): string {
  const explicit = known.find((a) => a.id === id)?.color;
  if (explicit) return explicit;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AUTHOR_PALETTE[h % AUTHOR_PALETTE.length]!;
}

/** Authors that are not people: edits loaded from the folder, and (phase 7) Claude. */
export const DISK_AUTHOR = 'disk';
const BUILTIN_NAMES: Record<string, string> = { [DISK_AUTHOR]: 'Edited on disk', claude: 'Claude' };

export function authorName(id: string, known: readonly Author[] = []): string {
  return known.find((a) => a.id === id)?.name ?? BUILTIN_NAMES[id] ?? id;
}
