import { describe, it, expect } from 'vitest';
import {
  WELCOME,
  WEB_NOTE,
  WEB_WELCOME,
  isUntouchedWelcome,
  welcomeFor,
} from '../src/docs/welcome';
import { appendOp, createDocument } from '../src/model/apply';
import { absoluteToPos } from '../src/model/views';

describe('the welcome document', () => {
  const fresh = () => createDocument({ id: 'w', text: WELCOME, author: 'me', ts: 't' });

  it('counts as untouched until someone edits its text', () => {
    let doc = fresh();
    expect(isUntouchedWelcome(doc)).toBe(true);
    // Switching tracking on, or renaming, is not writing.
    doc = appendOp(doc, { id: 'a', type: 'set_tracking', author: 'me', ts: 't', on: true }).doc;
    expect(isUntouchedWelcome(doc)).toBe(true);
    const at = absoluteToPos(doc.state, 2);
    const edited = appendOp(doc, {
      id: 'b',
      type: 'edit',
      author: 'me',
      ts: 't',
      changeId: 'c',
      from: at,
      to: at,
      insert: 'X',
      tracked: true,
    });
    expect(isUntouchedWelcome(edited.doc)).toBe(false);
    // Even an edit that was undone means someone has been here.
    let undone = edited.doc;
    for (const op of edited.inverse) undone = appendOp(undone, op).doc;
    expect(isUntouchedWelcome(undone)).toBe(false);
  });

  it('does not mistake another document for it', () => {
    expect(isUntouchedWelcome(createDocument({ text: '# My notes', author: 'me' }))).toBe(false);
    expect(isUntouchedWelcome(createDocument({ text: WELCOME + '\nMore.', author: 'me' }))).toBe(
      false,
    );
  });

  it("carries a demo note in a browser, under the title, and is still the app's own", () => {
    expect(welcomeFor(true)).toBe(WELCOME);
    expect(welcomeFor(false)).toBe(WEB_WELCOME);
    const lines = WEB_WELCOME.split('\n');
    expect(lines[0]).toBe(WELCOME.split('\n')[0]);
    expect(lines[2]).toBe(WEB_NOTE);
    expect(WEB_WELCOME.replace(`\n${WEB_NOTE}\n`, '')).toBe(WELCOME);
    const doc = createDocument({ id: 'w', text: WEB_WELCOME, author: 'me', ts: 't' });
    expect(isUntouchedWelcome(doc)).toBe(true);
  });
});
