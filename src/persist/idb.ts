import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { countWords } from '../util/text';

/**
 * Phase 0 persistence: raw Markdown text per document.
 * Phase 1 replaces the `text` field with an op log and snapshots (see plan.md §5),
 * so this schema is version 1 and will be migrated, never rewritten in place.
 */
export type DocRecord = {
  id: string;
  title: string;
  text: string;
  createdAt: string;
  updatedAt: string;
};

export type DocSummary = Omit<DocRecord, 'text'> & { words: number };

interface ShoulderDB extends DBSchema {
  docs: {
    key: string;
    value: DocRecord;
    indexes: { 'by-updated': string };
  };
}

const DB_NAME = 'shoulder-md';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ShoulderDB>> | undefined;

function db(): Promise<IDBPDatabase<ShoulderDB>> {
  dbPromise ??= openDB<ShoulderDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore('docs', { keyPath: 'id' });
      store.createIndex('by-updated', 'updatedAt');
    },
  });
  return dbPromise;
}

/** For tests: drop the cached connection so a fresh fake database is opened. */
export function resetConnection(): void {
  dbPromise = undefined;
}

export function newId(): string {
  // Time-sortable, URL-safe. Enough for a single-user local store; ULID proper comes with phase 1.
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    (b % 36).toString(36),
  ).join('');
  return `${t}${r}`;
}

export async function createDoc(
  init: Partial<Pick<DocRecord, 'title' | 'text'>> = {},
): Promise<DocRecord> {
  const now = new Date().toISOString();
  const doc: DocRecord = {
    id: newId(),
    title: init.title ?? 'Untitled',
    text: init.text ?? '',
    createdAt: now,
    updatedAt: now,
  };
  await (await db()).put('docs', doc);
  return doc;
}

export async function getDoc(id: string): Promise<DocRecord | undefined> {
  return (await db()).get('docs', id);
}

export async function putDoc(doc: DocRecord): Promise<void> {
  await (await db()).put('docs', doc);
}

export async function deleteDoc(id: string): Promise<void> {
  await (await db()).delete('docs', id);
}

export async function listDocs(): Promise<DocSummary[]> {
  const all = await (await db()).getAllFromIndex('docs', 'by-updated');
  return all.reverse().map(({ text, ...rest }) => ({ ...rest, words: countWords(text) }));
}

/** Ask the browser not to evict our storage under pressure. Returns whether it agreed. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    // ignore
  }
  return false;
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | undefined> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (e && e.usage !== undefined && e.quota !== undefined)
      return { usage: e.usage, quota: e.quota };
  } catch {
    // ignore
  }
  return undefined;
}
