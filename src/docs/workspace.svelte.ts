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
import { reviveHandle, sameNativeFolder, storableHandle, type NativeDir } from '../folder/native';
import { appBridge, type ClaudeEvent } from '../app/bridge';
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
import { numbered, readSeed, seedAdditions, seedPrefix, type SeedFile } from '../guides/seed';
import { docStats } from '../library/stats';
import { changeRecords, toJsonl, type RecordOptions } from '../library/records';
import type { DocMeta, MetaPatch } from '../model/types';
import { exportCriticMarkup, exportMarkdown, documentFromCriticMarkup } from '../export/markdown';
import { exportJson, importJson } from '../export/json';
import { downloadBlob, downloadText, slugify } from '../export/download';
import { printDocument, printHtml } from '../export/print';
import { createAutosave, type SaveStatus } from '../persist/autosave';
import { displayTitle } from './title';
import { authorColor, CLAUDE_AUTHOR, DISK_AUTHOR } from './identity';
import {
  alignRevision,
  parseProposals,
  parseRevision,
  placeProposals,
  proposalOps,
  ProposalError,
  type Proposal,
} from '../folder/proposals';
import {
  chatDivider,
  chatEntry,
  chatHeader,
  chatSession,
  parseChat,
  type ChatMessage,
} from '../folder/chat';
import { nowIso, isoAt } from '../util/time';
import type { Author, Document, Op, State } from '../model/types';
import { appendOp, revisionText } from '../model/apply';
import { composeSplices, extendEdit, type EditOp } from '../model/coalesce';
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

/** Same op log: same length and the very same last op (a typing run replaces its op in place). */
const sameLog = (a: Document, b: Document) =>
  a.ops.length === b.ops.length && a.ops[a.ops.length - 1] === b.ops[b.ops.length - 1];

/** Changes in a revision that are this few unchanged characters apart are shown as one. */
const REVISION_JOIN = 24;

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

