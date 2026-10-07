/**
 * Mirrors documents into a folder: `<name>.md` (clean text) and `<name>.shoulder.json` (the
 * full document with its op log). Names are picked once from the title and then kept, so a
 * git history stays readable. See plan.md §5.
 *
 * Conflict rule: the browser copy wins, unless the files on disk changed and the browser did
 * not, in which case the caller asks the user. When both changed, the disk version is saved
 * next to the document as `<name>.conflict-<time>.md|.shoulder.json` before it is overwritten.
 */
import type { Document, Op } from '../model/types';
import { exportJson, importJson } from '../export/json';
import { PROPOSALS_EXT, SKIPPED_EXT } from './proposals';
import { slugify } from '../export/download';
import { displayTitle } from '../docs/title';
import { text as viewText } from '../model/views';
import { fileIfExists, listFileNames, writeFile, type DirHandleLike, type FileLike } from './fs';

export type Stat = { lastModified: number; size: number };

export type FileRecord = {
  docId: string;
  /** File name stem: `<base>.md` and `<base>.shoulder.json`. */
  base: string;
  md?: Stat;
  json?: Stat;
  /** How many ops the document had when it was last written. */
  opCount: number;
  /** The document's `updatedAt` when last written; a typing run grows its op without adding one. */
  stamp?: string;
  writtenAt?: string;
};

export interface FolderStore {
  get(docId: string): Promise<FileRecord | undefined>;
  put(record: FileRecord): Promise<void>;
  all(): Promise<FileRecord[]>;
  delete(docId: string): Promise<void>;
}

export type External =
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'md'; file: string; text: string }
  | { kind: 'json'; file: string; doc: Document; extendsLocal: boolean; newOps: number }
  | { kind: 'invalid'; file: string; error: string };

export type WriteResult = {
  written: boolean;
  /** Set when the disk changed and the browser did not: the caller should ask. */
  external?: Exclude<External, { kind: 'none' } | { kind: 'missing' }>;
  /** Files the disk version was saved to before being overwritten. */
  backups: string[];
  /** Set when files named while the document was untitled were renamed after its title. */
  renamed?: { from: string; to: string };
};

const MD = '.md';
const JSON_EXT = '.shoulder.json';

const statOf = (f: FileLike): Stat => ({ lastModified: f.lastModified, size: f.size });
const same = (a: Stat | undefined, b: Stat) =>
  !!a && a.lastModified === b.lastModified && a.size === b.size;

/** Same op, not just the same id: a typing run keeps its id while its text grows. */
const sameOp = (a: Op | undefined, b: Op) =>
  !!a && a.id === b.id && (a.type !== 'edit' || b.type !== 'edit' || a.insert === b.insert);

