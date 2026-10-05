import {
  appendOps,
  createDoc,
  deleteDoc,
  listDocs,
  loadDoc,
  type DocSummary,
} from '../persist/idb';
import { createAutosave, type SaveStatus } from '../persist/autosave';
import { displayTitle } from './title';
import { authorColor } from './identity';
import { nowIso, isoAt } from '../util/time';
import { countWords } from '../util/text';
import type { Author, Document, Op } from '../model/types';
import { appendOp, revisionText } from '../model/apply';
import { absoluteToPos, markedRanges, text as viewText, type View } from '../model/views';
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
export function createWorkspace(initialAuthor: Author) {
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

  const autosave = createAutosave<SaveBatch>({
    save: async ({ doc, ops, force }) => {
      await appendOps(doc, ops, { forceSnapshot: force });
      lastSavedAt = Date.now();
      const clean = viewText(doc.state, 'clean');
      docs = docs
        .map((d) =>
          d.id === doc.id
            ? {
                ...d,
                title: displayTitle(doc.state.meta.title, clean),
                updatedAt: doc.updatedAt,
                words: countWords(clean),
                pendingChanges: Object.values(doc.state.changes).filter(
                  (c) => c.status === 'pending',
                ).length,
              }
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
  }

  /** Flush pending ops and write a snapshot of the open document before leaving it. */
  async function park() {
    if (!current) return;
    autosave.schedule({ doc: current, ops: [], force: true });
    await autosave.flush();
  }

  async function open(id: string) {
    await park();
    const loaded = await loadDoc(id);
    if (!loaded) return;
    current = loaded.doc;
    text = revisionText(loaded.doc.state);
    view = 'revision';
    lastEdit = undefined;
    undoStack = [];
    redoStack = [];
    canUndo = canRedo = false;
    safeSet(LAST_DOC_KEY, id);
    pushMarks();
  }

  async function create() {
    const doc = await createDoc({
      author: author.id,
      tracking: current?.state.trackingOn ?? false,
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
    const info = { ranges: markedRanges(current.state), colors, activeChangeId };
    // Marks may be pushed from inside an editor update; defer the dispatch past it.
    queueMicrotask(() => bridge?.setMarks(info));
  }

  function setCursor(sel: Selection) {
    const was = activeChangeId;
    cursor = sel.head;
    if (activeChangeId !== was) pushMarks();
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
  function applyModelOps(ops: Op[], selection?: Selection): Op[] {
    if (!current) return [];
    const inverses: Op[][] = [];
    const applied: Op[] = [];
    for (const op of ops) {
      const before = current.state;
      const changes = bufferChangesFor(before, op);
      const r = push(op);
      applied.push(r.op);
      inverses.push(r.inverse);
      if (view === 'revision') bridge?.applyChanges(changes);
    }
    text = revisionText(current.state);
    if (selection) bridge?.setSelection(selection);
    schedule(applied, ops[ops.length - 1]?.ts ?? nowIso());
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