/** `from` is the index of the first op in `doc.ops` that still has to be written. */
type SaveBatch = { doc: Document; from: number; force: boolean };

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
  /** Whether conversations with Claude are saved next to each document. On unless this says no. */
  saveChats?: () => boolean;
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
  /** The op a run of typing is growing, and the state before it (see model/coalesce.ts). */
  let typingRun: { op: EditOp; base: State } | undefined;
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
    save: async ({ doc, from, force }) => {
      await appendOps(doc, doc.ops.slice(from), { forceSnapshot: force });
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
    merge: (a, b) => ({ doc: b.doc, from: Math.min(a.from, b.from), force: a.force || b.force }),
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
    autosave.schedule({ doc: current, from: current.ops.length, force: true });
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
    if (proposalOffer && proposalOffer.docId !== id) proposalOffer = undefined;
    if (revisionOffer && revisionOffer.docId !== id) revisionOffer = undefined;
    void restoreChat(loaded.doc);
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

  /** Queues a save of the last `ops.length` ops; `rewritten` more before them changed in place. */
  function schedule(ops: Op[], ts: string, rewritten = 0) {
    if (!current) return;
    current = { ...current, updatedAt: ts };
    const from = current.ops.length - ops.length - rewritten;
    autosave.schedule({ doc: current, from, force: false });
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
      // Same keystroke run: fold into the previous entry (new inverse runs first), as one
      // splice where possible so undoing a run logs one op rather than one per keystroke.
      const one =
        entry.ops.length === 1 && last.ops.length === 1
          ? composeSplices(entry.ops[0]!, last.ops[0]!)
          : undefined;
      undoStack[undoStack.length - 1] = {
        ...last,
        ops: one ? [one] : [...entry.ops, ...last.ops],
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
    const stateBefore = current.state;
    const run =
      coalesce && typingRun?.op === current.ops[current.ops.length - 1] ? typingRun : undefined;
    typingRun = undefined;
    let rewritten = 0;
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
      const own = newOps[0];
      if (single && own?.type === 'edit') {
        // Fold the keystroke into the run's op when that gives the same document, so the log
        // grows by edits rather than by characters.
        const folded =
          run &&
          extendEdit(
            run.base,
            run.op,
            { insert: single.insert, cut: single.to - single.from },
            current.state,
            own.alloc,
          );
        if (folded && run) {
          const op = folded.op as EditOp;
          current = { ...current, ops: [...current.ops.slice(0, -2), op], state: folded.state };
          typingRun = { op, base: run.base };
          newOps.length = 0;
          rewritten = 1;
        } else {
          typingRun = { op: own, base: stateBefore };
        }
      }
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
    schedule(newOps, ts, rewritten);
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

  /**
   * Gives every pending change one shared reason (or clears it). The changes keep their own
   * reasons; an existing group id is reused so rewording does not start a new group.
   */
  function setGroupReason(reason: string | undefined) {
    if (!current || pending.length === 0) return;
    const text = reason?.trim() || undefined;
    const existing = pending.find((c) => c.record.group)?.record.group;
    if (!text && !existing) return;
    if (text && pending.every((c) => c.record.group?.reason === text)) return;
    const ts = nowIso();
    const op: Op = {
      id: ulid(),
      type: 'set_group_reason',
      author: author.id,
      ts,
      groupId: existing?.id ?? ulid(),
      changeIds: pending.map((c) => c.id),
    };
    if (text) op.reason = text;
    const r = push(op);
    schedule([r.op], ts);
  }

  /** Decides every pending change; a shared reason first extends to changes made after it. */
  function decideAll(type: 'accept' | 'reject') {
    if (!current || view !== 'revision') return;
    setGroupReason(pending.find((c) => c.record.group)?.record.group?.reason);
    decide(
      type,
      pending.map((c) => c.id),
    );
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
  /** Proposed edits from Claude Code waiting next to the open document (folder/proposals.ts). */
  let proposalOffer = $state.raw<
    { docId: string; file: string; key: string; proposals: Proposal[] } | undefined
  >(undefined);
  /** The proposals file last dealt with, so it is not offered or reported twice. */
  let proposalsSeen = '';
  /** A revised copy of the open document from Claude Code, waiting to be shown as changes. */
  let revisionOffer = $state.raw<
    { docId: string; file: string; key: string; text: string; reason?: string } | undefined
  >(undefined);
  let revisionSeen = '';
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
    let movedChat: string | undefined;
    if (otherSync && isConnected(other)) {
      try {
        if (await otherSync.has(doc.id)) {
          // The conversation is part of the document's history: it moves with the document.
          movedChat = await otherSync.chat(doc.id);
          await otherSync.remove(doc.id);
        }
      } catch (e) {
        folderFailed(other, e);
      }
    }
    const target = syncs[kind];
    if (!target || !isConnected(kind)) return;
    if (!force && external?.docId === doc.id) return; // waiting for the user to decide
    try {
      const r = await target.write(doc, { force });
      if (movedChat && !(await target.chat(doc.id))) await target.appendChat(doc.id, '', movedChat);
      // Ask only if the browser has not moved on since this copy was queued. If it has, a newer
      // write is on its way and will apply the rule: the browser wins, the disk copy is kept.
      const movedOn = !current || !sameLog(current, doc) || autosave.status !== 'saved';
      if (r.external && doc.id === current?.id && !movedOn)
        external = { docId: doc.id, ext: r.external };
      if (r.renamed)
        folderNotice = `${r.renamed.from} was renamed ${r.renamed.to} in the folder, now that the document has a title.`;
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
      await sync.prepare();
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
      void restoreChat(current);
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

  /** The remembered folder of a kind, with its handle ready to use (a stored path is revived). */
  async function storedRoot(kind: FolderKind) {
    const root = await getFolderRoot(kind);
    return root && { ...root, handle: reviveHandle(root.handle, appBridge()?.fs) };
  }

  /** On startup: use remembered folders the browser still allows, else offer to reconnect. */
  async function restoreFolders(): Promise<void> {
    for (const kind of ['shared', 'private'] as const) {
      if (folders[kind].status === 'unsupported') continue;
      try {
        const root = await storedRoot(kind);
        if (!root) continue;
        const perm = await permissionOf(root.handle);
        if (perm === 'granted') await activate(kind, root.handle);
        else setFolder(kind, { status: 'needs-permission', name: root.name });
      } catch (e) {
        setFolder(kind, {
          status: 'error',
          name: folderName(kind) ?? 'the folder',
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
    const otherRoot = await storedRoot(kind === 'shared' ? 'private' : 'shared').catch(
      () => undefined,
    );
    if (otherRoot && sameNativeFolder(otherRoot.handle, handle)) {
      folderNotice = 'The shared and private folders must be different folders.';
      return;
    }
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
    await setFolderRoot(
      { handle: storableHandle(handle) as DirHandleLike, name: handle.name, connectedAt: nowIso() },
      kind,
    );
    await activate(kind, handle);
  }

  /** Asks the browser for permission again (needs a click) and resumes syncing. */
  async function reconnectFolder(kind: FolderKind = 'shared'): Promise<void> {
    const stored = await getFolderRoot(kind);
    if (!stored) return void setFolder(kind, { status: 'none' });
    try {
      const handle = reviveHandle(stored.handle, appBridge()?.fs);
      const perm = await permissionOf(handle, true);
      if (perm === 'granted') await activate(kind, handle);
      else setFolder(kind, { status: 'needs-permission', name: stored.name });
    } catch (e) {
      setFolder(kind, {
        status: 'error',
        name: stored.name,
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
      if (current?.id !== doc.id || !sameLog(current, doc)) return;
      if (ext.kind === 'missing') folderWriter.schedule({ doc, force: false });
      else if (ext.kind !== 'none') external = { docId: doc.id, ext };
      // Claude Code only works in the shared folder, so proposals are only looked for there.
      else if (kind === 'shared') {
        await checkProposals(sync, doc);
        await checkRevision(sync, doc);
      }
    } catch (e) {
      folderFailed(kind, e);
    } finally {
      polling = false;
    }
  }

  async function checkProposals(sync: FolderSync, doc: Document): Promise<void> {
    const found = await sync.proposals(doc.id);
    if (current?.id !== doc.id) return;
    if (!found) {
      if (proposalOffer?.docId === doc.id) proposalOffer = undefined;
      return;
    }
    if (found.key === proposalOffer?.key || found.key === proposalsSeen) return;
    try {
      const file = parseProposals(found.text);
      if (file.document && file.document !== doc.id)
        throw new ProposalError('it was written for another document');
      if (file.proposals.length === 0) throw new ProposalError('it has no proposals in it');
      proposalOffer = {
        docId: doc.id,
        file: found.file,
        key: found.key,
        proposals: file.proposals,
      };
    } catch (e) {
      proposalsSeen = found.key;
      proposalOffer = undefined;
      folderNotice = `${found.file} could not be used: ${e instanceof Error ? e.message : String(e)}.`;
    }
  }

  async function checkRevision(sync: FolderSync, doc: Document): Promise<void> {
    const found = await sync.revision(doc.id);
    if (current?.id !== doc.id) return;
    if (!found) {
      if (revisionOffer?.docId === doc.id) revisionOffer = undefined;
      return;
    }
    if (found.key === revisionOffer?.key || found.key === revisionSeen) return;
    revisionOffer = {
      docId: doc.id,
      file: found.file,
      key: found.key,
      ...parseRevision(found.text),
    };
  }

  /**
   * Shows Claude's revised copy as tracked changes: the differences from the current text, by
   * Claude, as one undo step, all sharing the revision's reason. The revision file is removed.
   */
  async function applyRevision(): Promise<void> {
    const offer = revisionOffer;
    if (!offer || !current || current.id !== offer.docId) return;
    revisionOffer = undefined;
    revisionSeen = offer.key;
    const target = alignRevision(viewText(current.state, 'clean'), offer.text);
    const before = pending.map((c) => c.id);
    if (view !== 'revision') setView('revision');
    const sel = bridge?.getSelection() ?? { anchor: 0, head: 0 };
    const ts = nowIso();
    const inverse = applyModelOps(
      // A rewrite touches most words of a sentence; join nearby changes so each reads whole.
      editsToMatch(current.state, target, {
        author: CLAUDE_AUTHOR,
        ts,
        id: ulid,
        joinWithin: REVISION_JOIN,
      }),
    );
    const fresh = pendingChanges(current.state)
      .map((c) => c.id)
      .filter((id) => !before.includes(id));
    if (fresh.length > 0) {
      recordUndo({
        ops: inverse,
        before: sel,
        after: bridge?.getSelection() ?? sel,
        at: Date.now(),
      });
      if (offer.reason) {
        const r = push({
          id: ulid(),
          type: 'set_group_reason',
          author: CLAUDE_AUTHOR,
          ts,
          groupId: ulid(),
          changeIds: fresh,
          reason: offer.reason,
        });
        schedule([r.op], ts);
      }
      await autosave.flush();
    }
    try {
      await syncs.shared?.clearRevision(offer.docId);
    } catch (e) {
      folderFailed('shared', e);
    }
    const n = fresh.length;
    folderNotice =
      n > 0
        ? `Loaded Claude’s revision as ${n} tracked ${n === 1 ? 'change' : 'changes'}. Use Clean and Original to read it against what you had.`
        : 'Claude’s revision is the same as the document, so there is nothing to show.';
  }

  async function discardRevision(): Promise<void> {
    const offer = revisionOffer;
    if (!offer) return;
    revisionOffer = undefined;
    revisionSeen = offer.key;
    try {
      await syncs.shared?.clearRevision(offer.docId);
    } catch (e) {
      folderFailed('shared', e);
    }
  }

  /**
   * Turns the waiting proposals into tracked changes by Claude, each with its reason and
   * principle links, as one undo step. Proposals whose quoted text cannot be found exactly
   * once are kept in a `.proposals.skipped.json` file; the proposals file itself is removed.
   */
  async function applyProposals(): Promise<void> {
    const offer = proposalOffer;
    if (!offer || !current || current.id !== offer.docId) return;
    proposalOffer = undefined;
    proposalsSeen = offer.key;
    const { placed, skipped } = placeProposals(viewText(current.state, 'clean'), offer.proposals);
    if (placed.length > 0) {
      if (view !== 'revision') setView('revision');
      const sel = bridge?.getSelection() ?? { anchor: 0, head: 0 };
      const inverse = applyModelOps(
        proposalOps(placed, {
          author: CLAUDE_AUTHOR,
          ts: nowIso(),
          id: ulid,
          known: principles.map((p) => p.id),
        }),
      );
      recordUndo({
        ops: inverse,
        before: sel,
        after: bridge?.getSelection() ?? sel,
        at: Date.now(),
      });
      await autosave.flush();
    }
    const leftover = skipped.map((s) => ({ ...s.proposal, skipped: s.why }));
    try {
      await syncs.shared?.clearProposals(
        offer.docId,
        leftover.length ? JSON.stringify({ proposals: leftover }, null, 2) + '\n' : undefined,
      );
    } catch (e) {
      folderFailed('shared', e);
    }
    const n = placed.length;
    const added = `Added ${n} proposed ${n === 1 ? 'edit' : 'edits'} by Claude as tracked changes.`;
    folderNotice = skipped.length
      ? `${added} ${skipped.length} could not be placed (the quoted text was missing, repeated, or overlapped another edit) and ${skipped.length === 1 ? 'was' : 'were'} kept in ${offer.file.replace('.proposals.json', '.proposals.skipped.json')}.`
      : added;
  }

  async function discardProposals(): Promise<void> {
    const offer = proposalOffer;
    if (!offer) return;
    proposalOffer = undefined;
    proposalsSeen = offer.key;
    try {
      await syncs.shared?.clearProposals(offer.docId);
    } catch (e) {
      folderFailed('shared', e);
    }
  }

  /* ---------- asking Claude Code from inside the Mac app ---------- */

  type ClaudeRun = {
    docId: string;
    title: string;
    status: 'running' | 'done' | 'error';
    steps: string[];
    summary: string;
  };
  let claudeRun = $state.raw<ClaudeRun | undefined>(undefined);

  /** Why Claude cannot be asked about the open document right now, or undefined if it can. */
  async function claudeBlocked(use: 'edits' | 'chat' = 'edits'): Promise<string | undefined> {
    const bridge = appBridge();
    if (!bridge) return 'Asking Claude from inside the app needs the Mac app.';
    if (!current) return 'Open a document first.';
    if (current.state.meta.guide)
      return 'Style guides are yours to edit; Claude does not propose changes to them.';
    if (!claudeAllowed(current.state.meta))
      return 'Claude is switched off for this document. Switch it on from the toolbar to ask.';
    const sync = syncs.shared;
    if (!sync || !isConnected('shared') || !('nativePath' in sync.dir))
      return 'Choose a shared folder first (Library → Folders). Claude Code works on the copy there.';
    if (use === 'edits' && proposalOffer?.docId === current.id)
      return 'Claude’s earlier proposals for this document are still waiting. Show or discard them first.';
    if (claudeRun?.status === 'running' || Object.values(chats).some((c) => c.running))
      return 'Claude is already working on a document.';
    const status = await bridge.claude.status();
    if (!status.available)
      return 'Claude Code is not installed on this Mac. Install it, run “claude” once in Terminal to sign in, then try again. The app uses that sign-in and holds no credentials of its own.';
    return undefined;
  }

  /**
   * Has the user's own Claude Code read the open document and its guides and write proposals
   * next to it (the propose-edits skill). The proposals then arrive through the folder poll.
   */
  async function askClaude(note?: string, model?: string): Promise<void> {
    const bridge = appBridge();
    const doc = current;
    if (!bridge || !doc || (await claudeBlocked())) return;
    const sync = syncs.shared!;
    await autosave.flush();
    await folderWriter.flush();
    const file = await sync.fileName(doc.id);
    const title = displayTitle(doc.state.meta.title, viewText(doc.state, 'clean'));
    if (!file) {
      claudeRun = {
        docId: doc.id,
        title,
        status: 'error',
        steps: [],
        summary:
          'This document has not been written to the shared folder yet. Try again in a moment.',
      };
      return;
    }
    claudeRun = { docId: doc.id, title, status: 'running', steps: [], summary: '' };
    const stop = bridge.claude.onEvent((e) => {
      const run = claudeRun;
      if (run?.docId === doc.id && run.status === 'running' && e.kind === 'step')
        claudeRun = { ...run, steps: [...run.steps, e.text] };
    });
    let outcome: { kind: string; text: string };
    try {
      outcome = await bridge.claude.ask((sync.dir as NativeDir).nativePath, file, note, model);
    } catch (e) {
      outcome = { kind: 'error', text: e instanceof Error ? e.message : String(e) };
    } finally {
      stop();
    }
    if (claudeRun?.docId === doc.id)
      claudeRun = {
        ...claudeRun,
        status: outcome.kind === 'error' ? 'error' : 'done',
        summary: outcome.text,
      };
    void poll();
  }

  /* ---------- chatting with Claude Code about the open document ---------- */

  type Chat = { messages: ChatMessage[]; sessionId?: string; running: boolean; steps: string[] };
  const NO_CHAT: Chat = { messages: [], running: false, steps: [] };
  /** One conversation per document, kept while the app is open. */
  let chats = $state.raw<Record<string, Chat>>({});
  const chat = $derived<Chat>((current && chats[current.id]) || NO_CHAT);

  const savingChats = () => options.saveChats?.() ?? true;

  /** Adds to the document's saved conversation, when saving is on. Failures are not fatal. */
  async function saveChat(doc: Document, addition: string): Promise<void> {
    const sync = syncs[folderFor(doc.state.meta)];
    if (!savingChats() || !sync) return;
    const title = displayTitle(doc.state.meta.title, viewText(doc.state, 'clean'));
    try {
      await sync.appendChat(doc.id, addition, chatHeader(title));
    } catch (e) {
      console.warn('shoulder-md: could not save the conversation', e);
    }
  }

  /** Brings back the saved conversation for a document that has none in memory yet. */
  async function restoreChat(doc: Document | undefined): Promise<void> {
    if (!doc || chats[doc.id] || !savingChats()) return;
    const sync = syncs[folderFor(doc.state.meta)];
    if (!sync) return;
    try {
      const file = await sync.chat(doc.id);
      if (!file || chats[doc.id]) return;
      const saved = parseChat(file);
      if (saved.messages.length > 0) setChat(doc.id, () => ({ ...NO_CHAT, ...saved }));
    } catch {
      // No saved conversation we can read: start with none.
    }
  }

  function setChat(docId: string, f: (c: Chat) => Chat) {
    chats = { ...chats, [docId]: f(chats[docId] ?? NO_CHAT) };
  }

  /**
   * Sends one message about the open document. Claude Code may answer, write per-edit
   * proposals, or write a revised copy; whatever it writes arrives through the folder poll.
   */
  async function sendChat(message: string, model?: string): Promise<void> {
    const text = message.trim();
    const bridge = appBridge();
    const doc = current;
    if (!text || !bridge || !doc) return;
    const id = doc.id;
    const blocked = await claudeBlocked('chat');
    if (blocked) {
      setChat(id, (c) => ({
        ...c,
        messages: [...c.messages, { role: 'you', text }, { role: 'error', text: blocked }],
      }));
      return;
    }
    const sync = syncs.shared!;
    setChat(id, (c) => ({
      ...c,
      running: true,
      steps: [],
      messages: [...c.messages, { role: 'you', text }],
    }));
    // Claude Code reads the copy on disk, so make sure it is current.
    await autosave.flush();
    await folderWriter.flush();
    const file = await sync.fileName(id);
    await saveChat(doc, chatEntry({ role: 'you', text }, nowIso()));
    const stop = bridge.claude.onEvent((e) => {
      if (e.kind === 'step')
        setChat(id, (c) => (c.running ? { ...c, steps: [...c.steps, e.text] } : c));
    });
    const ask = async (sessionId?: string): Promise<ClaudeEvent> => {
      if (!file)
        return {
          kind: 'error',
          text: 'This document has not been written to the shared folder yet.',
        };
      try {
        return await bridge.claude.chat(
          (sync.dir as NativeDir).nativePath,
          file,
          text,
          sessionId,
          model,
        );
      } catch (e) {
        return { kind: 'error', text: e instanceof Error ? e.message : String(e) };
      }
    };
    const earlier = chats[id]?.sessionId;
    let outcome = await ask(earlier);
    // A saved conversation's session may no longer exist in Claude Code: start a fresh one.
    if (
      outcome.kind === 'error' &&
      earlier &&
      !/^Stopped|already working|not installed/.test(outcome.text)
    )
      outcome = await ask(undefined);
    stop();
    const reply: ChatMessage = {
      role: outcome.kind === 'error' ? 'error' : 'claude',
      text: outcome.text || (outcome.kind === 'error' ? 'Something went wrong.' : 'Done.'),
    };
    await saveChat(
      doc,
      chatEntry(reply, nowIso(), model) + (outcome.sessionId ? chatSession(outcome.sessionId) : ''),
    );
    setChat(id, (c) => ({
      messages: [...c.messages, reply],
      running: false,
      steps: [],
      ...(outcome.sessionId
        ? { sessionId: outcome.sessionId }
        : c.sessionId
          ? { sessionId: c.sessionId }
          : {}),
    }));
    void poll();
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

  /** Adds `insert` at the end of a guide, open or stored, as an untracked edit. */
  async function appendToGuide(id: string, insert: string): Promise<void> {
    const build = (state: State): Op => {
      const end = absoluteToPos(state, revisionText(state).length);
      return {
        id: ulid(),
        type: 'edit',
        author: author.id,
        ts: nowIso(),
        changeId: ulid(),
        from: end,
        to: end,
        insert,
        tracked: false,
      };
    };
    if (current?.id === id) {
      const sel = bridge?.getSelection() ?? { anchor: 0, head: 0 };
      const inverse = applyModelOps([build(current.state)], sel);
      recordUndo({ ops: inverse, before: sel, after: sel, at: Date.now() });
      return;
    }
    const loaded = await loadDoc(id);
    if (loaded) await appendToStored(id, build(loaded.doc.state));
  }

  /**
   * Creates or tops up style guides from a seed folder (see guides/seed.ts) and says what it
   * did. Existing principles are never changed.
   */
  async function importSeed(files: SeedFile[]): Promise<string> {
    const guides = readSeed(files);
    if (guides.length === 0)
      return 'No style guides found. Expected base.md and one folder per genre holding guide.md.';
    await park();
    const report: string[] = [];
    for (const g of guides) {
      const wanted = seedPrefix(g.text);
      const existing =
        g.role === 'base'
          ? baseGuide
          : genres.find(
              (d) =>
                d.title.trim().toLowerCase() === g.name.trim().toLowerCase() ||
                (wanted !== undefined && d.guide?.prefix === wanted),
            );
      if (existing) {
        const state =
          current?.id === existing.id ? current.state : (await loadDoc(existing.id))?.doc.state;
        if (!state) continue;
        const { append, added } = seedAdditions(
          revisionText(state),
          g.text,
          existing.guide!.prefix,
        );
        if (added > 0) await appendToGuide(existing.id, append);
        report.push(
          added > 0
            ? `Added ${added} ${added === 1 ? 'principle' : 'principles'} to “${existing.title}”.`
            : `“${existing.title}” already has everything in ${g.path}.`,
        );
        continue;
      }
      const taken = ['B', ...genres.map((d) => d.guide!.prefix)];
      const prefix =
        g.role === 'base'
          ? 'B'
          : wanted && !taken.includes(wanted)
            ? wanted
            : genrePrefix(g.name, taken);
      const text = numbered(g.text, prefix);
      await createDoc({
        text,
        author: author.id,
        tracking: false,
        ...(g.role === 'genre' ? { title: g.name } : {}),
        meta: {
          guide: g.role === 'base' ? { role: 'base', prefix } : { role: 'genre', prefix },
        },
      });
      const n = parsePrinciples(text).principles.length;
      report.push(`Created “${g.name}” with ${n} ${n === 1 ? 'principle' : 'principles'}.`);
      await refreshList();
    }
    await refreshList();
    if (syncs.shared || syncs.private) await writeAll();
    return report.join(' ');
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
          : '. Choose a private folder in the Library to keep a copy on disk';
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
    importSeed,
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
    get claudeRun() {
      return claudeRun;
    },
    claudeBlocked,
    askClaude,
    cancelClaude: () => appBridge()?.claude.cancel(),
    dismissClaude: () => {
      if (claudeRun?.status !== 'running') claudeRun = undefined;
    },
    get chat() {
      return chat;
    },
    sendChat,
    clearChat: () => {
      if (!current || chat.running || chat.messages.length === 0) return;
      void saveChat(current, chatDivider(nowIso()));
      setChat(current.id, () => NO_CHAT);
    },
    get revisionOffer() {
      return revisionOffer;
    },
    applyRevision,
    discardRevision,
    get proposalOffer() {
      return proposalOffer;
    },
    applyProposals,
    discardProposals,
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
    acceptAll: () => decideAll('accept'),
    rejectAll: () => decideAll('reject'),
    setGroupReason,
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
