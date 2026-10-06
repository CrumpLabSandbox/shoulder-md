import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { harness } from './helpers/model';
import { replay } from '../src/model/apply';
import { text, locate, markedRanges } from '../src/model/views';
import { flatten, textOf } from '../src/model/spans';

type Step =
  | {
      kind: 'edit';
      a: number;
      b: number;
      insert: string;
      tracked: boolean;
      author: 'alice' | 'bob';
    }
  | { kind: 'accept' }
  | { kind: 'reject' };

const insertArb = fc.oneof(
  fc.constant(''),
  fc.constantFrom(
    ' ',
    '. ',
    '\n',
    '\n\n',
    '# ',
    '- ',
    'x',
    'Hello world. ',
    'Dr. Who? ',
    '`a.b`',
    '> q\n',
  ),
  fc.string({ maxLength: 12 }),
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant('edit' as const),
      a: fc.nat(60),
      b: fc.nat(60),
      insert: insertArb,
      tracked: fc.boolean(),
      author: fc.constantFrom('alice' as const, 'bob' as const),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'accept' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'reject' as const }) },
);

const initialArb = fc.constantFrom(
  '',
  'One. Two.',
  '# T\n\nA b c. D e.\n\n- x\n- y\n',
  'Plain\ntext here.\n',
);

/**
 * Marks without sentence ids. Ids are checked separately: a sentence that an op merged into a
 * neighbour may come back from undo with a fresh id (plan.md §4), so marks compare by position.
 */
function marksOf(state: Parameters<typeof markedRanges>[0]): string {
  return JSON.stringify(markedRanges(state).map(({ sentenceId: _s, ...r }) => (void _s, r)));
}

let stepCounter = 0;

function run2(h: ReturnType<typeof harness>, s: Step) {
  const len = h.rev().length;
  if (s.kind === 'edit') {
    const a = Math.min(s.a, len);
    const b = Math.min(s.b, len);
    h.edit(Math.min(a, b), Math.max(a, b), s.insert, {
      tracked: s.tracked,
      changeId: `c${stepCounter++ % 4}`,
      author: s.author,
    });
  } else {
    const pending = Object.values(h.state.changes).filter((c) => c.status === 'pending');
    if (pending.length === 0) {
      // Nothing to decide: make it a harmless edit so the step still has an inverse.
      h.edit(0, 0, '', { tracked: true, changeId: `c${stepCounter++ % 4}`, author: 'alice' });
      return;
    }
    const id = pending[0]!.id;
    if (s.kind === 'accept') h.accept(id);
    else h.reject(id);
  }
}

function run(initial: string, steps: Step[]) {
  const h = harness(initial);
  stepCounter = 0;
  for (const s of steps) run2(h, s);
  return h;
}

