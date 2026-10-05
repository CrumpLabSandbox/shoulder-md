import { describe, it, expect } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import {
  trackingExtension,
  userIntent,
  fromModel,
  intentOf,
  setMarks,
  marksField,
} from '../src/editor/tracking';
import { bufferChangesFor, diffChange } from '../src/editor/sync';
import { harness } from './helpers/model';
import { keptText, flatten, onlyPendingDeletions } from '../src/model/spans';

function stateFor(doc: string, h: ReturnType<typeof harness>, tracking = true) {
  return EditorState.create({
    doc,
    extensions: trackingExtension({
      isTracking: () => tracking,
      keptText: (from, to) => keptText(flatten(h.state.blocks), from, to, 'alice'),
      onlyPendingDeletions: (from, to) => onlyPendingDeletions(flatten(h.state.blocks), from, to),
    }),
  });
}

describe('tracking transaction filter', () => {
  it('keeps deleted plain text in the buffer and records the intent', () => {
    const h = harness('Hello world.');
    const state = stateFor('Hello world.', h);
    const tr = state.update({
      changes: { from: 6, to: 11, insert: 'there' },
      userEvent: 'input.type',
    });
    expect(tr.newDoc.toString()).toBe('Hello thereworld.');
    expect(tr.annotation(userIntent)).toEqual([{ from: 6, to: 11, insert: 'there' }]);
    expect(tr.newSelection.main.head).toBe(11);
    expect(intentOf(tr)).toEqual([{ from: 6, to: 11, insert: 'there' }]);
  });

  it('leaves pure insertions and untracked edits alone', () => {
    const h = harness('ab');
    const ins = stateFor('ab', h).update({ changes: { from: 1, insert: 'X' } });
    expect(ins.annotation(userIntent)).toBeUndefined();
    expect(intentOf(ins)).toEqual([{ from: 1, to: 1, insert: 'X' }]);
    const off = stateFor('ab', h, false).update({ changes: { from: 0, to: 1, insert: '' } });
    expect(off.newDoc.toString()).toBe('b');
  });

  it("removes the author's own pending insertion outright", () => {
    const h = harness('ab');
    h.edit(1, 1, 'XYZ', { changeId: 'c1', author: 'alice' });
    const state = stateFor(h.rev(), h);
    const tr = state.update({
      changes: { from: 3, to: 4, insert: '' },
      userEvent: 'delete.backward',
    });
    expect(tr.newDoc.toString()).toBe('aXYb');
  });

  it('turns a deletion covering only pending deletions into a cursor skip', () => {
    const h = harness('abcdef');
    h.edit(2, 4, '', { changeId: 'c1', author: 'alice' }); // "cd" pending deletion
    const state = stateFor(h.rev(), h);
    const back = state.update({ selection: { anchor: 4 } }).state.update({
      changes: { from: 2, to: 4, insert: '' },
      userEvent: 'delete.backward',
    });
    expect(back.docChanged).toBe(false);
    expect(back.newSelection.main.head).toBe(2);
    const fwd = state.update({ selection: { anchor: 2 } }).state.update({
      changes: { from: 2, to: 4, insert: '' },
      userEvent: 'delete.forward',
    });
    expect(fwd.docChanged).toBe(false);
    expect(fwd.newSelection.main.head).toBe(4);
  });

  it('a plain deletion keeps the text but is still a change (it becomes struck)', () => {
    const h = harness('Second sentence here.');
    const state = stateFor(h.rev(), h);
    const tr = state.update({
      changes: { from: 16, to: 21, insert: '' },
      userEvent: 'delete.backward',
    });
    expect(tr.docChanged).toBe(true);
    expect(tr.newDoc.toString()).toBe('Second sentence here.');
    expect(tr.annotation(userIntent)).toEqual([{ from: 16, to: 21, insert: '' }]);
    expect(tr.newSelection.main.head).toBe(16);
  });

  it('onlyPendingDeletions', () => {
    const spans = [
      { kind: 'text' as const, text: 'ab' },
      { kind: 'del' as const, text: 'cd', author: 'bob', changeId: 'd' },
      { kind: 'text' as const, text: 'ef' },
    ];
    expect(onlyPendingDeletions(spans, 2, 4)).toBe(true);
    expect(onlyPendingDeletions(spans, 3, 4)).toBe(true);
    expect(onlyPendingDeletions(spans, 1, 4)).toBe(false);
    expect(onlyPendingDeletions(spans, 2, 5)).toBe(false);
    expect(onlyPendingDeletions(spans, 2, 2)).toBe(false);
  });

  it('does not rewrite transactions that come from the model', () => {
    const h = harness('Hello world.');
    const state = stateFor('Hello world.', h);
    const tr = state.update({
      changes: { from: 6, to: 11, insert: '' },
      annotations: fromModel.of(true),
    });
    expect(tr.newDoc.toString()).toBe('Hello .');
  });

  it('builds decorations and atomic ranges from marks and maps them through edits', () => {
    const h = harness('abcdef');
    const state = stateFor('abcdef', h);
    const withMarks = state.update({
      effects: setMarks.of({
        ranges: [
          { from: 1, to: 2, kind: 'ins', changeId: 'c1', author: 'alice', sentenceId: 's' },
          { from: 3, to: 5, kind: 'del', changeId: 'c1', author: 'alice', sentenceId: 's' },
        ],
        colors: { alice: '#f00' },
        activeChangeId: 'c1',
      }),
    }).state;
    const field = withMarks.field(marksField);
    expect(field.decorations.size).toBe(2);
    expect(field.atomic.size).toBe(1);
    const moved = withMarks.update({
      changes: { from: 0, insert: 'ZZ' },
      annotations: fromModel.of(true),
    }).state;
    const cursor = moved.field(marksField).atomic.iter();
    expect([cursor.from, cursor.to]).toEqual([5, 7]);
  });
});

