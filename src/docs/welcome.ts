/** The document a fresh install opens with, and how to tell that nobody has edited it. */
import type { Document } from '../model/types';
import { revisionText } from '../model/apply';

export const WELCOME = `# Welcome to shoulder-md

A Markdown editor with Word-style **tracked changes**. Underneath, every edit is recorded as an operation on a sentence-level model, so nothing about a document's editing history is lost.

- Turn on **Track changes** in the toolbar (⌘⌥T) and edit this paragraph: deletions stay struck through, insertions are underlined, and a card appears in the margin.
- Accept or reject a change from its card, or with ⌘⌥A and ⌘⌥R while the cursor is in it. ⌘⌥N and ⌘⌥P jump between changes.
- Add a reason to a change from its card. Reasons are the point: the library of edits with reasons is what will teach Claude to edit like you.
- Switch between **Markup**, **Clean**, and **Original** views to see the document with changes shown, applied, or rejected.
- Everything is saved in the background, in this browser. Open **Settings** (⌘,) for fonts, themes, and your author name.

> Comments, exports, and the edits library arrive in the next phases. See plan.md in the repo.
`;

/**
 * Whether this is the welcome document exactly as the app created it: the same text and no
 * edits. Such a document is the app's own, not the user's writing, so it is kept out of the
 * synced folder and dropped once real documents arrive from one.
 */
export function isUntouchedWelcome(doc: Document): boolean {
  const untouched = doc.ops.every(
    (op) => op.type === 'import' || op.type === 'set_tracking' || op.type === 'set_meta',
  );
  return untouched && revisionText(doc.state) === WELCOME;
}
