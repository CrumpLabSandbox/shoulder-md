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
