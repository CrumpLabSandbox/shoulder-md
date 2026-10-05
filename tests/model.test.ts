import { describe, it, expect } from 'vitest';
import { harness } from './helpers/model';
import { replay } from '../src/model/apply';
import { pendingChanges, shouldCoalesce } from '../src/model/changes';
import { markedRanges, mapOffset } from '../src/model/views';
import { OffsetMap } from '../src/model/spans';
import { hashState } from '../src/model/hash';
import { keptText } from '../src/model/spans';

describe('import', () => {
  it('builds blocks and sentences that reproduce the text', () => {
    const h = harness('# Title\n\nOne. Two.\n\n- a\n');
    expect(h.rev()).toBe('# Title\n\nOne. Two.\n\n- a\n');
    expect(h.state.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list_item']);
    expect(h.sentences()).toEqual(['# Title\n\n', 'One. ', 'Two.\n\n', '- a\n']);
    // n1 is the import op id; blocks are allocated before sentences.
    expect(h.state.blocks.map((b) => b.id)).toEqual(['n2', 'n3', 'n4']);
    expect(h.ids()).toEqual(['n5', 'n6', 'n7', 'n8']);
  });

  it('handles an empty document', () => {
    const h = harness('');
    expect(h.state.blocks).toHaveLength(1);
    expect(h.sentences()).toEqual(['']);
  });
});

describe('untracked edits', () => {
  it('keeps the sentence id for an edit inside a sentence', () => {
    const h = harness('One two. Three.', { tracking: false });
    const [a, b] = h.ids();
    const op = h.edit(4, 7, 'TWO');
    expect(h.rev()).toBe('One TWO. Three.');
    expect(h.ids()).toEqual([a, b]);
    expect(op.type === 'edit' && op.effects).toEqual([]);
  });

  it('splits when a new sentence is typed and keeps the old id on the larger part', () => {
    const h = harness('One two.', { tracking: false });
    const [a] = h.ids();
    const op = h.edit(8, 8, ' Three four five.');
    expect(h.sentences()).toEqual(['One two. ', 'Three four five.']);
    const [x, y] = h.ids();
    expect(x).toBe(a);
    expect(y).not.toBe(a);
    // Not a split: the old sentence's characters all stayed in one new sentence.
    expect(op.type === 'edit' && op.effects).toEqual([{ kind: 'sentence_added', sentenceId: y }]);
    expect(op.type === 'edit' && op.alloc).toEqual({ sentenceIds: [y], blockIds: [] });
  });

  it('splits when a terminator is typed mid-sentence', () => {
    const h = harness('One Two three four.', { tracking: false });
    const [a] = h.ids();
    const op = h.edit(3, 4, '. ');
    expect(h.sentences()).toEqual(['One. ', 'Two three four.']);
    const [x, y] = h.ids();
    expect(y).toBe(a); // the larger remainder keeps the id
    expect(x).not.toBe(a);
    expect(op.type === 'edit' && op.effects).toEqual([
      { kind: 'split', sentenceId: a, into: [x, y] },
      { kind: 'sentence_added', sentenceId: x },
    ]);
  });

  it('merges when the boundary is removed', () => {
    const h = harness('Alpha beta. Gamma delta epsilon.', { tracking: false });
    const [a, b] = h.ids();
    const op = h.edit(10, 12, ', ');
    expect(h.sentences()).toEqual(['Alpha beta, Gamma delta epsilon.']);
    expect(h.ids()).toEqual([b]); // the longer half keeps its id
    expect(op.type === 'edit' && op.effects).toEqual([
      { kind: 'merge', sentenceIds: [a, b], into: b },
      { kind: 'sentence_removed', sentenceId: a },
    ]);
  });

  it('adds and removes blocks with paragraph breaks', () => {
    const h = harness('One. Two.', { tracking: false });
    const [blockA] = h.state.blocks.map((b) => b.id);
    const [s1, s2] = h.ids();
    h.edit(5, 5, '\n\n');
    expect(h.state.blocks).toHaveLength(2);
    expect(h.state.blocks[0]!.id).toBe(blockA);
    expect(h.ids()).toEqual([s1, s2]);
    expect(h.sentences()).toEqual(['One. \n\n', 'Two.']);
    h.edit(5, 7, '');
    expect(h.state.blocks).toHaveLength(1);
    expect(h.ids()).toEqual([s1, s2]);
  });

  it('records untracked edits as auto-accepted changes with before/after', () => {
    const h = harness('Hello world.', { tracking: false });
    h.edit(6, 11, 'there', { changeId: 'c1' });
    const rec = h.state.changes['c1']!;
    expect(rec).toMatchObject({
      tracked: false,
      status: 'accepted',
      before: 'world',
      after: 'there',
    });
    expect(pendingChanges(h.state)).toEqual([]);
  });
});

describe('tracked edits', () => {
  it('keeps deleted text in the revision and removes it from clean', () => {
    const h = harness('Keep this and remove that.');
    h.edit(14, 25, 'add this', { changeId: 'c1' });
    expect(h.rev()).toBe('Keep this and add thisremove that.');
    expect(h.clean()).toBe('Keep this and add this.');
    expect(h.original()).toBe('Keep this and remove that.');
    const [sid] = h.ids();
    expect(markedRanges(h.state)).toEqual([
      { from: 14, to: 22, kind: 'ins', changeId: 'c1', author: 'alice', sentenceId: sid },
      { from: 22, to: 33, kind: 'del', changeId: 'c1', author: 'alice', sentenceId: sid },
    ]);
    const [c] = pendingChanges(h.state);
    expect(c).toMatchObject({ id: 'c1', before: 'remove that', after: 'add this' });
  });

  it('accepts and rejects', () => {
    const h = harness('Keep this and remove that.');
    h.edit(14, 25, 'add this', { changeId: 'c1' });
    const snapshot = h.doc;
    h.accept('c1');
    expect(h.rev()).toBe('Keep this and add this.');
    expect(h.state.changes['c1']).toMatchObject({
      status: 'accepted',
      before: 'remove that',
      after: 'add this',
      decidedBy: 'bob',
    });
    // Rewind and reject instead.
    const h2 = harness('Keep this and remove that.');
    h2.edit(14, 25, 'add this', { changeId: 'c1' });
    h2.reject('c1');
    expect(h2.rev()).toBe('Keep this and remove that.');
    expect(h2.state.changes['c1']!.status).toBe('rejected');
    expect(snapshot.state.changes['c1']!.status).toBe('pending');
  });

  it("removes the author's own pending insertion outright on backspace", () => {
    const h = harness('ab');
    h.edit(1, 1, 'XYZ', { changeId: 'c1' });
    h.edit(3, 4, '', { changeId: 'c1' }); // backspace over Z
    expect(h.rev()).toBe('aXYb');
    expect(markedRanges(h.state)).toEqual([
      { from: 1, to: 3, kind: 'ins', changeId: 'c1', author: 'alice', sentenceId: h.ids()[0] },
    ]);
  });

  it("turns another author's insertion into a deletion", () => {
    const h = harness('ab');
    h.edit(1, 1, 'X', { changeId: 'c1', author: 'alice' });
    h.edit(1, 2, '', { changeId: 'c2', author: 'bob' });
    expect(h.rev()).toBe('aXb');
    expect(markedRanges(h.state)[0]).toMatchObject({ kind: 'del', changeId: 'c2', author: 'bob' });
    expect(h.clean()).toBe('ab');
  });

  it('keeps sentence ids across accept of a boundary deletion', () => {
    const h = harness('Alpha. Beta gamma.');
    const [a, b] = h.ids();
    h.edit(5, 7, '', { changeId: 'c1' }); // delete ". " → pending
    expect(h.ids()).toEqual([a, b]); // structure follows the revision text
    h.accept('c1');
    expect(h.sentences()).toEqual(['AlphaBeta gamma.']);
    expect(h.ids()).toEqual([b]);
  });
});

describe('comments', () => {
  it('anchors survive edits before, inside, and after them', () => {
    const h = harness('One two three. Four five.', { tracking: false });
    const [s1, s2] = h.ids();
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'hm',
      anchor: { sentenceIds: [s1!], from: 4, to: 13 },
    }); // "two three"
    h.edit(0, 3, 'Uno'); // before, same length
    h.edit(0, 0, 'Pre '); // before, longer
    expect(h.state.comments[0]!.anchor).toEqual({ sentenceIds: [s1], from: 8, to: 17 });
    h.edit(12, 12, 'XX'); // inside: "two XXthree"
    expect(h.state.comments[0]!.anchor).toEqual({ sentenceIds: [s1], from: 8, to: 19 });
    h.edit(30, 30, ' Six.'); // after
    expect(h.state.comments[0]!.anchor).toEqual({ sentenceIds: [s1], from: 8, to: 19 });
    expect(h.ids()[1]).toBe(s2);
  });

  it('spans sentences and orphans when the text is gone', () => {
    const h = harness('One. Two. Three.', { tracking: false });
    const [s1, s2, s3] = h.ids();
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'x',
      anchor: { sentenceIds: [s1!, s2!], from: 2, to: 3 },
    }); // "e. Two"
    expect(h.state.comments[0]!.anchor).toEqual({ sentenceIds: [s1, s2], from: 2, to: 3 });
    h.edit(0, 9, ''); // delete "One. Two."
    const t = h.state.comments[0]!;
    expect(t.anchor).toBeNull();
    expect(t.blockId).toBe(h.state.blocks[0]!.id);
    expect(h.ids()).toEqual([s3]);
  });

  it('reply, edit, resolve', () => {
    const h = harness('A.');
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'first',
      anchor: { sentenceIds: [h.ids()[0]!], from: 0, to: 1 },
    });
    h.op({ type: 'comment_reply', threadId: 't1', commentId: 'k2', body: 'second', author: 'bob' });
    h.op({ type: 'comment_edit', threadId: 't1', commentId: 'k1', body: 'first!' });
    h.op({ type: 'comment_resolve', threadId: 't1', resolved: true });
    expect(h.state.comments[0]).toMatchObject({
      resolved: true,
      comments: [
        { id: 'k1', body: 'first!' },
        { id: 'k2', body: 'second', author: 'bob' },
      ],
    });
  });
});

