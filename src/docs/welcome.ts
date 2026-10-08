/** The document a fresh install opens with, and how to tell that nobody has edited it. */
import type { Document } from '../model/types';
import { revisionText } from '../model/apply';
import welcomeText from '../../examples/welcome-to-shoulder-md/welcome-to-shoulder-md.md?raw';

/**
 * The welcome text is Matt's own, kept as a file so it can be read and edited as a document:
 * examples/welcome-to-shoulder-md/. Its history file beside it shows how it was written.
 */
export const WELCOME: string = welcomeText.trimEnd() + '\n';

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