/** Names given to a document that had no title yet. */
const PLACEHOLDER = /^untitled(-\d+)?$/;

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class FolderSync {
  constructor(
    readonly dir: DirHandleLike,
    private readonly store: FolderStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get name(): string {
    return this.dir.name;
  }

  /** The record for a document, assigning a file name on first use. */
  async recordFor(doc: Document): Promise<FileRecord> {
    const existing = await this.store.get(doc.id);
    if (existing) return existing;
    const record: FileRecord = { docId: doc.id, base: await this.freeBase(doc), opCount: -1 };
    await this.store.put(record);
    return record;
  }

  /** A file name stem for the document, from its title, that no other document is using. */
  private async freeBase(doc: Document): Promise<string> {
    const taken = new Set(await listFileNames(this.dir));
    const used = new Set((await this.store.all()).map((r) => r.base));
    const stem = slugify(displayTitle(doc.state.meta.title, viewText(doc.state, 'clean')));
    let base = stem;
    for (let i = 2; taken.has(base + MD) || taken.has(base + JSON_EXT) || used.has(base); i++) {
      // A file with this name that is this document's own (e.g. after reconnecting) is fine.
      if (
        taken.has(base + JSON_EXT) &&
        (await this.jsonId(base + JSON_EXT)) === doc.id &&
        !used.has(base)
      )
        break;
      base = `${stem}-${i}`;
    }
    return base;
  }

  /**
   * A better name for a document whose files were named while it was still untitled. File
   * names are otherwise fixed once chosen (later title changes do not rename), but "untitled"
   * only says the folder was connected early. The title counts as settled once it is set
   * explicitly, or once the text has moved past its first line.
   */
  private async settledName(doc: Document, rec: FileRecord): Promise<string | undefined> {
    if (!PLACEHOLDER.test(rec.base)) return undefined;
    const clean = viewText(doc.state, 'clean');
    const explicit = doc.state.meta.title.trim();
    if (!explicit && !/\S[^\n]*\n/.test(clean)) return undefined;
    if (PLACEHOLDER.test(slugify(displayTitle(explicit, clean)))) return undefined;
    return this.freeBase(doc);
  }

  /** Removes a renamed document's old files, carrying any waiting proposals to the new name. */
  private async retire(oldBase: string, newBase: string): Promise<void> {
    for (const ext of [PROPOSALS_EXT, SKIPPED_EXT]) {
      const h = await fileIfExists(this.dir, oldBase + ext);
      if (h) await writeFile(this.dir, newBase + ext, await (await h.getFile()).text());
    }
    for (const ext of [MD, JSON_EXT, PROPOSALS_EXT, SKIPPED_EXT]) {
      if (await fileIfExists(this.dir, oldBase + ext)) await this.dir.removeEntry(oldBase + ext);
    }
  }

  private async jsonId(name: string): Promise<string | undefined> {
    try {
      const f = await fileIfExists(this.dir, name);
      if (!f) return undefined;
      const parsed = JSON.parse(await (await f.getFile()).text()) as { id?: unknown };
      return typeof parsed.id === 'string' ? parsed.id : undefined;
    } catch {
      return undefined;
    }
  }

  /** What, if anything, changed on disk since this document was last written. */
  async check(doc: Document, record?: FileRecord): Promise<External> {
    const rec = record ?? (await this.store.get(doc.id));
    if (!rec || rec.opCount < 0) return { kind: 'none' };
    const jsonName = rec.base + JSON_EXT;
    const mdName = rec.base + MD;
    const jsonHandle = await fileIfExists(this.dir, jsonName);
    const mdHandle = await fileIfExists(this.dir, mdName);
    if (!jsonHandle || !mdHandle) return { kind: 'missing' };
    const jsonFile = await jsonHandle.getFile();
    const mdFile = await mdHandle.getFile();
    const jsonChanged = !same(rec.json, statOf(jsonFile));
    const mdChanged = !same(rec.md, statOf(mdFile));
    if (jsonChanged) {
      const text = await jsonFile.text();
      try {
        const disk = importJson(text).doc;
        if (disk.id !== doc.id)
          return { kind: 'invalid', file: jsonName, error: 'it belongs to another document' };
        const local = doc.ops;
        const extendsLocal =
          disk.ops.length >= local.length && local.every((op, i) => sameOp(disk.ops[i], op));
        if (extendsLocal && disk.ops.length === local.length) {
          // Rewritten with the same history (e.g. touched or reformatted): not a change.
          if (!mdChanged) return { kind: 'none' };
        } else {
          return {
            kind: 'json',
            file: jsonName,
            doc: disk,
            extendsLocal,
            newOps: disk.ops.length - local.length,
          };
        }
      } catch (e) {
        return {
          kind: 'invalid',
          file: jsonName,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    if (mdChanged) {
      const text = await mdFile.text();
      if (text !== viewText(doc.state, 'clean')) return { kind: 'md', file: mdName, text };
    }
    return { kind: 'none' };
  }

  /**
   * Writes the document unless nothing changed. If the disk changed and the browser did not,
   * nothing is written and `external` says what changed. With `force`, or when both changed,
   * the disk version is backed up and overwritten.
   */
  async write(doc: Document, opts: { force?: boolean } = {}): Promise<WriteResult> {
    const rec = await this.recordFor(doc);
    const external = await this.check(doc, rec);
    const browserChanged =
      rec.opCount !== doc.ops.length || (rec.stamp !== undefined && rec.stamp !== doc.updatedAt);
    const backups: string[] = [];
    // Only rename when nothing outside is waiting to be settled under the old name.
    const renameTo =
      external.kind === 'none' || external.kind === 'missing'
        ? await this.settledName(doc, rec)
        : undefined;

    if (external.kind === 'md' || external.kind === 'json' || external.kind === 'invalid') {
      if (!browserChanged && !opts.force) return { written: false, external, backups };
      backups.push(...(await this.backup(rec)));
    } else if (!browserChanged && external.kind === 'none' && !opts.force && !renameTo) {
      return { written: false, backups };
    } else if (rec.opCount < 0 && !renameTo) {
      // First write to this name: keep anything already there that differs from what we write.
      backups.push(...(await this.backupIfDifferent(rec, doc)));
    }

    const base = renameTo ?? rec.base;
    const md = await writeFile(this.dir, base + MD, viewText(doc.state, 'clean'));
    const json = await writeFile(this.dir, base + JSON_EXT, exportJson(doc));
    await this.store.put({
      ...rec,
      base,
      md: statOf(md),
      json: statOf(json),
      opCount: doc.ops.length,
      stamp: doc.updatedAt,
      writtenAt: this.now().toISOString(),
    });
    if (!renameTo) return { written: true, backups };
    await this.retire(rec.base, renameTo);
    return { written: true, backups, renamed: { from: rec.base + MD, to: renameTo + MD } };
  }

  private async backup(rec: FileRecord): Promise<string[]> {
    const out: string[] = [];
    const suffix = `.conflict-${stamp(this.now())}`;
    for (const ext of [MD, JSON_EXT]) {
      const h = await fileIfExists(this.dir, rec.base + ext);
      if (!h) continue;
      const f = await h.getFile();
      const recorded = ext === MD ? rec.md : rec.json;
      if (same(recorded, statOf(f))) continue; // unchanged since our write: nothing to keep
      const name = rec.base + suffix + ext;
      await writeFile(this.dir, name, await f.text());
      out.push(name);
    }
    return out;
  }

  private async backupIfDifferent(rec: FileRecord, doc: Document): Promise<string[]> {
    const out: string[] = [];
    const suffix = `.conflict-${stamp(this.now())}`;
    const wanted: Record<string, string> = {
      [MD]: viewText(doc.state, 'clean'),
      [JSON_EXT]: exportJson(doc),
    };
    // Files that are our own earlier export of this history (e.g. after reconnecting) are not
    // worth keeping: everything in them is in the browser's op log.
    const jsonHandle = await fileIfExists(this.dir, rec.base + JSON_EXT);
    if (jsonHandle) {
      try {
        const disk = importJson(await (await jsonHandle.getFile()).text()).doc;
        if (disk.id === doc.id && disk.ops.every((op, i) => doc.ops[i]?.id === op.id)) return out;
      } catch {
        // unreadable: fall through and keep it
      }
    }
    for (const ext of [MD, JSON_EXT]) {
      const h = await fileIfExists(this.dir, rec.base + ext);
      if (!h) continue;
      const text = await (await h.getFile()).text();
      if (text === wanted[ext]) continue;
      const name = rec.base + suffix + ext;
      await writeFile(this.dir, name, text);
      out.push(name);
    }
    return out;
  }

  /**
   * Removes a document's files from this folder (when it moves to the other folder). Returns
   * the names removed. Nothing is backed up here: the browser holds the document.
   */
  async remove(docId: string): Promise<string[]> {
    const rec = await this.store.get(docId);
    if (!rec) return [];
    const removed: string[] = [];
    for (const ext of [MD, JSON_EXT]) {
      const name = rec.base + ext;
      if (!(await fileIfExists(this.dir, name))) continue;
      await this.dir.removeEntry(name);
      removed.push(name);
    }
    await this.store.delete(docId);
    return removed;
  }

  /**
   * The proposals file waiting next to a document, if any. `key` changes when the file does,
   * so a caller can tell a file it has already looked at from a new one.
   */
  async proposals(docId: string): Promise<{ file: string; text: string; key: string } | undefined> {
    const rec = await this.store.get(docId);
    if (!rec) return undefined;
    const file = rec.base + PROPOSALS_EXT;
    const handle = await fileIfExists(this.dir, file);
    if (!handle) return undefined;
    const f = await handle.getFile();
    return { file, text: await f.text(), key: `${docId}:${f.lastModified}:${f.size}` };
  }

  /** Removes a document's proposals file once handled, keeping `leftover` beside it if given. */
  async clearProposals(docId: string, leftover?: string): Promise<void> {
    const rec = await this.store.get(docId);
    if (!rec) return;
    if (leftover !== undefined) await writeFile(this.dir, rec.base + SKIPPED_EXT, leftover);
    if (await fileIfExists(this.dir, rec.base + PROPOSALS_EXT))
      await this.dir.removeEntry(rec.base + PROPOSALS_EXT);
  }

  /** Whether this folder holds (or last held) the document's files. */
  async has(docId: string): Promise<boolean> {
    return !!(await this.store.get(docId));
  }

  /**
   * Documents in the folder that the browser does not have: every readable `*.shoulder.json`
   * whose id is neither known nor deleted here. Their file names are recorded as theirs.
   */
  async scan(knownIds: Iterable<string>, deletedIds: Iterable<string>): Promise<Document[]> {
    const known = new Set(knownIds);
    const deleted = new Set(deletedIds);
    const found: Document[] = [];
    for (const name of await listFileNames(this.dir)) {
      if (!name.endsWith(JSON_EXT) || name.includes('.conflict-')) continue;
      const h = await fileIfExists(this.dir, name);
      if (!h) continue;
      const file = await h.getFile();
      let doc: Document;
      try {
        doc = importJson(await file.text()).doc;
      } catch {
        continue;
      }
      if (deleted.has(doc.id)) continue;
      const base = name.slice(0, -JSON_EXT.length);
      if (!known.has(doc.id)) {
        found.push(doc);
        const md = await fileIfExists(this.dir, base + MD);
        await this.store.put({
          docId: doc.id,
          base,
          json: statOf(file),
          ...(md ? { md: statOf(await md.getFile()) } : {}),
          opCount: doc.ops.length,
        });
      } else if (!(await this.store.get(doc.id))) {
        // A document both sides have, not yet linked to its files here: claim the name. The
        // next write compares histories and keeps anything that would be lost.
        await this.store.put({ docId: doc.id, base, opCount: -1 });
      }
    }
    return found;
  }
}

/** An in-memory FolderStore. */
export function memoryFolderStore(): FolderStore {
  const m = new Map<string, FileRecord>();
  return {
    get: async (id) => m.get(id),
    put: async (r) => void m.set(r.docId, { ...r }),
    all: async () => [...m.values()],
    delete: async (id) => void m.delete(id),
  };
}
