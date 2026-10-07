import { describe, it, expect } from 'vitest';
import { harness } from './helpers/model';
import { changeRecords, toJsonl, captureChange } from '../src/library/records';
import { docStats } from '../src/library/stats';
import { createDocument } from '../src/model/apply';

describe('group reasons in the dataset', () => {
  it('puts the shared reason and group id on each row and counts the changes as reasoned', () => {
    const h = harness('One two. Three four.');
    h.edit(0, 3, 'A', { changeId: 'c1' });
    const at = h.rev().indexOf('four');
    h.edit(at, at + 4, 'five', { changeId: 'c2' });
    h.op({ type: 'set_reason', changeId: 'c1', reason: 'shorter' });
    h.op({ type: 'set_group_reason', groupId: 'g1', changeIds: ['c1', 'c2'], reason: 'tighten' });
    h.accept('c1');
    h.accept('c2');
    const rows = changeRecords(h.doc, {});
    expect(rows[0]).toMatchObject({ reason: 'shorter', groupId: 'g1', groupReason: 'tighten' });
    expect(rows[1]).toMatchObject({ groupId: 'g1', groupReason: 'tighten' });
    expect(rows[1]!.reason).toBeUndefined();
    expect(docStats(h.state).reasoned).toBe(2);
  });
});

describe('changeRecords', () => {
  it('captures decided changes with sentence, neighbours, reason, discussion, and outcome', () => {
    const h = harness('# Results\n\nWe ran it. The results was significant. Then we stopped.');
    const rev = () => h.rev();
    const at = rev().indexOf('was');
    h.edit(at, at + 3, 'were', { changeId: 'c1', author: 'bob' });
    h.op({
      type: 'set_reason',
      changeId: 'c1',
      reason: 'subject-verb agreement',
      reasonTags: ['grammar'],
    });
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'plural subject',
      anchor: { sentenceIds: [h.ids()[2]!], from: 0, to: 3 },
      changeId: 'c1',
      author: 'bob',
    });
    const at2 = rev().indexOf('Then');
    h.edit(at2, at2 + 4, 'Finally', { changeId: 'c2', author: 'bob' });
    h.accept('c1');
    h.reject('c2');
    const rows = changeRecords(h.doc, { authorNames: { bob: 'Bob' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      v: 1,
      docId: 'doc',
      docTitle: 'Results',
      changeId: 'c1',
      author: 'Bob',
      blockKind: 'paragraph',
      before: 'was',
      after: 'were',
      sentenceBefore: 'The results was significant.',
      sentenceAfter: 'The results were significant.',
      contextBefore: 'We ran it.',
      // c2 was still pending when c1 was decided, so it appears in its original form.
      contextAfter: 'Then we stopped.',
      reason: 'subject-verb agreement',
      reasonTags: ['grammar'],
      discussion: [{ author: 'Bob', body: 'plural subject' }],
      outcome: 'accepted',
      decidedBy: 'Bob',
    });
    expect(rows[1]).toMatchObject({
      changeId: 'c2',
      before: 'Then',
      after: 'Finally',
      sentenceBefore: 'Then we stopped.',
      sentenceAfter: 'Finally we stopped.',
      // The accepted c1 shows in its new form in the neighbour.
      contextBefore: 'The results were significant.',
      contextAfter: '',
      reasonTags: [],
      outcome: 'rejected',
    });
    expect(rows[1]!.reason).toBeUndefined();
  });

  it('includes pending changes only when asked, with context from the current state', () => {
    const h = harness('One two. Three four.');
    h.edit(4, 7, 'TWO', { changeId: 'c1' });
    expect(changeRecords(h.doc)).toEqual([]);
    const [row] = changeRecords(h.doc, { includePending: true });
    expect(row).toMatchObject({
      outcome: 'pending',
      before: 'two',
      after: 'TWO',
      sentenceBefore: 'One two.',
      sentenceAfter: 'One TWO.',
      contextAfter: 'Three four.',
    });
    expect(row!.decidedBy).toBeUndefined();
  });

  it('includes untracked edits only when asked', () => {
    const h = harness('Draft text here.', { tracking: false });
    h.edit(6, 10, 'words', { changeId: 'u1' });
    expect(changeRecords(h.doc)).toEqual([]);
    const [row] = changeRecords(h.doc, { includeUntracked: true });
    expect(row).toMatchObject({
      outcome: 'untracked',
      before: 'text',
      after: 'words',
      sentenceBefore: 'Draft text here.',
      sentenceAfter: 'Draft words here.',
    });
  });

  it('follows undo: an undone decision is pending again, an undone edit has no row', () => {
    const h = harness('Alpha beta. Gamma.');
    h.edit(0, 5, 'ALPHA', { changeId: 'c1' });
    h.accept('c1');
    h.applyOps(h.inverse); // undo the accept
    expect(changeRecords(h.doc)).toEqual([]);
    expect(changeRecords(h.doc, { includePending: true })[0]).toMatchObject({
      outcome: 'pending',
      sentenceBefore: 'Alpha beta.',
      sentenceAfter: 'ALPHA beta.',
    });
    h.edit(h.rev().indexOf('Gamma'), h.rev().indexOf('Gamma') + 5, 'Delta', { changeId: 'c2' });
    h.applyOps(h.inverse); // undo the edit
    expect(changeRecords(h.doc, { includePending: true }).map((r) => r.changeId)).toEqual(['c1']);
  });

  it('isolates the change when another pending change touches the same sentences', () => {
    const h = harness('The results was significant. We stopped there.');
    const was = h.rev().indexOf('was');
    h.edit(was, was + 3, 'were', { changeId: 'c1' });
    const dot = h.rev().indexOf('. We');
    h.edit(dot, dot + 2, 'They', { changeId: 'c2' }); // a pending edit across the boundary
    h.accept('c1');
    const [row] = changeRecords(h.doc);
    expect(row).toMatchObject({
      sentenceBefore: 'The results was significant.',
      sentenceAfter: 'The results were significant.',
      contextAfter: 'We stopped there.',
    });
  });

  it('a change spanning two sentences keeps both in its sentence text', () => {
    const h = harness('One. Two. Three.');
    h.edit(3, 5, '; ', { changeId: 'c1' }); // ". " → "; " merges after accept
    const c = captureChange(h.state, 'c1')!;
    expect(c.sentenceBefore).toBe('One. Two.');
    expect(c.sentenceAfter).toBe('One; Two.');
    h.accept('c1');
    expect(changeRecords(h.doc)[0]).toMatchObject({
      sentenceBefore: 'One. Two.',
      sentenceAfter: 'One; Two.',
      contextAfter: 'Three.',
    });
  });

  it('serialises as JSON lines', () => {
    const h = harness('a b.');
    h.edit(0, 1, 'A', { changeId: 'c1' });
    h.accept('c1');
    const out = toJsonl(changeRecords(h.doc));
    expect(out.endsWith('\n')).toBe(true);
    expect(
      out
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).changeId),
    ).toEqual(['c1']);
    expect(toJsonl([])).toBe('');
  });
});