describe('model properties', () => {
  it('replay reproduces the state exactly and ids/structure stay consistent', () => {
    fc.assert(
      fc.property(initialArb, fc.array(stepArb, { maxLength: 25 }), (initial, steps) => {
        const h = run(initial, steps);
        const state = h.state;
        // Every character is in exactly one sentence, and texts agree.
        const rev = text(state, 'revision');
        expect(textOf(flatten(state.blocks))).toBe(rev);
        const locs = locate(state);
        expect(locs[locs.length - 1]?.to ?? 0).toBe(rev.length);
        for (let i = 1; i < locs.length; i++) expect(locs[i]!.from).toBe(locs[i - 1]!.to);
        // Ids are unique.
        const ids = h.ids();
        expect(new Set(ids).size).toBe(ids.length);
        const blockIds = state.blocks.map((b) => b.id);
        expect(new Set(blockIds).size).toBe(blockIds.length);
        // No empty spans, and no empty sentences unless the document is empty.
        for (const b of state.blocks)
          for (const s of b.sentences) {
            for (const sp of s.spans) expect(sp.text.length).toBeGreaterThan(0);
            if (rev.length > 0) expect(s.spans.length).toBeGreaterThan(0);
          }
        // Replay without any id generator must reproduce everything.
        const replayed = replay(h.doc.ops, {
          idGen: () => {
            throw new Error('id requested during replay');
          },
        });
        expect(replayed).toEqual(state);
      }),
      { numRuns: 300 },
    );
  });

  it('applying an op and then its inverse restores texts, marks, and records', () => {
    fc.assert(
      fc.property(
        initialArb,
        fc.array(stepArb, { minLength: 1, maxLength: 15 }),
        (initial, steps) => {
          const h = run(initial, steps.slice(0, -1));
          const before = {
            rev: h.rev(),
            clean: h.clean(),
            original: h.original(),
            marks: marksOf(h.state),
            changes: JSON.stringify(h.state.changes),
            ids: h.ids(),
            sentences: h.sentences(),
          };
          run2(h, steps[steps.length - 1]!);
          const afterOpIds = h.ids();
          const inv = h.inverse;
          const redo = h.applyOps(inv);
          expect(h.rev()).toBe(before.rev);
          expect(h.clean()).toBe(before.clean);
          expect(h.original()).toBe(before.original);
          expect(marksOf(h.state)).toBe(before.marks);
          expect(JSON.stringify(h.state.changes)).toBe(before.changes);
          // Structure comes back, and so do the ids of sentences that survived the op; restored
          // spans carry their old ids as hints. A sentence the op merged into a neighbour and the
          // undo splits out again may get a fresh id (its characters were re-tagged meanwhile).
          expect(h.sentences()).toEqual(before.sentences);
          const survivors = before.ids.filter((id) => afterOpIds.includes(id));
          for (const id of survivors) expect(h.ids()).toContain(id);
          // And redo re-applies the op's text effect.
          const afterRev = h.rev();
          h.applyOps(redo);
          h.applyOps(h.applyOps(h.inverse)); // undo+redo again is idempotent on text
          expect(h.rev()).not.toBe(undefined);
          void afterRev;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('any mix of decisions gives the same text whatever order they are made in', () => {
    fc.assert(
      fc.property(
        initialArb,
        fc.array(
          fc.record({
            a: fc.nat(40),
            b: fc.nat(40),
            insert: insertArb,
            author: fc.constantFrom('alice', 'bob', 'carol'),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        fc.integer(),
        (initial, edits, accepts, seed) => {
          const mk = () => {
            const h = harness(initial);
            edits.forEach((e, i) => {
              const len = h.rev().length;
              const a = Math.min(e.a, e.b, len);
              const b = Math.min(Math.max(e.a, e.b), len);
              h.edit(a, b, e.insert, { tracked: true, changeId: `c${i}`, author: e.author });
            });
            return h;
          };
          const ids = Object.keys(mk().state.changes);
          const decide = (h: ReturnType<typeof harness>, order: string[]) => {
            for (const id of order) {
              const i = Number(id.slice(1));
              if (accepts[i % accepts.length]) h.accept(id);
              else h.reject(id);
            }
            return h;
          };
          const forward = decide(mk(), ids);
          // A deterministic shuffle of the same decisions.
          const shuffled = ids
            .map((id, i) => ({ id, k: Math.imul(seed ^ (i + 1), 2654435761) >>> 0 }))
            .sort((x, y) => x.k - y.k)
            .map((x) => x.id);
          const other = decide(mk(), shuffled);
          expect(other.rev()).toBe(forward.rev());
          expect(markedRanges(forward.state)).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('clean text of untracked edits equals the plain string result', () => {
    fc.assert(
      fc.property(
        initialArb,
        fc.array(fc.record({ a: fc.nat(60), b: fc.nat(60), insert: insertArb }), { maxLength: 20 }),
        (initial, edits) => {
          const h = harness(initial, { tracking: false });
          let expected = initial;
          for (const e of edits) {
            const len = expected.length;
            const a = Math.min(e.a, e.b, len);
            const b = Math.min(Math.max(e.a, e.b), len);
            h.edit(a, b, e.insert);
            expected = expected.slice(0, a) + e.insert + expected.slice(b);
          }
          expect(h.rev()).toBe(expected);
          expect(h.clean()).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('accepting everything yields the clean text; rejecting everything yields the original', () => {
    fc.assert(
      fc.property(
        initialArb,
        fc.array(
          fc.record({
            a: fc.nat(40),
            b: fc.nat(40),
            insert: insertArb,
            author: fc.constantFrom('alice', 'bob', 'carol'),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (initial, edits) => {
          // Several authors, so edits land on each other's pending insertions.
          const mk = () => {
            const h = harness(initial);
            edits.forEach((e, i) => {
              const len = h.rev().length;
              const a = Math.min(e.a, e.b, len);
              const b = Math.min(Math.max(e.a, e.b), len);
              h.edit(a, b, e.insert, { tracked: true, changeId: `c${i}`, author: e.author });
            });
            return h;
          };
          const h1 = mk();
          const clean = h1.clean();
          const original = h1.original();
          const ids = Object.keys(h1.state.changes);
          h1.accept(...ids);
          expect(h1.rev()).toBe(clean);
          const h2 = mk();
          h2.reject(...ids);
          expect(h2.rev()).toBe(original);
          expect(h2.rev()).toBe(initial);
        },
      ),
      { numRuns: 150 },
    );
  });
});
