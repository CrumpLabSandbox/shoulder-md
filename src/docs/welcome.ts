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
 * What the browser version adds under the title: it is a demo, and the Claude panels need the
 * Mac app. Kept out of the example file so that stays exactly as Matt wrote it.
 */
export const WEB_NOTE =
  '> **Web demo.** This is the browser version of Shoulder, here as an example. It is missing ' +
  'features of the Mac app, such as the Ask Claude and chat panels, and it keeps documents in ' +
  'this browser unless you connect a folder (Chrome or Edge only). The full app is built from ' +
  'the source at <https://github.com/CrumpLabSandbox/shoulder-md>.';

/** The welcome text with the demo note placed after the title. */
export const WEB_WELCOME: string = WELCOME.replace(/^(#[^\n]*\n)/, `$1\n${WEB_NOTE}\n`);

/** The welcome text for where the page is running: the Mac app, or a browser. */
export function welcomeFor(inApp: boolean): string {
  return inApp ? WELCOME : WEB_WELCOME;
}

/**
 * Whether this is the welcome document exactly as the app created it: the same text and no
 * edits. Such a document is the app's own, not the user's writing, so it is kept out of the
 * synced folder and dropped once real documents arrive from one.
 */
export function isUntouchedWelcome(doc: Document): boolean {
  const untouched = doc.ops.every(
    (op) => op.type === 'import' || op.type === 'set_tracking' || op.type === 'set_meta',
  );
  const text = revisionText(doc.state);
  return untouched && (text === WELCOME || text === WEB_WELCOME);
}