describe('docStats', () => {
  it('counts tracked changes by status and reasons, ignoring untracked edits', () => {
    const h = harness('One two three four.');
    h.edit(0, 3, 'Uno', { changeId: 'c1' });
    h.edit(h.rev().indexOf('two'), h.rev().indexOf('two') + 3, 'dos', { changeId: 'c2' });
    h.edit(h.rev().indexOf('four'), h.rev().indexOf('four') + 4, 'cuatro', { changeId: 'c3' });
    h.edit(h.rev().length, h.rev().length, ' x', { changeId: 'u1', tracked: false });
    h.op({ type: 'set_reason', changeId: 'c1', reasonTags: ['style'] });
    h.accept('c1');
    h.reject('c2');
    h.op({
      type: 'set_meta',
      patch: { tags: ['paper'], status: 'in-review', libraryEligible: true },
    });
    expect(docStats(h.state)).toMatchObject({
      pendingChanges: 1,
      acceptedChanges: 1,
      rejectedChanges: 1,
      reasoned: 1,
      status: 'in-review',
      tags: ['paper'],
      libraryEligible: true,
    });
  });

  it('createDocument can opt a new document into the library', () => {
    expect(createDocument({ author: 'a', libraryEligible: true }).state.meta.libraryEligible).toBe(
      true,
    );
    expect(createDocument({ author: 'a' }).state.meta.libraryEligible).toBe(false);
  });
});

describe('records with deleted insertions', () => {
  it('credits the inserted text to its inserter and isolates each change', () => {
    const h = harness('Results were clear.');
    const at = h.rev().indexOf(' clear');
    h.edit(at, at, ' very', { changeId: 'A', author: 'alice' });
    const v = h.rev().indexOf(' very');
    h.edit(v, v + 5, '', { changeId: 'B', author: 'bob' });
    const rows = changeRecords(h.doc, { includePending: true });
    expect(
      rows.map((r) => [r.changeId, r.before, r.after, r.sentenceBefore, r.sentenceAfter]),
    ).toEqual([
      ['A', '', ' very', 'Results were clear.', 'Results were very clear.'],
      ['B', ' very', '', 'Results were clear.', 'Results were clear.'],
    ]);
    h.reject('A');
    // A is a decided row; B's marks went away with A's rejection, so it has nothing to review.
    expect(
      changeRecords(h.doc, { includePending: true }).map((r) => [r.changeId, r.outcome]),
    ).toEqual([['A', 'rejected']]);
    expect(docStats(h.state).pendingChanges).toBe(0);
  });
});
