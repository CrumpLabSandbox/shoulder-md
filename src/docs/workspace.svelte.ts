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
import { nowIso, isoAt } from '../util/time';
import { countWords } from '../util/text';
import type { Author, Document, Op } from '../model/types';
import { appendOp, revisionText } from '../model/apply';
import { absoluteToPos, text as viewText } from '../model/views';
import { shouldCoalesce, type LastEdit } from '../model/changes';
import { ulid } from '../model/ids';
import type { Transaction } from '../editor/createEditor';

const LAST_DOC_KEY = 'shoulder-md:lastDoc';

const WELCOME = `# Welcome to shoulder-md

A Markdown editor that will grow Word-style **tracked changes** and comments. Underneath, every edit you make is already recorded as an operation on a sentence-level model.

- Everything you type is saved in the background, in this browser.
- Open **Settings** (⌘,) to pick fonts, size, line height, width, and a theme.
- Toggle the **preview** with ⌘E. Split the view with ⌘⇧E.
- Create more documents from the **Documents** list (⌘⇧D).

> Tracked changes, comments, and exports arrive in the next phases. See plan.md in the repo.
`;

type SaveBatch = { doc: Document; ops: Op[]; force: boolean };

/** Reactive workspace: the document list, the open document, its op log, and autosave. */
export function createWorkspace(author: Author) {
  // Raw state: replaced wholesale, never mutated in place, and the document goes to IndexedDB
  // as-is. A deep $state proxy would fail structured cloning.
  let docs = $state.raw<DocSummary[]>([]);
  let current = $state.raw<Document | undefined>(undefined);
  let text = $state('');
  let version = $state(0);
  let saveStatus = $state<SaveStatus>('saved');
  let saveError = $state<string | undefined>(undefined);
  let lastSavedAt = $state<number | undefined>(undefined);
  let ready = $state(false);
  let lastEdit: LastEdit | undefined;

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
    lastEdit = undefined;
    safeSet(LAST_DOC_KEY, id);
  }

  async function create() {
    const doc = await createDoc({ author: author.id, tracking: false });
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

  function push(op: Op): Op {
    if (!current) throw new Error('No open document');
    const r = appendOp(current, op);
    current = r.doc;
    return r.op;
  }

  /** Called by the editor for every transaction. Turns it into edit ops and schedules a save. */
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
    const newOps: Op[] = [];
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
      newOps.push(push(op));
    }
    const modelText = revisionText(current.state);
    if (modelText !== tr.text) {
      // Safety net: the model and the buffer disagree. Log loudly and resync from the buffer.
      console.error('shoulder-md: model/buffer mismatch; resyncing from the editor buffer', {
        changes: tr.changes,
      });
      newOps.push(push({ id: ulid(), type: 'import', author: author.id, ts, text: tr.text }));
      version++;
    }
    lastEdit = single
      ? { changeId, author: author.id, endOffset: single.from + single.insert.length, at, tracked }
      : undefined;
    text = tr.text;
    current = { ...current, updatedAt: ts };
    autosave.schedule({ doc: current, ops: newOps, force: false });
  }

  function rename(title: string) {
    if (!current) return;
    const ts = nowIso();
    const op = push({
      id: ulid(),
      type: 'set_meta',
      author: author.id,
      ts,
      patch: { title: title.trim() },
    });
    current = { ...current, updatedAt: ts };
    autosave.schedule({ doc: current, ops: [op], force: false });
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
    get version() {
      return version;
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
    init,
    open,
    create,
    remove,
    applyTransaction,
    rename,
    flush: () => autosave.flush(),
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

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