describe('bufferChangesFor', () => {
  it('mirrors edit, accept, reject, splice, and import', () => {
    const h = harness('Hello world.');
    const before = h.state;
    const op = h.edit(6, 11, 'there', { changeId: 'c1' });
    expect(bufferChangesFor(before, op)).toEqual([{ from: 6, to: 11, insert: 'thereworld' }]);
    const beforeAccept = h.state;
    const acc = h.accept('c1');
    expect(bufferChangesFor(beforeAccept, acc)).toEqual([{ from: 11, to: 16, insert: '' }]);
    const inv = h.inverse[0]!;
    expect(bufferChangesFor(h.state, inv)).toEqual([{ from: 6, to: 11, insert: 'thereworld' }]);
    expect(
      bufferChangesFor(h.state, { id: 'x', type: 'import', author: 'a', ts: 't', text: 'new' }),
    ).toEqual([{ from: 0, to: 12, insert: 'new' }]);
    expect(
      bufferChangesFor(h.state, { id: 'x', type: 'set_tracking', author: 'a', ts: 't', on: true }),
    ).toEqual([]);
  });

  it('reject mirrors the vanishing insertions', () => {
    const h = harness('Hello world.');
    h.edit(6, 11, 'there', { changeId: 'c1' });
    const before = h.state;
    const rej = h.reject('c1');
    expect(bufferChangesFor(before, rej)).toEqual([{ from: 6, to: 11, insert: '' }]);
    expect(h.rev()).toBe('Hello world.');
  });
});

describe('diffChange', () => {
  it('finds the minimal replacement', () => {
    expect(diffChange('abc', 'abc')).toBeUndefined();
    expect(diffChange('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' });
    expect(diffChange('abc', 'abcde')).toEqual({ from: 3, to: 3, insert: 'de' });
    expect(diffChange('abcde', 'ae')).toEqual({ from: 1, to: 4, insert: '' });
    expect(diffChange('', 'x')).toEqual({ from: 0, to: 0, insert: 'x' });
  });
});

// Keep Transaction referenced for the userEvent helper types.
void Transaction;