describe('reasons and meta', () => {
  it('sets reasons and meta', () => {
    const h = harness('A.');
    h.edit(0, 1, 'B', { changeId: 'c1' });
    h.op({ type: 'set_reason', changeId: 'c1', reason: 'clarity', reasonTags: ['clarity'] });
    expect(h.state.changes['c1']).toMatchObject({ reason: 'clarity', reasonTags: ['clarity'] });
    h.op({ type: 'set_meta', patch: { title: 'T', libraryEligible: true } });
    expect(h.state.meta).toMatchObject({ title: 'T', libraryEligible: true, status: 'draft' });
  });
});

describe('replay', () => {
  it('reproduces the state, ids included, from the op log', () => {
    const h = harness('# T\n\nOne two. Three.\n\n- a\n- b\n');
    h.edit(9, 9, 'X', { changeId: 'c1' });
    h.edit(17, 17, ' New sentence here.', { changeId: 'c2' });
    h.edit(5, 5, '\n\n', { changeId: 'c3', tracked: false });
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'x',
      anchor: { sentenceIds: [h.ids()[1]!], from: 0, to: 3 },
    });
    h.accept('c1');
    h.reject('c2');
    const replayed = replay(h.doc.ops, { idGen: () => 'SHOULD-NOT-BE-CALLED' });
    expect(replayed).toEqual(h.state);
    expect(hashState(replayed)).toBe(hashState(h.state));
  });
});

