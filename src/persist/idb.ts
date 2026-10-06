/**
 * Persistence: the op log is the source of truth, with a snapshot per document for fast loads.
 *
 * Stores:
 *   docs  — one header per document: listing metadata plus the latest snapshot.
 *   ops   — every op, keyed by [docId, seq]. Appending is the hot path (every edit).
 *
 * Load = snapshot state + replay of the ops after it. The snapshot carries the hash of its
 * state; a mismatch means the cache is suspect and the whole log is replayed instead.
 */
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { Document, Op, State } from '../model/types';
import { SCHEMA_VERSION } from '../model/types';
import { applyOp, createDocument, replay } from '../model/apply';
import { hashState } from '../model/hash';
import { ulid } from '../model/ids';
import { text as viewText } from '../model/views';
import { docStats, type DocStats } from '../library/stats';

export type Snapshot = { state: State; opCount: number; hash: string; at: string };

export type DocHeader = DocStats & {
  id: string;
  createdAt: string;
  updatedAt: string;
  authors: Document['authors'];
  snapshot: Snapshot;
};

export type DocSummary = Omit<DocHeader, 'snapshot' | 'authors'>;

type OpRow = { docId: string; seq: number; op: Op };

/** Phase 0 record shape, migrated on upgrade. */
type V1Doc = { id: string; title: string; text: string; createdAt: string; updatedAt: string };

interface ShoulderDB extends DBSchema {
  docs: { key: string; value: DocHeader; indexes: { 'by-updated': string } };
  ops: { key: [string, number]; value: OpRow; indexes: { 'by-doc': string } };
}

const DB_NAME = 'shoulder-md';
const DB_VERSION = 2;

/** Snapshot after this many ops since the last one, or after this much time. */
export const SNAPSHOT_EVERY_OPS = 200;
export const SNAPSHOT_EVERY_MS = 30_000;

let dbPromise: Promise<IDBPDatabase<ShoulderDB>> | undefined;

function db(): Promise<IDBPDatabase<ShoulderDB>> {
  dbPromise ??= openDB<ShoulderDB>(DB_NAME, DB_VERSION, {
    async upgrade(database, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const docs = database.createObjectStore('docs', { keyPath: 'id' });
        docs.createIndex('by-updated', 'updatedAt');
      }
      if (oldVersion < 2) {
        const ops = database.createObjectStore('ops', { keyPath: ['docId', 'seq'] });
        ops.createIndex('by-doc', 'docId');
        if (oldVersion === 1) await migrateV1(tx);
      }
    },
  });
  return dbPromise;
}

async function migrateV1(tx: IDBPTransaction<ShoulderDB, ('docs' | 'ops')[], 'versionchange'>) {
  const docs = tx.objectStore('docs');
  const ops = tx.objectStore('ops');
  const old = (await docs.getAll()) as unknown as V1Doc[];
  for (const v1 of old) {
    if (!('text' in v1)) continue;
    const doc = createDocument({
      id: v1.id,
      text: v1.text,
      title: v1.title,
      author: 'me',
      ts: v1.createdAt,
      tracking: false,
    });
    doc.updatedAt = v1.updatedAt;
    await docs.put(headerOf(doc, doc.ops.length, v1.updatedAt));
    for (let i = 0; i < doc.ops.length; i++)
      await ops.put({ docId: doc.id, seq: i, op: doc.ops[i]! });
  }
}

/** For tests: drop the cached connection so a fresh fake database is opened. */
export function resetConnection(): void {
  dbPromise = undefined;
}

function headerOf(doc: Document, opCount: number, at: string): DocHeader {
  return {
    id: doc.id,
    ...docStats(doc.state),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    authors: doc.authors,
    snapshot: { state: doc.state, opCount, hash: hashState(doc.state), at },
  };
}

/** Headers written before a field existed get it from their snapshot. */
function summaryOf(h: DocHeader): DocSummary {
  const { snapshot, authors: _a, ...rest } = h;
  void _a;
  if (rest.acceptedChanges !== undefined && rest.status !== undefined) return rest;
  return { ...docStats(snapshot.state), ...rest };
}

export async function createDoc(init: {
  text?: string;
  title?: string;
  author: string;
  tracking?: boolean;
  libraryEligible?: boolean;
}): Promise<Document> {
  const doc = createDocument({
    text: init.text,
    title: init.title,
    author: init.author,
    tracking: init.tracking,
    libraryEligible: init.libraryEligible,
  });
  const d = await db();
  const tx = d.transaction(['docs', 'ops'], 'readwrite');
  await tx.objectStore('docs').put(headerOf(doc, doc.ops.length, doc.updatedAt));
  for (let i = 0; i < doc.ops.length; i++)
    await tx.objectStore('ops').put({ docId: doc.id, seq: i, op: doc.ops[i]! });
  await tx.done;
  return doc;
}

