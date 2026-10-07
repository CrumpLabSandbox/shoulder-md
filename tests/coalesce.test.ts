import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { applyOp, createDocument, replay } from '../src/model/apply';
import { composeSplices, extendEdit, type EditOp } from '../src/model/coalesce';
import { sequentialIds } from '../src/model/ids';
import { absoluteToPos, commentRanges, markedRanges, text } from '../src/model/views';
import { exportJson, importJson } from '../src/export/json';
import type { Document, Op, State } from '../src/model/types';

/** Types like the workspace does: each keystroke is applied, then folded into the run's op. */
function typist(initial: string, opts: { tracked: boolean; fold?: boolean }) {
  const idGen = sequentialIds('n');
  let doc: Document = createDocument({
    id: 'doc',
    text: initial,
    author: 'alice',
    ts: '2026-01-01T00:00:00Z',
    idGen,
  });
  let run: { op: EditOp; base: State } | undefined;
  let n = 0;
  let folds = 0;
  const push = (op: Op) => {
    const r = applyOp(doc.state, op, { idGen });
    doc = { ...doc, ops: [...doc.ops, r.op], state: r.state };
    return r.op;
  };
  return {
    get doc() {
      return doc;
    },
    get folds() {
      return folds;
    },
    op(op: Op) {
      run = undefined;
      return push(op);
    },
    /** One keystroke of change `changeId` at absolute revision offsets. */
    key(from: number, to: number, insert: string, changeId = 'c1') {
      const before = doc.state;
      const own = push({
        id: idGen(),
        type: 'edit',
        author: 'alice',
        ts: `2026-01-01T00:01:${String(++n % 60).padStart(2, '0')}Z`,
        changeId,
        from: absoluteToPos(before, from),
        to: absoluteToPos(before, to),
        insert,
        tracked: opts.tracked,
      }) as EditOp;
      const live = run && run.op === doc.ops[doc.ops.length - 2] && run.op.changeId === changeId;
      const folded =
        opts.fold !== false && run && live
          ? extendEdit(run.base, run.op, { insert, cut: to - from }, doc.state, own.alloc, {
              idGen,
            })
          : undefined;
      if (folded && run) {
        const op = folded.op as EditOp;
        doc = { ...doc, ops: [...doc.ops.slice(0, -2), op], state: folded.state };
        run = { op, base: run.base };
        folds++;
      } else {
        run = { op: own, base: before };
      }
    },
    /** Types a string forward from `at`, one character at a time. */
    type(at: number, s: string, changeId = 'c1') {
      let p = at;
      for (const ch of s) {
        this.key(p, p, ch, changeId);
        p += ch.length;
      }
      return p;
    },
  };
}

const noGen = {
  idGen: () => {
    throw new Error('replay must not allocate ids');
  },
};