describe('views', () => {
  it('maps revision offsets to clean and original', () => {
    const h = harness('abcdef');
    h.edit(2, 4, 'XY', { changeId: 'c1' }); // ab XY cd ef → rev 'abXYcdef'
    expect(h.rev()).toBe('abXYcdef');
    expect(mapOffset(h.state, 0, 'clean')).toBe(0);
    expect(mapOffset(h.state, 4, 'clean')).toBe(4); // after XY
    expect(mapOffset(h.state, 6, 'clean')).toBe(4); // after deleted cd collapses
    expect(mapOffset(h.state, 8, 'clean')).toBe(6);
    expect(mapOffset(h.state, 4, 'original')).toBe(2);
    expect(mapOffset(h.state, 8, 'original')).toBe(6);
  });
});

describe('OffsetMap', () => {
  it('maps around insertions and removals', () => {
    const m = new OffsetMap([
      { oldLen: 2, newLen: 2, identity: true },
      { oldLen: 0, newLen: 3, identity: false },
      { oldLen: 2, newLen: 0, identity: false },
      { oldLen: 2, newLen: 2, identity: true },
    ]);
    expect(m.map(1)).toBe(1);
    expect(m.map(2, -1)).toBe(2);
    expect(m.map(2, 1)).toBe(5);
    expect(m.map(3)).toBe(5);
    expect(m.map(4)).toBe(5);
    expect(m.map(5)).toBe(6);
    expect(m.map(6)).toBe(7);
  });
});

