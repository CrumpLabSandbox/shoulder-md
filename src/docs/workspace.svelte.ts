import {
  appendOps,
  createDoc,
  deleteDoc,
  importDocument,
  appendToStored,
  libraryEntries as storedLibraryEntries,
  listDocs,
  loadDoc,
  addTombstone,
  clearFolderRecords,
  getFolderRoot,
  getTombstones,
  idbFolderStore,
  setFolderRoot,
  type DocSummary,
  type FolderKind,
  type LibraryEntry,
} from '../persist/idb';
import { FolderSync, type External } from '../folder/sync';
import { folderSupported, permissionOf, pickFolder, type DirHandleLike } from '../folder/fs';
import { cleanToRevision, editsToMatch, type OpBuilder } from '../folder/merge';
import {
  baseGuideTemplate,
  genreGuideTemplate,
  genrePrefix,
  numberingEdits,
  parsePrinciples,
  resolvePrinciples,
  type ResolvedPrinciple,
} from '../guides/principles';
import { docStats } from '../library/stats';
import { changeRecords, toJsonl, type RecordOptions } from '../library/records';
import type { DocMeta, MetaPatch } from '../model/types';
import { exportCriticMarkup, exportMarkdown, documentFromCriticMarkup } from '../export/markdown';
import { exportJson, importJson } from '../export/json';
import { downloadBlob, downloadText, slugify } from '../export/download';
import { printDocument, printHtml } from '../export/print';
import { createAutosave, type SaveStatus } from '../persist/autosave';
import { displayTitle } from './title';
import { authorColor, DISK_AUTHOR } from './identity';
import { nowIso, isoAt } from '../util/time';
import type { Author, Document, Op } from '../model/types';
import { appendOp, revisionText } from '../model/apply';
import {
  absoluteToPos,
  commentRanges,
  markedRanges,
  text as viewText,
  type CommentRange,
  type View,
} from '../model/views';
import type { CommentThread } from '../model/types';
import {
  pendingChanges,
  shouldCoalesce,
  type LastEdit,
  type PendingChange,
} from '../model/changes';
import { ulid } from '../model/ids';
import type { EditorBridge, Selection, Transaction } from '../editor/createEditor';
import { bufferChangesFor } from '../editor/sync';

const LAST_DOC_KEY = 'shoulder-md:lastDoc';
const UNDO_GROUP_MS = 500;
const UNDO_LIMIT = 500;
const FOLDER_WRITE_MS = 800;
const FOLDER_POLL_MS = 2000;

export type FolderStatus =
  | { status: 'unsupported' }
  | { status: 'none' }
  | { status: 'needs-permission'; name: string }
  | { status: 'connected'; name: string; lastWrite?: number }
  | { status: 'error'; name: string; error: string };

/** A change on disk the user has to decide about. */
export type ExternalChange = {
  docId: string;
  ext: Exclude<External, { kind: 'none' } | { kind: 'missing' }>;
};

const WELCOME = `# Welcome to shoulder-md

A Markdown editor with Word-style **tracked changes**. Underneath, every edit is recorded as an operation on a sentence-level model, so nothing about a document's editing history is lost.

- Turn on **Track changes** in the toolbar (⌘⌥T) and edit this paragraph: deletions stay struck through, insertions are underlined, and a card appears in the margin.
- Accept or reject a change from its card, or with ⌘⌥A and ⌘⌥R while the cursor is in it. ⌘⌥N and ⌘⌥P jump between changes.
- Add a reason to a change from its card. Reasons are the point: the library of edits with reasons is what will teach Claude to edit like you.
- Switch between **Markup**, **Clean**, and **Original** views to see the document with changes shown, applied, or rejected.
- Everything is saved in the background, in this browser. Open **Settings** (⌘,) for fonts, themes, and your author name.

> Comments, exports, and the edits library arrive in the next phases. See plan.md in the repo.
`;

type SaveBatch = { doc: Document; ops: Op[]; force: boolean };

type UndoEntry = {
  /** Applied in order, each valid in the state the previous one leaves. */
  ops: Op[];
  before: Selection;
  after: Selection;
  at: number;
  changeId?: string;
};

/** Reactive workspace: the document list, the open document, its op log, autosave, and editing commands. */
export type WorkspaceOptions = {
  /** Whether new documents join the edits library. */
  libraryDefault?: () => boolean;
};