describe('typing runs', () => {
  it('logs a run of tracked typing as one op that replays to the same state', () => {
    const t = typist('# T\n\nOne two. Three.\n', { tracked: true });
    const at = t.doc.state ? text(t.doc.state).indexOf('Three') : 0;
    t.type(at, 'New here. And more! ');
    expect(t.doc.ops).toHaveLength(2);
    expect(t.doc.ops[1]).toMatchObject({ type: 'edit', insert: 'New here. And more! ' });
    expect(text(t.doc.state)).toBe('# T\n\nOne two. New here. And more! Three.\n');
    expect(text(t.doc.state, 'original')).toBe('# T\n\nOne two. Three.\n');
    expect(replay(t.doc.ops, noGen)).toEqual(t.doc.state);
    expect(Object.keys(t.doc.state.changes)).toEqual(['c1']);
  });

  it('gives the same text and marks as logging every keystroke', () => {
    const typed = 'A new para.\n\n- item one\n- item two. Done';
    for (const tracked of [true, false]) {
      const a = typist('Start. End.', { tracked });
      const b = typist('Start. End.', { tracked, fold: false });
      a.type(7, typed);
      b.type(7, typed);
      expect(text(a.doc.state)).toBe(text(b.doc.state));
      expect(markedRanges(a.doc.state).map((r) => [r.from, r.to, r.kind])).toEqual(
        markedRanges(b.doc.state).map((r) => [r.from, r.to, r.kind]),
      );
      expect(a.doc.ops.length).toBeLessThan(b.doc.ops.length / 10);
      expect(replay(a.doc.ops, noGen)).toEqual(a.doc.state);
    }
  });

  it('folds backspaces at the end of the run, and stops at anything else', () => {
    const t = typist('One. Two.', { tracked: true });
    const p = t.type(5, 'Helo');
    t.key(p - 1, p, ''); // backspace the o
    t.type(p - 1, 'lo ');
    expect(t.doc.ops).toHaveLength(2);
    expect(t.doc.ops[1]).toMatchObject({ insert: 'Hello ' });
    expect(text(t.doc.state)).toBe('One. Hello Two.');
    // A keystroke somewhere else, even in the same change, starts a new op.
    t.key(0, 0, 'X');
    expect(t.doc.ops).toHaveLength(3);
    expect(text(t.doc.state)).toBe('XOne. Hello Two.');
    expect(replay(t.doc.ops, noGen)).toEqual(t.doc.state);
  });

  it('does not fold across another op, and keeps comment anchors in place', () => {
    const t = typist('One two. Three four.', { tracked: true });
    const s = t.doc.state.blocks[0]!.sentences[1]!.id;
    t.op({
      id: 'k',
      type: 'comment_add',
      author: 'alice',
      ts: 't',
      threadId: 't1',
      commentId: 'k1',
      body: 'hm',
      anchor: { sentenceIds: [s], from: 0, to: 5 },
    });
    t.type(4, 'and a half. Plus ');
    expect(t.doc.ops).toHaveLength(3);
    const r = commentRanges(t.doc.state)[0]!;
    expect(text(t.doc.state).slice(r.from, r.to)).toBe('Three');
    t.op({ id: 'a', type: 'accept', author: 'alice', ts: 't', changeIds: ['c1'] });
    t.type(0, 'Zed ', 'c2');
    expect(t.doc.ops).toHaveLength(5);
    expect(replay(t.doc.ops, noGen)).toEqual(t.doc.state);
  });

  it('refuses a step that is not at the end of the run', () => {
    const t = typist('One. Two.', { tracked: true, fold: false });
    const base = t.doc.state;
    t.key(5, 5, 'a');
    const run = t.doc.ops[1] as EditOp;
    t.key(0, 0, 'b');
    expect(extendEdit(base, run, { insert: 'b', cut: 0 }, t.doc.state)).toBeUndefined();
    expect(extendEdit(base, run, { insert: '', cut: 1 }, t.doc.state)).toBeUndefined();
    expect(extendEdit(base, run, { insert: 'b', cut: 1 }, t.doc.state)).toBeUndefined();
  });

  it('holds for random typing: the folded log replays, and matches the unfolded text', () => {
    const chunk = fc.oneof(
      fc.constantFrom('. ', '\n\n', '# ', '- ', ' ', '`a.b` ', 'Dr. Who? ', '> q\n', '**b** '),
      fc.string({ maxLength: 6 }),
    );
    const stepArb = fc.record({
      at: fc.nat(40),
      typed: fc.array(chunk, { maxLength: 5 }).map((c) => c.join('')),
      back: fc.nat(4),
      more: fc.string({ maxLength: 4 }),
    });
    fc.assert(
      fc.property(
        fc.constantFrom('One. Two.', '# T\n\nA b c. D e.\n\n- x\n- y\n', 'Plain\ntext here.\n'),
        fc.boolean(),
        fc.array(stepArb, { maxLength: 4 }),
        (initial, tracked, steps) => {
          const a = typist(initial, { tracked });
          const b = typist(initial, { tracked, fold: false });
          steps.forEach((s, i) => {
            for (const t of [a, b]) {
              const start = Math.min(s.at, text(t.doc.state).length);
              let p = t.type(start, s.typed, `c${i}`);
              // Backspace only over what this run typed (own text, removed outright).
              const chars = [...s.typed];
              for (let k = 0; k < Math.min(s.back, chars.length); k++) {
                const len = chars[chars.length - 1 - k]!.length;
                t.key(p - len, p, '', `c${i}`);
                p -= len;
              }
              t.type(p, s.more, `c${i}`);
            }
          });
          expect(text(a.doc.state)).toBe(text(b.doc.state));
          expect(text(a.doc.state, 'clean')).toBe(text(b.doc.state, 'clean'));
          expect(text(a.doc.state, 'original')).toBe(text(b.doc.state, 'original'));
          expect(replay(a.doc.ops, noGen)).toEqual(a.doc.state);
          expect(a.doc.ops.length).toBeLessThanOrEqual(b.doc.ops.length);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('composeSplices', () => {
  /** Applies keystrokes one by one, collecting each inverse (newest first, as undo keeps them). */
  function keystrokes(initial: string, tracked: boolean, keys: [number, number, string][]) {
    const idGen = sequentialIds('n');
    let doc = createDocument({ id: 'doc', text: initial, author: 'alice', ts: 't0', idGen });
    const start = doc.state;
    let inverse: Op[] = [];
    keys.forEach(([from, to, insert], i) => {
      const r = applyOp(
        doc.state,
        {
          id: `e${i}`,
          type: 'edit',
          author: 'alice',
          ts: `t${i + 1}`,
          changeId: 'c1',
          from: absoluteToPos(doc.state, from),
          to: absoluteToPos(doc.state, to),
          insert,
          tracked,
        },
        { idGen },
      );
      doc = { ...doc, state: r.state };
      inverse = [...r.inverse, ...inverse];
    });
    return { start, end: doc.state, inverse, idGen };
  }

  it('undoes a run of typing, typos included, with one splice', () => {
    for (const tracked of [true, false]) {
      const k = keystrokes('One. Two.', tracked, [
        [5, 5, 'H'],
        [6, 6, 'x'],
        [6, 7, ''],
        [6, 6, 'i'],
        [7, 7, '. '],
      ]);
      const one = k.inverse.reduce<Op | undefined>(
        (acc, op, i) => (i === 0 ? op : acc && composeSplices(acc, op)),
        undefined,
      );
      expect(one).toBeDefined();
      const undone = applyOp(k.end, one!, { idGen: k.idGen }).state;
      expect(text(undone)).toBe('One. Two.');
      expect(markedRanges(undone)).toEqual([]);
      expect(undone.changes).toEqual(k.start.changes);
    }
  });

  it('refuses splices that do not nest', () => {
    const k = keystrokes('One. Two.', true, [
      [5, 5, 'a'],
      [0, 0, 'b'],
    ]);
    expect(composeSplices(k.inverse[0]!, k.inverse[1]!)).toBeUndefined();
  });
});

describe('exportJson', () => {
  it('writes compact JSON with one op per line that imports back unchanged', () => {
    const t = typist('One. Two.', { tracked: true });
    t.type(5, 'Hello. ');
    t.key(0, 0, 'X', 'c2');
    const json = exportJson(t.doc);
    const lines = json.trimEnd().split('\n');
    expect(lines).toHaveLength(t.doc.ops.length + 4);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(t.doc)));
    const back = importJson(json);
    expect(back.repaired).toBe(false);
    expect(back.doc.state).toEqual(t.doc.state);
  });
});
