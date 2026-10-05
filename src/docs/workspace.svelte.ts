import {
  createDoc,
  deleteDoc,
  getDoc,
  listDocs,
  putDoc,
  type DocRecord,
  type DocSummary,
} from '../persist/idb';
import { createAutosave, type SaveStatus } from '../persist/autosave';
import { nextTitle } from './title';
import { nowIso } from '../util/time';
import { countWords } from '../util/text';

const LAST_DOC_KEY = 'shoulder-md:lastDoc';

const WELCOME = `# Welcome to shoulder-md

A Markdown editor that will grow Word-style **tracked changes** and comments. This is phase 0: a quiet place to write.

- Everything you type is saved in the background, in this browser.
- Open **Settings** (⌘,) to pick fonts, size, line height, width, and a theme.
- Toggle the **preview** with ⌘E. Split the view with ⌘⇧E.
- Create more documents from the **Documents** list (⌘⇧D).

> Tracked changes, comments, and exports arrive in the next phases. See plan.md in the repo.
`;

/** Reactive workspace: the document list, the open document, and its autosave. */
export function createWorkspace() {
  // Raw state: these are replaced wholesale, never mutated in place, and the record goes to
  // IndexedDB as-is. A deep $state proxy would fail structured cloning.
  let docs = $state.raw<DocSummary[]>([]);
  let current = $state.raw<DocRecord | undefined>(undefined);
  let text = $state('');
  let saveStatus = $state<SaveStatus>('saved');
  let saveError = $state<string | undefined>(undefined);
  let lastSavedAt = $state<number | undefined>(undefined);
  let ready = $state(false);

  const autosave = createAutosave<DocRecord>({
    save: async (doc) => {
      await putDoc(doc);
      lastSavedAt = Date.now();
      // Keep the list's metadata fresh without re-reading the whole store on every keystroke.
      docs = docs.map((d) =>
        d.id === doc.id
          ? { ...d, title: doc.title, updatedAt: doc.updatedAt, words: countWords(doc.text) }
          : d,
      );
      docs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
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
      const doc = await createDoc({ title: 'Welcome to shoulder-md', text: WELCOME });
      await refreshList();
      await open(doc.id);
    }
    ready = true;
  }

  async function open(id: string) {
    await autosave.flush();
    const doc = await getDoc(id);
    if (!doc) return;
    current = doc;
    text = doc.text;
    safeSet(LAST_DOC_KEY, id);
  }

  async function create() {
    await autosave.flush();
    const doc = await createDoc();
    await refreshList();
    await open(doc.id);
  }

  async function remove(id: string) {
    const wasCurrent = current?.id === id;
    if (wasCurrent) await autosave.flush();
    await deleteDoc(id);
    await refreshList();
    if (wasCurrent) {
      if (docs[0]) await open(docs[0].id);
      else await create();
    }
  }

  /** Called by the editor on every change. Updates state and schedules a save. */
  function setText(newText: string) {
    if (!current || newText === text) return;
    const title = nextTitle(current.title, text, newText);
    text = newText;
    current = { ...current, text: newText, title, updatedAt: nowIso() };
    autosave.schedule(current);
  }

  function rename(title: string) {
    if (!current) return;
    current = { ...current, title: title.trim() || 'Untitled', updatedAt: nowIso() };
    autosave.schedule(current);
  }

  return {
    get docs() {
      return docs;
    },
    get current() {
      return current;
    },
    get text() {
      return text;
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
    setText,
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