/** Stores an existing document (an import). A clashing id gets a fresh one. */
export async function importDocument(doc: Document): Promise<Document> {
  const d = await db();
  const exists = await d.get('docs', doc.id);
  const stored: Document = exists ? { ...doc, id: ulid() } : doc;
  const tx = d.transaction(['docs', 'ops'], 'readwrite');
  await tx.objectStore('docs').put(headerOf(stored, stored.ops.length, stored.updatedAt));
  for (let i = 0; i < stored.ops.length; i++) {
    await tx.objectStore('ops').put({ docId: stored.id, seq: i, op: stored.ops[i]! });
  }
  await tx.done;
  return stored;
}

export type Loaded = { doc: Document; recovered: boolean };

/** Loads a document: snapshot plus the ops after it, or a full replay if the snapshot is suspect. */
export async function loadDoc(id: string): Promise<Loaded | undefined> {
  const d = await db();
  const header = await d.get('docs', id);
  if (!header) return undefined;
  const rows = await d.getAllFromIndex('ops', 'by-doc', id);
  rows.sort((a, b) => a.seq - b.seq);
  const ops = rows.map((r) => r.op);

  let state: State;
  let recovered = false;
  const snap = header.snapshot;
  if (snap && snap.opCount <= ops.length && hashState(snap.state) === snap.hash) {
    state = snap.state;
    for (const op of ops.slice(snap.opCount)) state = applyOp(state, op).state;
  } else {
    recovered = true;
    console.warn(
      `shoulder-md: snapshot for ${id} is missing or corrupt; replaying ${ops.length} ops`,
    );
    state = replay(ops);
  }
  const doc: Document = {
    schemaVersion: SCHEMA_VERSION,
    id,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    authors: header.authors,
    ops,
    state,
  };
  return { doc, recovered };
}

export type AppendResult = { snapshotted: boolean };

/**
 * Appends ops (already applied in `doc`) and refreshes the header. Takes a snapshot when due.
 * `doc.ops` must already contain the new ops at the end.
 */
export async function appendOps(
  doc: Document,
  newOps: Op[],
  opts: { forceSnapshot?: boolean } = {},
): Promise<AppendResult> {
  const d = await db();
  const tx = d.transaction(['docs', 'ops'], 'readwrite');
  const docs = tx.objectStore('docs');
  const opsStore = tx.objectStore('ops');
  const existing = await docs.get(doc.id);
  const firstSeq = doc.ops.length - newOps.length;
  for (let i = 0; i < newOps.length; i++)
    await opsStore.put({ docId: doc.id, seq: firstSeq + i, op: newOps[i]! });

  const now = doc.updatedAt;
  const prevSnap = existing?.snapshot;
  const due =
    opts.forceSnapshot ||
    !prevSnap ||
    doc.ops.length - prevSnap.opCount >= SNAPSHOT_EVERY_OPS ||
    Date.parse(now) - Date.parse(prevSnap.at) >= SNAPSHOT_EVERY_MS;
  const header = headerOf(doc, doc.ops.length, now);
  if (!due && prevSnap) header.snapshot = prevSnap;
  await docs.put(header);
  await tx.done;
  return { snapshotted: due };
}

export async function deleteDoc(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['docs', 'ops'], 'readwrite');
  await tx.objectStore('docs').delete(id);
  const keys = await tx.objectStore('ops').index('by-doc').getAllKeys(id);
  for (const k of keys) await tx.objectStore('ops').delete(k);
  await tx.done;
}

export async function listDocs(): Promise<DocSummary[]> {
  const all = await (await db()).getAllFromIndex('docs', 'by-updated');
  return all.reverse().map(summaryOf);
}

export type LibraryEntry = DocSummary & { text: string };

/** Every document with its clean text (from the snapshot) for search. Newest first. */
export async function libraryEntries(): Promise<LibraryEntry[]> {
  const all = await (await db()).getAllFromIndex('docs', 'by-updated');
  return all.reverse().map((h) => ({ ...summaryOf(h), text: viewText(h.snapshot.state, 'clean') }));
}

/** Applies one op to a stored document that is not open, and saves it with a fresh snapshot. */
export async function appendToStored(id: string, op: Op): Promise<Document | undefined> {
  const loaded = await loadDoc(id);
  if (!loaded) return undefined;
  const applied = applyOp(loaded.doc.state, op);
  const doc: Document = {
    ...loaded.doc,
    ops: [...loaded.doc.ops, applied.op],
    state: applied.state,
    updatedAt: op.ts,
  };
  await appendOps(doc, [applied.op], { forceSnapshot: true });
  return doc;
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