export function createWorkspace(initialAuthor: Author, options: WorkspaceOptions = {}) {
  let author = $state.raw<Author>(initialAuthor);
  // Raw state: replaced wholesale, never mutated in place, and the document goes to IndexedDB
  // as-is. A deep $state proxy would fail structured cloning.
  let docs = $state.raw<DocSummary[]>([]);
  let current = $state.raw<Document | undefined>(undefined);
  let text = $state('');
  let version = $state(0);
  let view = $state<View>('revision');
  let saveStatus = $state<SaveStatus>('saved');
  let saveError = $state<string | undefined>(undefined);
  let lastSavedAt = $state<number | undefined>(undefined);
  let ready = $state(false);
  let cursor = $state(0);
  let lastEdit: LastEdit | undefined;
  let bridge: EditorBridge | undefined;
  let undoStack: UndoEntry[] = [];
  let redoStack: UndoEntry[] = [];
  let canUndo = $state(false);
  let canRedo = $state(false);

  const pending = $derived<PendingChange[]>(current ? pendingChanges(current.state) : []);
  const trackingOn = $derived(current?.state.trackingOn ?? false);
  const authors = $derived<Author[]>(current ? mergeAuthors(current.authors, author) : [author]);
  const colors = $derived<Record<string, string>>(
    Object.fromEntries(
      [author.id, ...pending.map((c) => c.author)]
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .map((id) => [id, authorColor(id, authors)]),
    ),
  );
  const activeChangeId = $derived<string | undefined>(
    pending.find((c) => c.ranges.some((r) => cursor >= r.from && cursor <= r.to))?.id,
  );
  const displayText = $derived(
    view === 'revision' || !current ? text : viewText(current.state, view),
  );

  /* ---------- comments ---------- */

  let showResolved = $state(false);
  /** A change whose reason field should open and take focus (⌘⌥E). Cleared by the card. */
  let reasonRequest = $state<string | undefined>(undefined);
  let draft = $state.raw<{ from: number; to: number } | undefined>(undefined);
  const threads = $derived<Thread[]>(
    current
      ? commentRanges(current.state).map((r) => ({
          ...r,
          thread: current!.state.comments.find((t) => t.id === r.threadId)!,
        }))
      : [],
  );
  const visibleThreads = $derived(threads.filter((t) => showResolved || !t.resolved));
  const activeThreadId = $derived<string | undefined>(
    visibleThreads.find((t) => !t.orphaned && cursor >= t.from && cursor <= t.to)?.threadId,
  );

  const autosave = createAutosave<SaveBatch>({
    save: async ({ doc, ops, force }) => {
      await appendOps(doc, ops, { forceSnapshot: force });
      lastSavedAt = Date.now();
      if (syncs.shared || syncs.private) folderWriter.schedule({ doc, force: false });
      docs = docs
        .map((d) =>
          d.id === doc.id
            ? { id: d.id, createdAt: d.createdAt, updatedAt: doc.updatedAt, ...docStats(doc.state) }
            : d,
        )
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    merge: (a, b) => ({ doc: b.doc, ops: [...a.ops, ...b.ops], force: a.force || b.force }),
    onStatus: (s) => {
      saveStatus = s;
      saveError = s === 'error' ? String(autosave.lastError) : undefined;
    },
  });

  /* ---------- documents ---------- */

  async function refreshList() {
    docs = await listDocs();
  }

  async function init() {
    await refreshList();
    const lastId = safeGet(LAST_DOC_KEY);
    const target = (lastId && docs.find((d) => d.id === lastId)) || docs[0];
    if (target) {
      await open(target.id);
    } else {
      const doc = await createDoc({ text: WELCOME, author: author.id, tracking: false });
      await refreshList();
      await open(doc.id);
    }
    ready = true;
    await restoreFolders();
  }

  /** Flush pending ops and write a snapshot of the open document before leaving it. */
  async function park() {
    if (!current) return;
    autosave.schedule({ doc: current, ops: [], force: true });
    await autosave.flush();
    await folderWriter.flush();
  }

  async function open(id: string) {
    await park();
    const loaded = await loadDoc(id);
    if (!loaded) return;
    current = loaded.doc;
    text = revisionText(loaded.doc.state);
    view = 'revision';
    draft = undefined;
    lastEdit = undefined;
    undoStack = [];
    redoStack = [];
    canUndo = canRedo = false;
    safeSet(LAST_DOC_KEY, id);
    pushMarks();
    if (external && external.docId !== id) external = undefined;
    void poll();
  }

  async function create() {
    const doc = await createDoc({
      author: author.id,
      tracking: current?.state.trackingOn ?? false,
      libraryEligible: options.libraryDefault?.() ?? false,
    });
    await refreshList();
    await open(doc.id);
  }

  async function remove(id: string) {
    const wasCurrent = current?.id === id;
    if (wasCurrent) {
      await autosave.flush();
      current = undefined;
    }
    await deleteDoc(id);
    // Files in a connected folder are left alone, but must not come back on the next scan.
    await addTombstone(id);
    await refreshList();
    if (wasCurrent) {
      if (docs[0]) await open(docs[0].id);
      else await create();
    }
  }

  /* ---------- the editor bridge ---------- */

  function attachEditor(b: EditorBridge | undefined) {
    bridge = b;
    pushMarks();
  }

  function pushMarks() {
    if (!bridge || !current || view !== 'revision') return;
    const info = {
      ranges: markedRanges(current.state),
      colors,
      activeChangeId,
      comments: visibleThreads.map(({ thread: _t, ...r }) => {
        void _t;
        return r;
      }),
      activeThreadId,
      draft,
    };
    // Marks may be pushed from inside an editor update; defer the dispatch past it.
    queueMicrotask(() => bridge?.setMarks(info));
  }

  function setCursor(sel: Selection) {
    const wasChange = activeChangeId;
    const wasThread = activeThreadId;
    cursor = sel.head;
    if (activeChangeId !== wasChange || activeThreadId !== wasThread) pushMarks();
  }

  /* ---------- applying ops ---------- */

  function push(raw: Op): { op: Op; inverse: Op[] } {
    if (!current) throw new Error('No open document');
    // Ops come from UI code and may carry reactive proxies or undefined fields; store plain data.
    const op = JSON.parse(JSON.stringify(raw)) as Op;
    const r = appendOp(current, op);
    current = r.doc;
    return { op: r.op, inverse: r.inverse };
  }

  function schedule(ops: Op[], ts: string) {
    if (!current) return;
    current = { ...current, updatedAt: ts };
    autosave.schedule({ doc: current, ops, force: false });
  }

  /**
   * Applies model-originated ops (accept, reject, undo, redo), mirrors them into the buffer,
   * and returns the combined inverse. Positions in later ops must be valid after earlier ones.
   */
  function applyModelOps(ops: (Op | OpBuilder)[], selection?: Selection): Op[] {
    if (!current) return [];
    const inverses: Op[][] = [];
    const applied: Op[] = [];
    for (const item of ops) {
      const op = typeof item === 'function' ? item(current.state) : item;
      if (!op) continue;
      const before = current.state;
      const changes = bufferChangesFor(before, op);
      const r = push(op);
      applied.push(r.op);
      inverses.push(r.inverse);
      if (view === 'revision') bridge?.applyChanges(changes);
    }
    text = revisionText(current.state);
    if (selection) bridge?.setSelection(selection);
    schedule(applied, applied[applied.length - 1]?.ts ?? nowIso());
    lastEdit = undefined;
    pushMarks();
    return inverses.reverse().flat();
  }

  function recordUndo(entry: UndoEntry) {
    const last = undoStack[undoStack.length - 1];
    if (
      last &&
      entry.changeId &&
      last.changeId === entry.changeId &&
      entry.at - last.at < UNDO_GROUP_MS
    ) {
      // Same keystroke run: fold into the previous entry (new inverse runs first).
      undoStack[undoStack.length - 1] = {
        ...last,
        ops: [...entry.ops, ...last.ops],
        after: entry.after,
        at: entry.at,
      };
    } else {
      undoStack.push(entry);
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    redoStack = [];
    canUndo = undoStack.length > 0;
    canRedo = false;
  }

  function undo(): boolean {
    const entry = undoStack.pop();
    if (!entry) return false;
    const inverse = applyModelOps(entry.ops.map(stamp), entry.before);
    redoStack.push({ ...entry, ops: inverse });
    canUndo = undoStack.length > 0;
    canRedo = true;
    return true;
  }

  function redo(): boolean {
    const entry = redoStack.pop();
    if (!entry) return false;
    const inverse = applyModelOps(entry.ops.map(stamp), entry.after);
    undoStack.push({ ...entry, ops: inverse });
    canUndo = true;
    canRedo = redoStack.length > 0;
    return true;
  }

  /** Fresh id and time for an inverse op about to be logged. */
  function stamp(op: Op): Op {
    return { ...op, id: ulid(), ts: nowIso(), author: author.id };
  }

  /** Called by the editor for every user transaction. Turns it into edit ops and schedules a save. */
  function applyTransaction(tr: Transaction) {
    if (!current || tr.changes.length === 0) return;
    const at = Date.now();
    const ts = isoAt(at);
    const tracked = current.state.trackingOn;
    const single = tr.changes.length === 1 ? tr.changes[0]! : undefined;
    const coalesce =
      single !== undefined &&
      shouldCoalesce(lastEdit, {
        author: author.id,
        from: single.from,
        to: single.to,
        at,
        tracked,
      });
    const changeId = coalesce && lastEdit ? lastEdit.changeId : ulid();
    const before = bridge?.getSelection() ?? { anchor: 0, head: 0 };
    const newOps: Op[] = [];
    const inverses: Op[][] = [];
    // Later changes first, so earlier offsets stay valid in the pre-transaction coordinates.
    for (const ch of [...tr.changes].reverse()) {
      const op: Op = {
        id: ulid(),
        type: 'edit',
        author: author.id,
        ts,
        changeId,
        from: absoluteToPos(current.state, ch.from),
        to: absoluteToPos(current.state, ch.to),
        insert: ch.insert,
        tracked,
      };
      const r = push(op);
      newOps.push(r.op);
      inverses.push(r.inverse);
    }
    const modelText = revisionText(current.state);
    if (modelText !== tr.text) {
      // Safety net: the model and the buffer disagree. Log loudly and resync from the buffer.
      console.error('shoulder-md: model/buffer mismatch; resyncing from the editor buffer', {
        changes: tr.changes,
      });
      newOps.push(push({ id: ulid(), type: 'import', author: author.id, ts, text: tr.text }).op);
      version++;
      undoStack = [];
      redoStack = [];
      canUndo = canRedo = false;
    } else {
      recordUndo({
        ops: inverses.reverse().flat(),
        before,
        after: {
          anchor: single ? single.from + single.insert.length : before.head,
          head: single ? single.from + single.insert.length : before.head,
        },
        at,
        changeId,
      });
    }
    lastEdit = single
      ? { changeId, author: author.id, endOffset: single.from + single.insert.length, at, tracked }
      : undefined;
    text = tr.text;
    schedule(newOps, ts);
    pushMarks();
  }

  /* ---------- commands ---------- */

  function metaOp(partial: Omit<Extract<Op, { type: 'set_meta' }>, 'id' | 'author' | 'ts'>): void {
    const ts = nowIso();
    const r = push({ id: ulid(), author: author.id, ts, ...partial });
    schedule([r.op], ts);
  }

  function rename(title: string) {
    if (!current) return;
    metaOp({ type: 'set_meta', patch: { title: title.trim() } });
  }

  function setTracking(on: boolean) {
    if (!current || current.state.trackingOn === on) return;
    const ts = nowIso();
    const r = push({ id: ulid(), type: 'set_tracking', author: author.id, ts, on });
    schedule([r.op], ts);
    lastEdit = undefined;
  }

  function decide(type: 'accept' | 'reject', changeIds: string[]) {
    if (!current || changeIds.length === 0 || view !== 'revision') return;
    const sel = bridge?.getSelection() ?? { anchor: 0, head: 0 };
    const op: Op = { id: ulid(), type, author: author.id, ts: nowIso(), changeIds };
    const inverse = applyModelOps([op]);
    const after = bridge?.getSelection() ?? sel;
    recordUndo({ ops: inverse, before: sel, after, at: Date.now() });
  }

  function setReason(
    changeId: string,
    reason: string | undefined,
    reasonTags: string[] | undefined,
  ) {
    if (!current || !current.state.changes[changeId]) return;
    const ts = nowIso();
    const op: Op = { id: ulid(), type: 'set_reason', author: author.id, ts, changeId };
    if (reason !== undefined && reason.trim()) op.reason = reason.trim();
    if (reasonTags && reasonTags.length) op.reasonTags = reasonTags;
    const r = push(op);
    schedule([r.op], ts);
  }

  /** Starts composing a comment on the current selection (or the word at the cursor). */
  function startComment(): boolean {
    if (!current || !bridge || view !== 'revision') return false;
    const sel = bridge.getSelection();
    let from = Math.min(sel.anchor, sel.head);
    let to = Math.max(sel.anchor, sel.head);
    if (from === to) {
      // No selection: the word at the cursor.
      const t = text;
      while (from > 0 && /[\p{L}\p{N}'’-]/u.test(t[from - 1]!)) from--;
      while (to < t.length && /[\p{L}\p{N}'’-]/u.test(t[to]!)) to++;
      if (from === to) return false;
    }
    draft = { from, to };
    pushMarks();
    return true;
  }

  function cancelComment() {
    draft = undefined;
    pushMarks();
  }

  function anchorFor(from: number, to: number) {
    if (!current) throw new Error('No open document');
    const start = absoluteToPos(current.state, from);
    const end = absoluteToPos(current.state, Math.max(from, to));
    const ids: string[] = [];
    let collecting = false;
    outer: for (const b of current.state.blocks)
      for (const s of b.sentences) {
        if (s.id === start.sentenceId) collecting = true;
        if (collecting) ids.push(s.id);
        if (s.id === end.sentenceId) break outer;
      }
    return { sentenceIds: ids, from: start.offset, to: end.offset };
  }

  /** Posts the draft comment, or a comment on a change. */
  function addComment(body: string, opts: { changeId?: string } = {}): string | undefined {
    if (!current || !body.trim()) return undefined;
    let range = draft;
    if (opts.changeId) {
      const c = pending.find((x) => x.id === opts.changeId);
      range = c ? { from: c.ranges[0]!.from, to: c.ranges[c.ranges.length - 1]!.to } : undefined;
    }
    if (!range) return undefined;
    const ts = nowIso();
    const threadId = ulid();
    const op: Op = {
      id: ulid(),
      type: 'comment_add',
      author: author.id,
      ts,
      threadId,
      commentId: ulid(),
      anchor: anchorFor(range.from, range.to),
      body: body.trim(),
      ...(opts.changeId ? { changeId: opts.changeId } : {}),
    };
    const r = push(op);
    schedule([r.op], ts);
    draft = undefined;
    pushMarks();
    return threadId;
  }

  function reply(threadId: string, body: string) {
    if (!current || !body.trim()) return;
    const ts = nowIso();
    const r = push({
      id: ulid(),
      type: 'comment_reply',
      author: author.id,
      ts,
      threadId,
      commentId: ulid(),
      body: body.trim(),
    });
    schedule([r.op], ts);
  }

  function editComment(threadId: string, commentId: string, body: string) {
    if (!current || !body.trim()) return;
    const ts = nowIso();
    const r = push({
      id: ulid(),
      type: 'comment_edit',
      author: author.id,
      ts,
      threadId,
      commentId,
      body: body.trim(),
    });
    schedule([r.op], ts);
  }

  function setResolved(threadId: string, resolved: boolean) {
    if (!current) return;
    const ts = nowIso();
    const r = push({
      id: ulid(),
      type: 'comment_resolve',
      author: author.id,
      ts,
      threadId,
      resolved,
    });
    schedule([r.op], ts);
    pushMarks();
  }

  function jumpToThread(threadId: string) {
    const t = threads.find((x) => x.threadId === threadId);
    if (!t || !bridge) return;
    bridge.setSelection({ anchor: t.from, head: t.from });
    bridge.focus();
  }

  /* ---------- export and import ---------- */

  type ExportKind =
    'md-clean' | 'md-original' | 'md-critic' | 'json' | 'docx' | 'print-clean' | 'print-markup';

  async function exportAs(kind: ExportKind): Promise<void> {
    if (!current) return;
    await autosave.flush();
    const doc = current;
    const title = displayTitle(doc.state.meta.title, viewText(doc.state, 'clean'));
    const stem = slugify(title);
    switch (kind) {
      case 'md-clean':
        return downloadText(
          `${stem}.md`,
          exportMarkdown(doc.state, 'clean'),
          'text/markdown;charset=utf-8',
        );
      case 'md-original':
        return downloadText(
          `${stem}.original.md`,
          exportMarkdown(doc.state, 'original'),
          'text/markdown;charset=utf-8',
        );
      case 'md-critic':
        return downloadText(
          `${stem}.changes.md`,
          exportCriticMarkup(doc.state, { authors }),
          'text/markdown;charset=utf-8',
        );
      case 'json':
        return downloadText(`${stem}.shoulder.json`, exportJson(doc), 'application/json');
      case 'docx': {
        const { exportDocx } = await import('../export/docx');
        const blob = await exportDocx(doc, { authors, creator: author.name });
        return downloadBlob(`${stem}.docx`, blob);
      }
      case 'print-clean':
        return printDocument(printHtml(doc.state, 'clean', authors), title);
      case 'print-markup':
        return printDocument(printHtml(doc.state, 'markup', authors), title);
    }
  }

  let importNotice = $state<string | undefined>(undefined);

  /** Imports a .md (plain or CriticMarkup) or .shoulder.json file as a new document and opens it. */
  async function importFile(file: File): Promise<void> {
    const text = await file.text();
    const stem = file.name.replace(/\.(shoulder\.json|json|md|markdown|txt)$/i, '');
    let doc;
    try {
      if (/\.json$/i.test(file.name)) {
        const r = importJson(text);
        doc = r.doc;
        importNotice = r.repaired
          ? 'Imported; the stored state did not match the op log and was rebuilt from the log.'
          : undefined;
      } else {
        const hasMarkup = /\{(\+\+|--|~~|==|>>)/.test(text);
        doc = documentFromCriticMarkup(text, {
          author: author.id,
          tracking: hasMarkup,
          libraryEligible: options.libraryDefault?.() ?? false,
          title: stem,
        });
        importNotice = undefined;
      }
    } catch (e) {
      importNotice = `Import failed: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const stored = await importDocument(doc);
    await refreshList();
    await open(stored.id);
  }

  /* ---------- folder sync ---------- */

  // Two folders: 'shared' is where Claude Code may work; 'private' holds documents with Claude
  // switched off. Each document is written to the one its Claude access allows.
  const initialFolder: FolderStatus = folderSupported()
    ? { status: 'none' }
    : { status: 'unsupported' };
  let folders = $state.raw<Record<FolderKind, FolderStatus>>({
    shared: initialFolder,
    private: initialFolder,
  });
  let external = $state.raw<ExternalChange | undefined>(undefined);
  let folderNotice = $state<string | undefined>(undefined);
  const syncs: Record<FolderKind, FolderSync | undefined> = {
    shared: undefined,
    private: undefined,
  };
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let polling = false;

  const isConnected = (kind: FolderKind) => !!syncs[kind] && folders[kind].status === 'connected';
  const setFolder = (kind: FolderKind, s: FolderStatus) => (folders = { ...folders, [kind]: s });
  const folderName = (kind: FolderKind) => {
    const f = folders[kind];
    return f.status === 'none' || f.status === 'unsupported' ? '' : f.name;
  };

  type FolderBatch = { doc: Document; force: boolean };
  const folderWriter = createAutosave<FolderBatch>({
    delayMs: FOLDER_WRITE_MS,
    save: async ({ doc, force }) => syncDoc(doc, force),
    // Pending writes are always for the open document: park() flushes before switching.
    merge: (a, b) => ({ doc: b.doc, force: a.force || b.force }),
  });

  type AccessMeta = Pick<DocMeta, 'claude' | 'genre' | 'guide'>;

  /**
   * Whether Claude may work with a document: its own switch if set, otherwise its genre's
   * default (on, unless the genre is private). A genre that no longer exists keeps Claude off,
   * so deleting a private genre never exposes its documents. A private genre's own guide is
   * private too.
   */
  function claudeAllowed(meta: AccessMeta): boolean {
    if (meta.claude !== undefined) return meta.claude;
    if (meta.guide?.role === 'genre') return !meta.guide.private;
    if (!meta.genre) return true;
    const genre = docs.find((d) => d.id === meta.genre && d.guide?.role === 'genre');
    if (!genre) return false;
    return !genre.guide?.private;
  }

  function metaOf(id: string): AccessMeta {
    if (current?.id === id) return current.state.meta;
    return docs.find((d) => d.id === id) ?? {};
  }

  const folderFor = (meta: AccessMeta): FolderKind => (claudeAllowed(meta) ? 'shared' : 'private');

  /** Writes one document to its folder (moving it out of the other), or records an outside change. */
  async function syncDoc(doc: Document, force = false): Promise<void> {
    const kind = folderFor(doc.state.meta);
    const other: FolderKind = kind === 'shared' ? 'private' : 'shared';
    const otherSync = syncs[other];
    if (otherSync && isConnected(other)) {
      try {
        if (await otherSync.has(doc.id)) await otherSync.remove(doc.id);
      } catch (e) {
        folderFailed(other, e);
      }
    }
    const target = syncs[kind];
    if (!target || !isConnected(kind)) return;
    if (!force && external?.docId === doc.id) return; // waiting for the user to decide
    try {
      const r = await target.write(doc, { force });
      // Ask only if the browser has not moved on since this copy was queued. If it has, a newer
      // write is on its way and will apply the rule: the browser wins, the disk copy is kept.
      const movedOn =
        !current || current.ops.length !== doc.ops.length || autosave.status !== 'saved';
      if (r.external && doc.id === current?.id && !movedOn)
        external = { docId: doc.id, ext: r.external };
      if (r.backups.length) {
        folderNotice = `The copy on disk had changed too, so it was saved as ${r.backups.join(' and ')} before your version was written.`;
      }
      const f = folders[kind];
      if (r.written && f.status === 'connected') setFolder(kind, { ...f, lastWrite: Date.now() });
    } catch (e) {
      folderFailed(kind, e);
    }
  }

  function folderFailed(kind: FolderKind, e: unknown) {
    const name = folderName(kind);
    syncs[kind] = undefined;
    if (!syncs.shared && !syncs.private) stopPolling();
    setFolder(
      kind,
      e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
        ? { status: 'needs-permission', name }
        : { status: 'error', name, error: e instanceof Error ? e.message : String(e) },
    );
  }

  /** Starts syncing with a granted folder: imports its documents, then writes ours. */
  async function activate(kind: FolderKind, handle: DirHandleLike): Promise<void> {
    const sync = new FolderSync(handle, idbFolderStore(kind));
    syncs[kind] = sync;
    setFolder(kind, { status: 'connected', name: handle.name });
    try {
      const found = await sync.scan(
        docs.map((d) => d.id),
        await getTombstones(),
      );
      for (const d of found) await importDocument(d);
      if (found.length) {
        await refreshList();
        folderNotice = `Added ${found.length} ${found.length === 1 ? 'document' : 'documents'} from “${handle.name}”.`;
      }
      await writeAll();
      startPolling();
    } catch (e) {
      folderFailed(kind, e);
    }
  }

  async function writeAll(): Promise<void> {
    await park();
    for (const d of docs) {
      const doc = current?.id === d.id ? current : (await loadDoc(d.id))?.doc;
      if (doc) await syncDoc(doc);
    }
  }

  /** On startup: use remembered folders the browser still allows, else offer to reconnect. */
  async function restoreFolders(): Promise<void> {
    for (const kind of ['shared', 'private'] as const) {
      if (folders[kind].status === 'unsupported') continue;
      const root = await getFolderRoot(kind);
      if (!root) continue;
      try {
        const perm = await permissionOf(root.handle);
        if (perm === 'granted') await activate(kind, root.handle);
        else setFolder(kind, { status: 'needs-permission', name: root.name });
      } catch (e) {
        setFolder(kind, {
          status: 'error',
          name: root.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /** Picks a folder (from a click) and starts syncing documents to it. */
  async function connectFolder(kind: FolderKind = 'shared'): Promise<void> {
    let handle: DirHandleLike;
    try {
      handle = await pickFolder();
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      folderNotice = `Could not open the folder: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const otherRoot = await getFolderRoot(kind === 'shared' ? 'private' : 'shared');
    if (otherRoot && 'isSameEntry' in otherRoot.handle) {
      const same = await (
        otherRoot.handle as unknown as { isSameEntry(h: unknown): Promise<boolean> }
      ).isSameEntry(handle);
      if (same) {
        folderNotice = 'The shared and private folders must be different folders.';
        return;
      }
    }
    syncs[kind] = undefined;
    await clearFolderRecords(kind);
    await setFolderRoot({ handle, name: handle.name, connectedAt: nowIso() }, kind);
    await activate(kind, handle);
  }

  /** Asks the browser for permission again (needs a click) and resumes syncing. */
  async function reconnectFolder(kind: FolderKind = 'shared'): Promise<void> {
    const root = await getFolderRoot(kind);
    if (!root) return void setFolder(kind, { status: 'none' });
    try {
      const perm = await permissionOf(root.handle, true);
      if (perm === 'granted') await activate(kind, root.handle);
      else setFolder(kind, { status: 'needs-permission', name: root.name });
    } catch (e) {
      setFolder(kind, {
        status: 'error',
        name: root.name,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function disconnectFolder(kind: FolderKind = 'shared'): Promise<void> {
    await folderWriter.flush();
    syncs[kind] = undefined;
    if (!syncs.shared && !syncs.private) stopPolling();
    if (kind === folderFor(current?.state.meta ?? {})) external = undefined;
    await setFolderRoot(undefined, kind);
    await clearFolderRecords(kind);
    setFolder(kind, { status: 'none' });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => void poll(), FOLDER_POLL_MS);
    globalThis.addEventListener?.('focus', onFocus);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    globalThis.removeEventListener?.('focus', onFocus);
  }

  function onFocus() {
    void poll();
  }

  /** Looks for outside changes to the open document's files, in whichever folder holds it. */
  async function poll(): Promise<void> {
    const doc = current;
    if (!doc || external || polling) return;
    const kind = folderFor(doc.state.meta);
    const sync = syncs[kind];
    if (!sync || !isConnected(kind)) return;
    // Unsaved browser changes win anyway; the next write handles any conflict.
    if (autosave.status !== 'saved' || folderWriter.status !== 'saved') return;
    polling = true;
    try {
      const ext = await sync.check(doc);
      if (current?.id !== doc.id || current.ops.length !== doc.ops.length) return;
      if (ext.kind === 'missing') folderWriter.schedule({ doc, force: false });
      else if (ext.kind !== 'none') external = { docId: doc.id, ext };
    } catch (e) {
      folderFailed(kind, e);
    } finally {
      polling = false;
    }
  }

  /**
   * Settles an outside change. 'disk' takes it in: Markdown edits become tracked changes by
   * "Edited on disk", new ops from another tool are appended, and a different history replaces
   * the document. 'mine' keeps the browser version, saving the disk version as a conflict file.
   */
  async function resolveExternal(choice: 'disk' | 'mine'): Promise<void> {
    const e = external;
    external = undefined;
    if (!e || !current || e.docId !== current.id) return;
    if (choice === 'mine' || e.ext.kind === 'invalid') {
      await syncDoc(current, true);
      return;
    }
    if (e.ext.kind === 'md') {
      const sel = bridge?.getSelection() ?? { anchor: 0, head: 0 };
      const builders = editsToMatch(current.state, e.ext.text, {
        author: DISK_AUTHOR,
        ts: nowIso(),
        id: ulid,
      });
      const inverse = applyModelOps(builders);
      recordUndo({
        ops: inverse,
        before: sel,
        after: bridge?.getSelection() ?? sel,
        at: Date.now(),
      });
    } else if (e.ext.extendsLocal) {
      const fresh = e.ext.doc.ops.slice(current.ops.length);
      const sel = bridge?.getSelection() ?? { anchor: 0, head: 0 };
      const inverse = applyModelOps(fresh);
      recordUndo({
        ops: inverse,
        before: sel,
        after: bridge?.getSelection() ?? sel,
        at: Date.now(),
      });
    } else {
      const id = current.id;
      await autosave.flush();
      current = undefined;
      await deleteDoc(id);
      await importDocument(e.ext.doc);
      await refreshList();
      await open(id);
      version++;
    }
    await autosave.flush();
    if (current) await syncDoc(current, true);
  }

  /* ---------- style guides, genres and Claude access ---------- */

  const baseGuide = $derived(docs.find((d) => d.guide?.role === 'base'));
  const genres = $derived(docs.filter((d) => d.guide?.role === 'genre'));
  const currentGenre = $derived(
    current?.state.meta.genre ? genres.find((g) => g.id === current!.state.meta.genre) : undefined,
  );
  /** The principles that apply to the open document: the base guide plus its genre's add-on. */
  const principles = $derived<ResolvedPrinciple[]>(
    resolvePrinciples(baseGuide?.guide?.principles ?? [], currentGenre?.guide?.principles ?? []),
  );
  /** The open document's guide, parsed live (the list entry lags until the next save). */
  const currentGuide = $derived.by(() => {
    const guide = current?.state.meta.guide;
    if (!current || !guide) return undefined;
    const parsed = parsePrinciples(viewText(current.state, 'clean'));
    return { ...guide, principles: parsed.principles, unnumbered: parsed.unnumbered.length };
  });
  const claudeOn = $derived(current ? claudeAllowed(current.state.meta) : true);
  /** Documents with Claude off that are not written to any folder because no private folder is set. */
  const privateUnsynced = $derived(
    folders.private.status === 'connected' ? 0 : docs.filter((d) => !claudeAllowed(d)).length,
  );

  function principleTexts(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of docs) for (const p of d.guide?.principles ?? []) out[p.id] = p.text;
    return out;
  }

  /** Opens the base guide, creating it from the template the first time. */
  async function openBaseGuide(): Promise<void> {
    if (baseGuide) return open(baseGuide.id);
    const doc = await createDoc({
      text: baseGuideTemplate(),
      author: author.id,
      tracking: false,
      meta: { guide: { role: 'base', prefix: 'B' } },
    });
    await refreshList();
    await open(doc.id);
  }

  /** Creates a genre (its guide document) and opens it. */
  async function createGenre(name: string, isPrivate: boolean): Promise<string | undefined> {
    const clean = name.trim();
    if (!clean) return undefined;
    const prefix = genrePrefix(clean, ['B', ...genres.map((g) => g.guide!.prefix)]);
    const doc = await createDoc({
      text: genreGuideTemplate(clean, prefix),
      author: author.id,
      tracking: false,
      title: clean,
      meta: { guide: { role: 'genre', prefix, private: isPrivate } },
    });
    await refreshList();
    await open(doc.id);
    return doc.id;
  }

  type Confirm = (message: string) => boolean;

  const titleOf = (id: string) =>
    current?.id === id
      ? displayTitle(current.state.meta.title, viewText(current.state, 'clean'))
      : (docs.find((d) => d.id === id)?.title ?? 'Untitled');

  function listTitles(ids: string[]): string {
    const names = ids.map((id) => `“${titleOf(id)}”`);
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  }

  /**
   * Applies a change that may switch Claude access for some documents. When a folder is
   * connected and files would move, asks first; returns false if the user declines.
   */
  async function changeAccess(
    ids: string[],
    predict: (id: string) => boolean,
    apply: () => Promise<void>,
    confirmFn: Confirm,
  ): Promise<boolean> {
    const moves = ids
      .map((id) => ({ id, from: claudeAllowed(metaOf(id)), to: predict(id) }))
      .filter((m) => m.from !== m.to);
    const anyFolder = isConnected('shared') || isConnected('private');
    if (moves.length && anyFolder) {
      const leaving = moves.filter((m) => m.from).map((m) => m.id);
      const joining = moves.filter((m) => !m.from).map((m) => m.id);
      const parts: string[] = [];
      if (leaving.length) {
        const where = isConnected('private')
          ? ` and written to the private folder “${folderName('private')}”`
          : '. Choose a private folder in Settings to keep a copy on disk';
        parts.push(
          `Turn Claude off for ${listTitles(leaving)}? ${leaving.length === 1 ? 'Its files' : 'Their files'} will be deleted from the shared folder “${folderName('shared')}”${where}.`,
        );
      }
      if (joining.length) {
        parts.push(
          `Turn Claude on for ${listTitles(joining)}? ${joining.length === 1 ? 'Its files' : 'Their files'} will move into the shared folder “${folderName('shared')}”, where Claude Code can read them.`,
        );
      }
      if (!confirmFn(parts.join('\n\n'))) return false;
    }
    await apply();
    for (const m of moves) {
      if (current?.id === m.id) {
        await autosave.flush();
        await folderWriter.flush();
        await syncDoc(current);
      } else {
        const doc = (await loadDoc(m.id))?.doc;
        if (doc) await syncDoc(doc);
      }
    }
    return true;
  }

  /** Sets a document's own Claude switch; `null` follows the genre's default. */
  function setClaude(id: string, value: boolean | null, confirmFn: Confirm): Promise<boolean> {
    return changeAccess(
      [id],
      () => claudeAllowed({ ...metaOf(id), claude: value ?? undefined }),
      () => setDocMeta(id, { claude: value }),
      confirmFn,
    );
  }

  /** Puts a document in a genre; `null` means the base guide only. */
  function setGenre(id: string, genreId: string | null, confirmFn: Confirm): Promise<boolean> {
    return changeAccess(
      [id],
      () => claudeAllowed({ ...metaOf(id), genre: genreId ?? undefined }),
      () => setDocMeta(id, { genre: genreId }),
      confirmFn,
    );
  }

  /** Marks a genre private (Claude off by default) or not. */
  function setGenrePrivate(genreId: string, value: boolean, confirmFn: Confirm): Promise<boolean> {
    const genre = genres.find((g) => g.id === genreId);
    if (!genre?.guide) return Promise.resolve(false);
    const members = docs
      .filter((d) => (d.genre === genreId || d.id === genreId) && d.claude === undefined)
      .map((d) => d.id);
    if (
      current &&
      (current.state.meta.genre === genreId || current.id === genreId) &&
      current.state.meta.claude === undefined &&
      !members.includes(current.id)
    ) {
      members.push(current.id);
    }
    return changeAccess(
      members,
      () => !value,
      () =>
        setDocMeta(genreId, {
          guide: { role: 'genre', prefix: genre.guide!.prefix, private: value },
        }),
      confirmFn,
    );
  }

  /** Gives every principle without an id in the open guide the next id. */
  function numberPrinciples(): number {
    const guide = current?.state.meta.guide;
    if (!current || !guide || view !== 'revision') return 0;
    const edits = numberingEdits(viewText(current.state, 'clean'), guide.prefix);
    if (!edits.length) return 0;
    const sel = bridge?.getSelection() ?? { anchor: 0, head: 0 };
    const ts = nowIso();
    const builders: OpBuilder[] = edits.map((e) => (s) => {
      const at = cleanToRevision(s, e.at);
      return {
        id: ulid(),
        type: 'edit',
        author: author.id,
        ts,
        changeId: ulid(),
        from: absoluteToPos(s, at),
        to: absoluteToPos(s, at),
        insert: e.insert,
        tracked: false,
      };
    });
    const inverse = applyModelOps(builders);
    recordUndo({ ops: inverse, before: sel, after: bridge?.getSelection() ?? sel, at: Date.now() });
    return edits.length;
  }

  /** Links a change to style guide principles (replacing any earlier links). */
  function linkPrinciples(changeId: string, ids: string[]) {
    if (!current || !current.state.changes[changeId]) return;
    const ts = nowIso();
    const r = push({
      id: ulid(),
      type: 'set_principles',
      author: author.id,
      ts,
      changeId,
      principles: ids,
    });
    schedule([r.op], ts);
  }

  /* ---------- the edits library ---------- */

  /** All documents with clean text for search. Saves the open document first so it is current. */
  async function libraryEntries(): Promise<LibraryEntry[]> {
    await park();
    return storedLibraryEntries();
  }

  /** Changes a document's library metadata (status, tags, inclusion), open or not. */
  async function setDocMeta(id: string, patch: Omit<MetaPatch, 'title'>): Promise<void> {
    const ts = nowIso();
    const op: Op = { id: ulid(), type: 'set_meta', author: author.id, ts, patch };
    if (current?.id === id) {
      const r = push(op);
      schedule([r.op], ts);
      await autosave.flush();
      return;
    }
    const doc = await appendToStored(id, JSON.parse(JSON.stringify(op)) as Op);
    if (doc)
      docs = docs.map((d) =>
        d.id === id
          ? { id: d.id, createdAt: d.createdAt, updatedAt: ts, ...docStats(doc.state) }
          : d,
      );
  }

  /**
   * Downloads the change records of every document in the library as JSON lines.
   * Returns how many documents and rows went in.
   */
  async function exportLibrary(opts: RecordOptions = {}): Promise<{ docs: number; rows: number }> {
    await park();
    const ids = (await storedLibraryEntries()).filter((e) => e.libraryEligible).map((e) => e.id);
    const authorNames = { [author.id]: author.name };
    const texts = principleTexts();
    let rows: ReturnType<typeof changeRecords> = [];
    for (const id of ids) {
      const doc = current?.id === id ? current : (await loadDoc(id))?.doc;
      if (!doc) continue;
      const genreName = doc.state.meta.genre
        ? genres.find((g) => g.id === doc.state.meta.genre)?.title
        : undefined;
      rows = rows.concat(
        changeRecords(doc, {
          ...opts,
          authorNames,
          principleTexts: texts,
          ...(genreName ? { genreName } : {}),
        }),
      );
    }
    downloadText(
      `shoulder-library-${nowIso().slice(0, 10)}.jsonl`,
      toJsonl(rows),
      'application/x-ndjson',
    );
    return { docs: ids.length, rows: rows.length };
  }

  function jumpTo(changeId: string) {
    const c = pending.find((x) => x.id === changeId);
    if (!c || !bridge) return;
    const r = c.ranges[0]!;
    bridge.setSelection({ anchor: r.from, head: r.from });
    bridge.focus();
  }

  function step(dir: 1 | -1) {
    if (pending.length === 0) return;
    const idx = pending.findIndex((c) => c.id === activeChangeId);
    let next: PendingChange | undefined;
    if (idx >= 0) next = pending[(idx + dir + pending.length) % pending.length];
    else
      next =
        dir === 1
          ? (pending.find((c) => c.from > cursor) ?? pending[0])
          : ([...pending].reverse().find((c) => c.from < cursor) ?? pending[pending.length - 1]);
    if (next) jumpTo(next.id);
  }

  function setView(v: View) {
    if (v === view || !current) return;
    view = v;
    draft = undefined;
    if (bridge) {
      bridge.setText(displayTextFor(v), { readOnly: v !== 'revision' });
      if (v === 'revision') pushMarks();
    }
  }

  function displayTextFor(v: View) {
    return current
      ? v === 'revision'
        ? revisionText(current.state)
        : viewText(current.state, v)
      : '';
  }

  return {
    get docs() {
      return docs;
    },
    get current() {
      return current;
    },
    get title() {
      return current
        ? displayTitle(current.state.meta.title, viewText(current.state, 'clean'))
        : '';
    },
    get text() {
      return text;
    },
    get displayText() {
      return displayText;
    },
    get version() {
      return version;
    },
    get view() {
      return view;
    },
    get saveStatus() {
      return saveStatus;
    },
    get saveError() {
      return saveError;
    },
    get lastSavedAt() {
      return lastSavedAt;
    },
    get ready() {
      return ready;
    },
    get pending() {
      return pending;
    },
    get trackingOn() {
      return trackingOn;
    },
    get authors() {
      return authors;
    },
    get colors() {
      return colors;
    },
    get activeChangeId() {
      return activeChangeId;
    },
    get canUndo() {
      return canUndo;
    },
    get privateFolder() {
      return folders.private;
    },
    get baseGuide() {
      return baseGuide;
    },
    get genres() {
      return genres;
    },
    get currentGenre() {
      return currentGenre;
    },
    get principles() {
      return principles;
    },
    get currentGuide() {
      return currentGuide;
    },
    get claudeOn() {
      return claudeOn;
    },
    get privateUnsynced() {
      return privateUnsynced;
    },
    claudeAllowed,
    openBaseGuide,
    createGenre,
    setClaude,
    setGenre,
    setGenrePrivate,
    numberPrinciples,
    linkPrinciples,
    get folder() {
      return folders.shared;
    },
    get external() {
      return external;
    },
    get folderNotice() {
      return folderNotice;
    },
    clearFolderNotice: () => (folderNotice = undefined),
    connectFolder,
    reconnectFolder,
    disconnectFolder,
    resolveExternal,
    pollFolder: poll,
    get threads() {
      return visibleThreads;
    },
    get allThreads() {
      return threads;
    },
    get activeThreadId() {
      return activeThreadId;
    },
    get draft() {
      return draft;
    },
    get showResolved() {
      return showResolved;
    },
    get reasonRequest() {
      return reasonRequest;
    },
    requestReason(changeId: string) {
      reasonRequest = changeId;
    },
    clearReasonRequest() {
      reasonRequest = undefined;
    },
    setShowResolved(v: boolean) {
      showResolved = v;
      pushMarks();
    },
    get importNotice() {
      return importNotice;
    },
    clearImportNotice: () => (importNotice = undefined),
    exportAs,
    importFile,
    libraryEntries,
    setDocMeta,
    exportLibrary,
    startComment,
    cancelComment,
    addComment,
    reply,
    editComment,
    setResolved,
    jumpToThread,
    get canRedo() {
      return canRedo;
    },
    get author() {
      return author;
    },
    setAuthor(a: Author) {
      author = a;
      pushMarks();
    },
    init,
    open,
    create,
    remove,
    attachEditor,
    setCursor,
    applyTransaction,
    rename,
    setTracking,
    toggleTracking: () => setTracking(!trackingOn),
    accept: (ids: string[]) => decide('accept', ids),
    reject: (ids: string[]) => decide('reject', ids),
    acceptAll: () =>
      decide(
        'accept',
        pending.map((c) => c.id),
      ),
    rejectAll: () =>
      decide(
        'reject',
        pending.map((c) => c.id),
      ),
    acceptActive: () => activeChangeId && decide('accept', [activeChangeId]),
    rejectActive: () => activeChangeId && decide('reject', [activeChangeId]),
    setReason,
    jumpTo,
    nextChange: () => step(1),
    prevChange: () => step(-1),
    setView,
    undo,
    redo,
    flush: () => autosave.flush(),
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

export type Thread = CommentRange & { thread: CommentThread };

function mergeAuthors(known: readonly Author[], me: Author): Author[] {
  return [me, ...known.filter((a) => a.id !== me.id)];
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
