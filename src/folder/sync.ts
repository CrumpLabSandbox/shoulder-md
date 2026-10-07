/**
 * Mirrors documents into a folder: `<name>.md` (clean text) and `<name>.shoulder.json` (the
 * full document with its op log). Names are picked once from the title and then kept, so a
 * git history stays readable. See plan.md §5.
 *
 * Where the files go inside the folder is the layout's business (see `STRUCTURED`): each
 * document gets its own folder under `Documents/`, and style guides sit together in
 * `Style/Guides/`. Files found where an older layout left them are moved on the next write.
 *
 * Conflict rule: the browser copy wins, unless the files on disk changed and the browser did
 * not, in which case the caller asks the user. When both changed, the disk version is saved
 * next to the document as `<name>.conflict-<time>.md|.shoulder.json` before it is overwritten.
 */
import type { Document, Op } from '../model/types';
import { exportJson, importJson } from '../export/json';
import { PROPOSALS_EXT, REVISION_EXT, SKIPPED_EXT } from './proposals';
import { CHAT_EXT } from './chat';
import { slugify } from '../export/download';
import { displayTitle } from '../docs/title';
import { text as viewText } from '../model/views';
import { fileIfExists, listFileNames, writeFile, type DirHandleLike, type FileLike } from './fs';

/** Where a document's files live inside the folder, as a relative path; undefined is the top. */
export type Layout = (doc: Document, base: string) => string | undefined;

export const DOCUMENTS = 'Documents';
export const GUIDES = 'Style/Guides';
export const SAMPLES = 'Style/Samples';

/** One folder per document under Documents/, and all style guides together in Style/Guides/. */
export const STRUCTURED: Layout = (doc, base) =>
  doc.state.meta.guide ? GUIDES : `${DOCUMENTS}/${base}`;
/** Everything at the top of the folder: how files were laid out before, still read for moving. */
export const FLAT: Layout = () => undefined;

export type Stat = { lastModified: number; size: number };

