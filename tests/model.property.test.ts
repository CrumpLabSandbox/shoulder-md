import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { harness } from './helpers/model';
import { replay } from '../src/model/apply';
import { text, locate } from '../src/model/views';
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

function run(initial: string, steps: Step[]) {
  const h = harness(initial);
  let n = 0;
  for (const s of steps) {
    const len = h.rev().length;
    if (s.kind === 'edit') {
      const a = Math.min(s.a, len);
      const b = Math.min(s.b, len);
      h.edit(Math.min(a, b), Math.max(a, b), s.insert, {
        tracked: s.tracked,
        changeId: `c${n++ % 4}`,
        author: s.author,
      });
    } else {
      const pending = Object.values(h.state.changes).filter((c) => c.status === 'pending');
      if (pending.length === 0) continue;
      const id = pending[0]!.id;
      if (s.kind === 'accept') h.accept(id);
      else h.reject(id);
    }
  }
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
        fc.array(fc.record({ a: fc.nat(40), b: fc.nat(40), insert: insertArb }), {
          minLength: 1,
          maxLength: 10,
        }),
        (initial, edits) => {
          const mk = () => {
            const h = harness(initial);
            edits.forEach((e, i) => {
              const len = h.rev().length;
              const a = Math.min(e.a, e.b, len);
              const b = Math.min(Math.max(e.a, e.b), len);
              h.edit(a, b, e.insert, { tracked: true, changeId: `c${i}` });
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
