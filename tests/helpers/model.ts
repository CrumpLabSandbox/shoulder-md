import { applyOp, createDocument, emptyState } from '../../src/model/apply';
import { sequentialIds, type IdGen } from '../../src/model/ids';
import { absoluteToPos, text } from '../../src/model/views';
import type { Document, Op, State } from '../../src/model/types';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Harness = {
  doc: Document;
  idGen: IdGen;
  /** Apply a text edit at absolute revision offsets. Returns the completed op. */
  edit(
    from: number,
    to: number,
    insert: string,
    o?: { tracked?: boolean; changeId?: string; author?: string },
  ): Op;
  accept(...changeIds: string[]): Op;
  reject(...changeIds: string[]): Op;
  op(op: DistributiveOmit<Op, 'id' | 'ts' | 'author'> & { author?: string }): Op;
  /** Inverse of the last applied op. */
  readonly inverse: Op[];
  /** Applies ops in order (e.g. an inverse) and returns the combined inverse of that application. */
  applyOps(ops: Op[]): Op[];
  readonly state: State;
  rev(): string;
  clean(): string;
  original(): string;
  ids(): string[];
  sentences(): string[];
};

export function harness(initial: string, opts: { tracking?: boolean } = {}): Harness {
  const idGen = sequentialIds('n');
  let lastInverse: Op[] = [];
  let doc = createDocument({
    id: 'doc',
    text: initial,
    author: 'alice',
    ts: '2026-01-01T00:00:00Z',
    idGen,
  });
  if (opts.tracking === false) {
    doc = push(
      doc,
      { id: idGen(), type: 'set_tracking', on: false, author: 'alice', ts: doc.updatedAt },
      idGen,
    );
  }
  let n = 0;
  const ts = () => `2026-01-01T00:00:${String(++n).padStart(2, '0')}Z`;

  function push(d: Document, op: Op, gen: IdGen): Document {
    const applied = applyOp(d.state, op, { idGen: gen });
    lastInverse = applied.inverse;
    return { ...d, ops: [...d.ops, applied.op], state: applied.state };
  }

  const h: Harness = {
    get doc() {
      return doc;
    },
    idGen,
    get state() {
      return doc.state;
    },
    edit(from, to, insert, o = {}) {
      const tracked = o.tracked ?? doc.state.trackingOn;
      const op: Op = {
        id: idGen(),
        type: 'edit',
        author: o.author ?? 'alice',
        ts: ts(),
        changeId: o.changeId ?? `c${doc.ops.length}`,
        from: absoluteToPos(doc.state, from),
        to: absoluteToPos(doc.state, to),
        insert,
        tracked,
      };
      doc = push(doc, op, idGen);
      return doc.ops[doc.ops.length - 1]!;
    },
    accept(...changeIds) {
      const op: Op = { id: idGen(), type: 'accept', author: 'bob', ts: ts(), changeIds };
      doc = push(doc, op, idGen);
      return doc.ops[doc.ops.length - 1]!;
    },
    reject(...changeIds) {
      const op: Op = { id: idGen(), type: 'reject', author: 'bob', ts: ts(), changeIds };
      doc = push(doc, op, idGen);
      return doc.ops[doc.ops.length - 1]!;
    },
    op(partial) {
      const op = { id: idGen(), ts: ts(), author: 'alice', ...partial } as Op;
      doc = push(doc, op, idGen);
      return doc.ops[doc.ops.length - 1]!;
    },
    get inverse() {
      return lastInverse;
    },
    applyOps(ops) {
      const inverses: Op[][] = [];
      for (const op of ops) {
        doc = push(doc, op, idGen);
        inverses.push(lastInverse);
      }
      // Undoing a sequence applies each inverse in reverse order.
      return inverses.reverse().flat();
    },
    rev: () => text(doc.state, 'revision'),
    clean: () => text(doc.state, 'clean'),
    original: () => text(doc.state, 'original'),
    ids: () => doc.state.blocks.flatMap((b) => b.sentences.map((s) => s.id)),
    sentences: () =>
      doc.state.blocks.flatMap((b) =>
        b.sentences.map((s) => s.spans.map((sp) => sp.text).join('')),
      ),
  };
  return h;
}

export { emptyState };