describe('shouldCoalesce', () => {
  it('joins contiguous typing by the same author within the window', () => {
    const last = { changeId: 'c', author: 'a', endOffset: 10, at: 1000, tracked: true };
    expect(shouldCoalesce(last, { author: 'a', from: 10, to: 10, at: 1500, tracked: true })).toBe(
      true,
    );
    expect(shouldCoalesce(last, { author: 'a', from: 9, to: 10, at: 1500, tracked: true })).toBe(
      true,
    ); // backspace
    expect(shouldCoalesce(last, { author: 'a', from: 3, to: 3, at: 1500, tracked: true })).toBe(
      false,
    );
    expect(shouldCoalesce(last, { author: 'b', from: 10, to: 10, at: 1500, tracked: true })).toBe(
      false,
    );
    expect(shouldCoalesce(last, { author: 'a', from: 10, to: 10, at: 9000, tracked: true })).toBe(
      false,
    );
    expect(shouldCoalesce(undefined, { author: 'a', from: 0, to: 0, at: 0, tracked: true })).toBe(
      false,
    );
  });
});

describe('inverses (undo through the model)', () => {
  it('undoes a tracked replacement exactly, marks and record included', () => {
    const h = harness('Keep this and remove that.');
    const before = h.state;
    h.edit(14, 25, 'add this', { changeId: 'c1' });
    const inv = h.inverse;
    expect(inv).toHaveLength(1);
    expect(inv[0]!.type).toBe('splice');
    const redo = h.applyOps(inv);
    expect(h.rev()).toBe('Keep this and remove that.');
    expect(markedRanges(h.state)).toEqual([]);
    expect(h.state.changes['c1']).toBeUndefined();
    expect(h.ids()).toEqual(before.blocks.flatMap((b) => b.sentences.map((s) => s.id)));
    // Redo brings the change back.
    h.applyOps(redo);
    expect(h.rev()).toBe('Keep this and add thisremove that.');
    expect(h.state.changes['c1']!.status).toBe('pending');
    expect(pendingChanges(h.state)[0]).toMatchObject({ before: 'remove that', after: 'add this' });
  });

  it('undoes an accept of several scattered changes', () => {
    const h = harness('One two three four five.');
    h.edit(4, 7, 'TWO', { changeId: 'c1' });
    h.edit(h.rev().indexOf('four'), h.rev().indexOf('four') + 4, 'FOUR', { changeId: 'c2' });
    const revBefore = h.rev();
    const marksBefore = markedRanges(h.state);
    h.accept('c1', 'c2');
    expect(h.rev()).toBe('One TWO three FOUR five.');
    expect(h.inverse.length).toBe(2);
    h.applyOps(h.inverse);
    expect(h.rev()).toBe(revBefore);
    expect(markedRanges(h.state)).toEqual(marksBefore);
    expect(h.state.changes['c1']!.status).toBe('pending');
    expect(h.state.changes['c2']!.status).toBe('pending');
  });

  it('restores the old sentence id when an undo brings a sentence back', () => {
    const h = harness('First one. Second one.', { tracking: false });
    const [a, b] = h.ids();
    h.edit(11, 22, ''); // delete the second sentence
    expect(h.ids()).toEqual([a]);
    h.applyOps(h.inverse);
    expect(h.sentences()).toEqual(['First one. ', 'Second one.']);
    expect(h.ids()).toEqual([a, b]);
  });

  it('a splice is bounds-checked', () => {
    const h = harness('abc');
    expect(() => h.op({ type: 'splice', from: 2, to: 9, spans: [] })).toThrow();
  });
});

describe('keptText', () => {
  it("keeps pending deletions and other authors' insertions, drops own insertions", () => {
    const spans = [
      { kind: 'text' as const, text: 'ab' },
      { kind: 'ins' as const, text: 'XY', author: 'alice', changeId: 'c' },
      { kind: 'del' as const, text: 'cd', author: 'bob', changeId: 'd' },
      { kind: 'ins' as const, text: 'Z', author: 'bob', changeId: 'e' },
      { kind: 'text' as const, text: 'ef' },
    ];
    expect(keptText(spans, 0, 9, 'alice')).toBe('abcdZef');
    expect(keptText(spans, 1, 5, 'alice')).toBe('bc');
    expect(keptText(spans, 2, 4, 'alice')).toBe('');
    expect(keptText(spans, 2, 4, 'bob')).toBe('XY');
  });
});