export type FileRecord = {
  docId: string;
  /** File name stem: `<base>.md` and `<base>.shoulder.json`. */
  base: string;
  /** The folder holding the files, relative to the synced folder; absent means its top level. */
  folder?: string;
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
  /** Set when the files were only moved to where the layout wants them. */
  moved?: boolean;
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
    private readonly layout: Layout = STRUCTURED,
  ) {}

  /** The directory at a relative path, or undefined if it is not there (and not created). */
  private async at(folder: string | undefined, create = false): Promise<DirHandleLike | undefined> {
    let dir = this.dir;
    for (const part of (folder ?? '').split('/').filter(Boolean)) {
      try {
        dir = await dir.getDirectoryHandle(part, { create });
      } catch (e) {
        if (e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError'))
          return undefined;
        throw e;
      }
    }
    return dir;
  }

  private async fileAt(folder: string | undefined, name: string) {
    const dir = await this.at(folder);
    return dir && fileIfExists(dir, name);
  }

  private async put(folder: string | undefined, name: string, content: string): Promise<FileLike> {
    return writeFile((await this.at(folder, true))!, name, content);
  }

  private async drop(folder: string | undefined, name: string): Promise<boolean> {
    const dir = await this.at(folder);
    if (!dir || !(await fileIfExists(dir, name))) return false;
    await dir.removeEntry(name);
    return true;
  }

  /** Creates the folders a person is meant to see and use, including the one for samples. */
  async prepare(): Promise<void> {
    if (this.layout !== STRUCTURED) return;
    for (const folder of [DOCUMENTS, GUIDES, SAMPLES]) await this.at(folder, true);
    const samples = (await this.at(SAMPLES))!;
    if (!(await fileIfExists(samples, 'README.md')))
      await writeFile(
        samples,
        'README.md',
        '# Samples\n\nPut examples of your own writing here, one folder per genre (for example `Grants/`, `Blog/`).\nAny format is fine. The app never changes these files; Claude Code reads them when you ask it\nto draft or extend a style guide.\n',
      );
  }

  get name(): string {
    return this.dir.name;
  }

  /** The record for a document, assigning a file name on first use. */
  async recordFor(doc: Document): Promise<FileRecord> {
    const existing = await this.store.get(doc.id);
    if (existing) return existing;
    const base = await this.freeBase(doc);
    const folder = this.layout(doc, base);
    const record: FileRecord = { docId: doc.id, base, ...(folder ? { folder } : {}), opCount: -1 };
    await this.store.put(record);
    return record;
  }

  /** A file name stem for the document, from its title, that no other document is using. */
  private async freeBase(doc: Document): Promise<string> {
    const used = new Set((await this.store.all()).map((r) => r.base));
    const stem = slugify(displayTitle(doc.state.meta.title, viewText(doc.state, 'clean')));
    let base = stem;
    for (let i = 2; ; i++) {
      const folder = this.layout(doc, base);
      const dir = await this.at(folder);
      const taken = new Set(dir ? await listFileNames(dir) : []);
      if (!taken.has(base + MD) && !taken.has(base + JSON_EXT) && !used.has(base)) break;
      // A file with this name that is this document's own (e.g. after reconnecting) is fine.
      if (
        taken.has(base + JSON_EXT) &&
        (await this.jsonId(folder, base + JSON_EXT)) === doc.id &&
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

  /**
   * Removes a document's files from where they used to be, carrying waiting proposals and
   * kept conflict copies to the new place. A document folder left empty is removed too.
   */
  private async retire(
    old: { folder?: string; base: string },
    now: { folder?: string; base: string },
  ): Promise<void> {
    const from = await this.at(old.folder);
    if (!from) return;
    const carried = [PROPOSALS_EXT, SKIPPED_EXT, REVISION_EXT, CHAT_EXT].map(
      (ext) => old.base + ext,
    );
    for (const name of await listFileNames(from))
      if (name.startsWith(`${old.base}.conflict-`)) carried.push(name);
    for (const name of carried) {
      const h = await fileIfExists(from, name);
      if (!h) continue;
      await this.put(
        now.folder,
        now.base + name.slice(old.base.length),
        await (await h.getFile()).text(),
      );
      await from.removeEntry(name);
    }
    for (const ext of [MD, JSON_EXT]) await this.drop(old.folder, old.base + ext);
    await this.removeIfEmpty(old.folder);
  }

  /** Removes a document's own folder once nothing is left in it. Shared folders are kept. */
  private async removeIfEmpty(folder: string | undefined): Promise<void> {
    if (!folder?.startsWith(DOCUMENTS + '/')) return;
    const dir = await this.at(folder);
    if (!dir) return;
    for await (const entry of dir.values()) if (entry) return;
    const parent = await this.at(DOCUMENTS);
    await parent?.removeEntry(folder.slice(DOCUMENTS.length + 1));
  }

  private async jsonId(folder: string | undefined, name: string): Promise<string | undefined> {
    try {
      const f = await this.fileAt(folder, name);
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
    const jsonHandle = await this.fileAt(rec.folder, jsonName);
    const mdHandle = await this.fileAt(rec.folder, mdName);
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
    // Only rename or move when nothing outside is waiting to be settled at the old place.
    // Files claimed where an older layout left them are first compared in place (so nothing on
    // disk is lost), and moved by the write after that.
    const claimedElsewhere = rec.opCount < 0 && rec.folder !== this.layout(doc, rec.base);
    const settled = (external.kind === 'none' || external.kind === 'missing') && !claimedElsewhere;
    const renameTo = settled ? await this.settledName(doc, rec) : undefined;
    const base = renameTo ?? rec.base;
    const folder = settled ? this.layout(doc, base) : rec.folder;
    const relocating = base !== rec.base || folder !== rec.folder;

    if (external.kind === 'md' || external.kind === 'json' || external.kind === 'invalid') {
      if (!browserChanged && !opts.force) return { written: false, external, backups };
      backups.push(...(await this.backup(rec)));
    } else if (!browserChanged && external.kind === 'none' && !opts.force && !relocating) {
      return { written: false, backups };
    } else if (rec.opCount < 0 || (relocating && !renameTo)) {
      // First write to this place: keep anything already there that differs from what we write.
      backups.push(...(await this.backupIfDifferent({ ...rec, base, folder }, doc)));
    }

    const md = await this.put(folder, base + MD, viewText(doc.state, 'clean'));
    const json = await this.put(folder, base + JSON_EXT, exportJson(doc));
    const next: FileRecord = {
      ...rec,
      base,
      md: statOf(md),
      json: statOf(json),
      opCount: doc.ops.length,
      stamp: doc.updatedAt,
      writtenAt: this.now().toISOString(),
    };
    if (folder === undefined) delete next.folder;
    else next.folder = folder;
    await this.store.put(next);
    if (claimedElsewhere) {
      const moved = await this.write(doc);
      return { ...moved, written: true, backups: [...backups, ...moved.backups] };
    }
    if (!relocating) return { written: true, backups };
    await this.retire(rec, { folder, base });
    return renameTo
      ? { written: true, backups, renamed: { from: rec.base + MD, to: renameTo + MD } }
      : { written: true, backups, moved: true };
  }

  private async backup(rec: FileRecord): Promise<string[]> {
    const out: string[] = [];
    const suffix = `.conflict-${stamp(this.now())}`;
    for (const ext of [MD, JSON_EXT]) {
      const h = await this.fileAt(rec.folder, rec.base + ext);
      if (!h) continue;
      const f = await h.getFile();
      const recorded = ext === MD ? rec.md : rec.json;
      if (same(recorded, statOf(f))) continue; // unchanged since our write: nothing to keep
      const name = rec.base + suffix + ext;
      await this.put(rec.folder, name, await f.text());
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
    const jsonHandle = await this.fileAt(rec.folder, rec.base + JSON_EXT);
    if (jsonHandle) {
      try {
        const disk = importJson(await (await jsonHandle.getFile()).text()).doc;
        if (disk.id === doc.id && disk.ops.every((op, i) => doc.ops[i]?.id === op.id)) return out;
      } catch {
        // unreadable: fall through and keep it
      }
    }
    for (const ext of [MD, JSON_EXT]) {
      const h = await this.fileAt(rec.folder, rec.base + ext);
      if (!h) continue;
      const text = await (await h.getFile()).text();
      if (text === wanted[ext]) continue;
      const name = rec.base + suffix + ext;
      await this.put(rec.folder, name, text);
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
      if (await this.drop(rec.folder, name)) removed.push(name);
    }
    for (const ext of [PROPOSALS_EXT, SKIPPED_EXT, REVISION_EXT, CHAT_EXT])
      await this.drop(rec.folder, rec.base + ext);
    await this.removeIfEmpty(rec.folder);
    await this.store.delete(docId);
    return removed;
  }

  /** The path of a document's Markdown file inside this folder, once it has been written. */
  async fileName(docId: string): Promise<string | undefined> {
    const rec = await this.store.get(docId);
    if (!rec || rec.opCount < 0) return undefined;
    return (rec.folder ? rec.folder + '/' : '') + rec.base + MD;
  }

  /**
   * The proposals file waiting next to a document, if any. `key` changes when the file does,
   * so a caller can tell a file it has already looked at from a new one.
   */
  async proposals(docId: string): Promise<{ file: string; text: string; key: string } | undefined> {
    const rec = await this.store.get(docId);
    if (!rec) return undefined;
    const file = rec.base + PROPOSALS_EXT;
    const handle = await this.fileAt(rec.folder, file);
    if (!handle) return undefined;
    const f = await handle.getFile();
    return { file, text: await f.text(), key: `${docId}:${f.lastModified}:${f.size}` };
  }

  /** Removes a document's proposals file once handled, keeping `leftover` beside it if given. */
  async clearProposals(docId: string, leftover?: string): Promise<void> {
    const rec = await this.store.get(docId);
    if (!rec) return;
    if (leftover !== undefined) await this.put(rec.folder, rec.base + SKIPPED_EXT, leftover);
    await this.drop(rec.folder, rec.base + PROPOSALS_EXT);
  }

  /** A revised copy of the document waiting next to it, if any (see proposals.ts). */
  async revision(docId: string): Promise<{ file: string; text: string; key: string } | undefined> {
    const rec = await this.store.get(docId);
    if (!rec) return undefined;
    const file = rec.base + REVISION_EXT;
    const handle = await this.fileAt(rec.folder, file);
    if (!handle) return undefined;
    const f = await handle.getFile();
    return { file, text: await f.text(), key: `${docId}:${f.lastModified}:${f.size}` };
  }

  async clearRevision(docId: string): Promise<void> {
    const rec = await this.store.get(docId);
    if (rec) await this.drop(rec.folder, rec.base + REVISION_EXT);
  }

  /** The saved conversation with Claude about a document, if there is one (see chat.ts). */
  async chat(docId: string): Promise<string | undefined> {
    const rec = await this.store.get(docId);
    const handle = rec && (await this.fileAt(rec.folder, rec.base + CHAT_EXT));
    return handle ? (await handle.getFile()).text() : undefined;
  }

  /** Adds to a document's saved conversation, starting the file with `header` if it is new. */
  async appendChat(docId: string, addition: string, header: string): Promise<void> {
    const rec = await this.store.get(docId);
    if (!rec || rec.opCount < 0) return;
    const existing = await this.chat(docId);
    await this.put(rec.folder, rec.base + CHAT_EXT, (existing ?? header) + addition);
  }

  /** Whether this folder holds (or last held) the document's files. */
  async has(docId: string): Promise<boolean> {
    return !!(await this.store.get(docId));
  }

  /** Every place a document's files may be: the layout's folders, and the top level (older). */
  private async places(): Promise<(string | undefined)[]> {
    const out: (string | undefined)[] = [undefined];
    if (this.layout !== STRUCTURED) return out;
    out.push(GUIDES);
    const docs = await this.at(DOCUMENTS);
    if (docs)
      for await (const entry of docs.values())
        if (entry.kind === 'directory') out.push(`${DOCUMENTS}/${entry.name}`);
    return out;
  }

  /**
   * Documents in the folder that the browser does not have: every readable `*.shoulder.json`
   * whose id is neither known nor deleted here. Their file names are recorded as theirs.
   */
  async scan(knownIds: Iterable<string>, deletedIds: Iterable<string>): Promise<Document[]> {
    const known = new Set(knownIds);
    const deleted = new Set(deletedIds);
    const found: Document[] = [];
    for (const folder of await this.places()) {
      const dir = await this.at(folder);
      if (!dir) continue;
      const place = folder === undefined ? {} : { folder };
      for (const name of await listFileNames(dir)) {
        if (!name.endsWith(JSON_EXT) || name.includes('.conflict-')) continue;
        const h = await fileIfExists(dir, name);
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
          if (found.some((d) => d.id === doc.id)) continue;
          found.push(doc);
          const md = await fileIfExists(dir, base + MD);
          await this.store.put({
            docId: doc.id,
            base,
            ...place,
            json: statOf(file),
            ...(md ? { md: statOf(await md.getFile()) } : {}),
            opCount: doc.ops.length,
          });
        } else if (!(await this.store.get(doc.id))) {
          // A document both sides have, not yet linked to its files here: claim the name. The
          // next write compares histories and keeps anything that would be lost.
          await this.store.put({ docId: doc.id, base, ...place, opCount: -1 });
        }
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
