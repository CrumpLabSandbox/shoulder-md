/**
 * Applies ops to state. `applyOp` is deterministic given the op; fresh ids it needs are
 * recorded on the op (`alloc`) so a replay reproduces the same state, ids included.
 */
import type {
  Alloc,
  ChangeRecord,
  CommentAnchor,
  CommentThread,
  Document,
  Effect,
  Op,
  State,
} from './types';
import { SCHEMA_VERSION } from './types';
import { makeAllocator } from './reconcile';
import { reconcile } from './reconcile';
import {
  editSpansMapped,
  flatten,
  changeIdsOf,
  rangeSpans,
  resolveSpan,
  resolveSpans,
  spliceSpans,
  textOf,
  type OffsetMap,
  type Tagged,
} from './spans';
import { absoluteToPos, locate, posToAbsolute, sentenceText } from './views';
import { ulid, type IdGen } from './ids';

export class ModelError extends Error {}

export type ApplyContext = { idGen?: IdGen };

export function emptyState(): State {
  return {
    blocks: [],
    changes: {},
    comments: [],
    trackingOn: true,
    meta: { title: '', tags: [], status: 'draft', libraryEligible: false },
  };
}

/**
 * `inverse` undoes the op when applied in order to the resulting state. Present for every
 * text-affecting op; empty for ops that need no undo (import) or are their own concern.
 */
export type Applied = { state: State; op: Op; inverse: Op[] };

type SpliceOp = Extract<Op, { type: 'splice' }>;

function inverseSplice(
  base: { author: string; ts: string },
  from: number,
  to: number,
  spans: Tagged[],
  records?: Record<string, ChangeRecord | null>,
): SpliceOp {
  const op: SpliceOp = {
    id: `${base.ts}:undo:${from}`,
    type: 'splice',
    author: base.author,
    ts: base.ts,
    from,
    to,
    spans,
  };
  if (records) op.records = records;
  return op;
}

export function applyOp(state: State, op: Op, ctx: ApplyContext = {}): Applied {
  const idGen = ctx.idGen ?? ulid;
  switch (op.type) {
    case 'import': {
      const alloc = makeAllocator(idGen, op.alloc);
      const flat: Tagged[] = op.text
        ? [{ kind: 'text', text: op.text, sentenceId: '', blockId: '' }]
        : [];
      const { blocks, effects } = reconcile(flat, alloc);
      const next = {
        ...state,
        blocks,
        comments: state.comments.map((t) => ({ ...t, anchor: null })),
      };
      return { state: next, op: withAlloc(op, alloc.used, effects), inverse: [] };
    }

    case 'edit': {
      requireNonEmpty(state);
      const alloc = makeAllocator(idGen, op.alloc);
      const flat = flatten(state.blocks);
      const from = posToAbsolute(state, op.from);
      const to = posToAbsolute(state, op.to);
      if (to < from) throw new ModelError('edit: to before from');
      const edit = editSpansMapped(flat, from, to, op.insert, {
        changeId: op.changeId,
        author: op.author,
        tracked: op.tracked,
      });
      const anchors = captureAnchors(state);
      const oldSpans = rangeSpans(flat, from, to);
      const newLen = textOf(edit.spans).length - textOf(flat).length + (to - from);
      const { blocks, effects } = reconcile(edit.spans, alloc);
      const next: State = { ...state, blocks, changes: { ...state.changes } };
      const existing = next.changes[op.changeId];
      const inverse = [
        inverseSplice(op, from, from + newLen, oldSpans, { [op.changeId]: existing ?? null }),
      ];
      if (op.tracked) {
        next.changes[op.changeId] = existing ?? {
          id: op.changeId,
          author: op.author,
          ts: op.ts,
          tracked: true,
          status: 'pending',
        };
      } else {
        next.changes[op.changeId] = {
          ...(existing ?? { id: op.changeId, author: op.author, ts: op.ts }),
          tracked: false,
          status: 'accepted',
          decidedBy: op.author,
          decidedAt: op.ts,
          before: (existing?.before ?? '') + edit.deleted,
          after: (existing?.after ?? '') + op.insert,
        };
      }
      next.comments = restoreAnchors(next, anchors, edit.map);
      return { state: next, op: withAlloc(op, alloc.used, effects), inverse };
    }

    case 'accept':
    case 'reject': {
      requireNonEmpty(state);
      const alloc = makeAllocator(idGen, op.alloc);
      const ids = new Set(op.changeIds);
      const flat = flatten(state.blocks);
      const before = new Map<string, string>();
      const after = new Map<string, string>();
      for (const s of flat) {
        if (s.kind === 'text') continue;
        // A deletion removed this text; a deleted insertion also counts as its inserter's text.
        if (s.changeId && ids.has(s.changeId)) {
          const m = s.kind === 'del' ? before : after;
          m.set(s.changeId, (m.get(s.changeId) ?? '') + s.text);
        }
        if (s.inserted && ids.has(s.inserted.changeId)) {
          after.set(s.inserted.changeId, (after.get(s.inserted.changeId) ?? '') + s.text);
        }
      }
      const anchors = captureAnchors(state);
      // Inverse: restore each run of affected spans, later runs first so earlier offsets hold.
      const runs: { newFrom: number; newLen: number; spans: Tagged[] }[] = [];
      {
        let newPos = 0;
        let run: (typeof runs)[number] | undefined;
        for (const s of flat) {
          const affected = changeIdsOf(s).some((id) => ids.has(id));
          const len = s.text.length;
          if (affected) {
            const vanish = resolveSpan(s, ids, op.type) === null;
            if (!run) runs.push((run = { newFrom: newPos, newLen: 0, spans: [] }));
            run.spans.push(s);
            if (!vanish) {
              run.newLen += len;
              newPos += len;
            }
          } else {
            run = undefined;
            newPos += len;
          }
        }
      }
      const prevRecords: Record<string, ChangeRecord | null> = {};
      for (const id of ids) prevRecords[id] = state.changes[id] ?? null;
      const inverse: Op[] = runs
        .slice()
        .reverse()
        .map((r, i, arr) =>
          inverseSplice(
            op,
            r.newFrom,
            r.newFrom + r.newLen,
            r.spans,
            i === arr.length - 1 ? prevRecords : undefined,
          ),
        );
      if (runs.length === 0) inverse.push(inverseSplice(op, 0, 0, [], prevRecords));
      const resolved = resolveSpans(flat, ids, op.type);
      const { blocks, effects } = reconcile(resolved.spans, alloc);
      const next: State = { ...state, blocks, changes: { ...state.changes } };
      for (const id of ids) {
        const rec = next.changes[id];
        if (!rec) continue;
        next.changes[id] = {
          ...rec,
          status: op.type === 'accept' ? 'accepted' : 'rejected',
          decidedBy: op.author,
          decidedAt: op.ts,
          before: before.get(id) ?? '',
          after: after.get(id) ?? '',
        };
      }
      next.comments = restoreAnchors(next, anchors, resolved.map);
      return { state: next, op: withAlloc(op, alloc.used, effects), inverse };
    }

    case 'splice': {
      requireNonEmpty(state);
      const alloc = makeAllocator(idGen, op.alloc);
      const flat = flatten(state.blocks);
      const total = textOf(flat).length;
      if (op.from < 0 || op.to < op.from || op.to > total)
        throw new ModelError('splice: range out of bounds');
      const anchors = captureAnchors(state);
      const spliced = spliceSpans(flat, op.from, op.to, op.spans);
      const newLen = op.spans.reduce((n, r) => n + r.text.length, 0);
      const { blocks, effects } = reconcile(spliced.spans, alloc);
      const next: State = { ...state, blocks, changes: { ...state.changes } };
      const prevRecords: Record<string, ChangeRecord | null> = {};
      if (op.records) {
        for (const [id, rec] of Object.entries(op.records)) {
          prevRecords[id] = state.changes[id] ?? null;
          if (rec === null) delete next.changes[id];
          else next.changes[id] = rec;
        }
      }
      next.comments = restoreAnchors(next, anchors, spliced.map);
      const inverse = [
        inverseSplice(
          op,
          op.from,
          op.from + newLen,
          spliced.removed,
          op.records ? prevRecords : undefined,
        ),
      ];
      return { state: next, op: withAlloc(op, alloc.used, effects), inverse };
    }

    case 'set_reason': {
      const rec = state.changes[op.changeId];
      if (!rec) throw new ModelError(`set_reason: unknown change ${op.changeId}`);
      const changes = { ...state.changes, [op.changeId]: { ...rec } };
      if (op.reason === undefined) delete changes[op.changeId]!.reason;
      else changes[op.changeId]!.reason = op.reason;
      if (op.reasonTags === undefined) delete changes[op.changeId]!.reasonTags;
      else changes[op.changeId]!.reasonTags = op.reasonTags;
      return { state: { ...state, changes }, op, inverse: [] };
    }

    case 'comment_add': {
      const thread: CommentThread = {
        id: op.threadId,
        anchor: validAnchor(state, op.anchor) ? op.anchor : null,
        resolved: false,
        comments: [{ id: op.commentId, author: op.author, ts: op.ts, body: op.body }],
      };
      if (op.changeId) thread.changeId = op.changeId;
      return { state: { ...state, comments: [...state.comments, thread] }, op, inverse: [] };
    }

    case 'comment_reply':
      return {
        state: updateThread(state, op.threadId, (t) => ({
          ...t,
          comments: [
            ...t.comments,
            { id: op.commentId, author: op.author, ts: op.ts, body: op.body },
          ],
        })),
        op,
        inverse: [],
      };

    case 'comment_edit':
      return {
        state: updateThread(state, op.threadId, (t) => ({
          ...t,
          comments: t.comments.map((c) => (c.id === op.commentId ? { ...c, body: op.body } : c)),
        })),
        op,
        inverse: [],
      };

    case 'comment_resolve':
      return {
        state: updateThread(state, op.threadId, (t) => ({ ...t, resolved: op.resolved })),
        op,
        inverse: [],
      };

    case 'set_tracking':
      return { state: { ...state, trackingOn: op.on }, op, inverse: [] };

    case 'set_meta':
      return { state: { ...state, meta: { ...state.meta, ...op.patch } }, op, inverse: [] };
  }
}

type StructuralOp = Extract<Op, { type: 'import' | 'edit' | 'accept' | 'reject' | 'splice' }>;

function withAlloc(op: StructuralOp, alloc: Alloc, effects: Effect[]): Op {
  return { ...op, alloc, effects };
}

function requireNonEmpty(state: State) {
  if (state.blocks.length === 0) throw new ModelError('Document has no blocks; import first');
}

function updateThread(state: State, id: string, f: (t: CommentThread) => CommentThread): State {
  if (!state.comments.some((t) => t.id === id)) throw new ModelError(`unknown thread ${id}`);
  return { ...state, comments: state.comments.map((t) => (t.id === id ? f(t) : t)) };
}

function validAnchor(state: State, a: CommentAnchor): boolean {
  const ids = new Set(locate(state).map((l) => l.sentenceId));
  return a.sentenceIds.length > 0 && a.sentenceIds.every((id) => ids.has(id));
}

type CapturedAnchor = { threadId: string; from: number; to: number; blockId: string | undefined };

/** Absolute revision ranges of every live anchor, before a text-affecting op. */
function captureAnchors(state: State): CapturedAnchor[] {
  const locs = locate(state);
  const byId = new Map(locs.map((l) => [l.sentenceId, l]));
  const out: CapturedAnchor[] = [];
  for (const t of state.comments) {
    if (!t.anchor) continue;
    const first = byId.get(t.anchor.sentenceIds[0]!);
    const last = byId.get(t.anchor.sentenceIds[t.anchor.sentenceIds.length - 1]!);
    if (!first || !last) continue;
    out.push({
      threadId: t.id,
      from: first.from + t.anchor.from,
      to: last.from + t.anchor.to,
      blockId: first.blockId,
    });
  }
  return out;
}

/**
 * Re-anchors threads after the op, orphaning any whose text vanished entirely. An orphaned
 * thread remembers its last anchor and takes it back when those sentences exist again.
 */
function restoreAnchors(next: State, captured: CapturedAnchor[], map: OffsetMap): CommentThread[] {
  const byThread = new Map(captured.map((c) => [c.threadId, c]));
  const locs = locate(next);
  const locById = new Map(locs.map((l) => [l.sentenceId, l]));
  const blockIds = new Set(next.blocks.map((b) => b.id));
  return next.comments.map((t) => {
    const c = byThread.get(t.id);
    if (!c) {
      if (t.anchor || !t.orphanedFrom) return t;
      const o = t.orphanedFrom;
      const first = locById.get(o.sentenceIds[0]!);
      const last = locById.get(o.sentenceIds[o.sentenceIds.length - 1]!);
      if (!first || !last || !o.sentenceIds.every((id) => locById.has(id))) return t;
      const from = Math.min(o.from, first.to - first.from);
      const to = Math.min(o.to, last.to - last.from);
      if (first.from + from >= last.from + to) return t;
      const { blockId: _b, orphanedFrom: _o, ...rest } = t;
      void _b;
      void _o;
      return { ...rest, anchor: { sentenceIds: o.sentenceIds, from, to } };
    }
    const from = map.map(c.from, 1);
    const to = Math.max(from, map.map(c.to, -1));
    const hadText = c.to > c.from;
    if (hadText && to === from) {
      const at = absoluteToPos(next, from);
      const block = locs.find((l) => l.sentenceId === at.sentenceId)?.blockId;
      const fallback = c.blockId && blockIds.has(c.blockId) ? c.blockId : block;
      return {
        ...t,
        anchor: null,
        ...(fallback ? { blockId: fallback } : {}),
        ...(t.anchor ? { orphanedFrom: t.anchor } : {}),
      };
    }
    const start = absoluteToPos(next, from);
    const end = absoluteToPos(next, to);
    const ids: string[] = [];
    let collecting = false;
    for (const l of locs) {
      if (l.sentenceId === start.sentenceId) collecting = true;
      if (collecting) ids.push(l.sentenceId);
      if (l.sentenceId === end.sentenceId) break;
    }
    const { blockId: _b, ...rest } = t;
    void _b;
    return { ...rest, anchor: { sentenceIds: ids, from: start.offset, to: end.offset } };
  });
}

/* ---------- replay and documents ---------- */

export function replay(ops: readonly Op[], ctx: ApplyContext = {}): State {
  let state = emptyState();
  for (const op of ops) state = applyOp(state, op, ctx).state;
  return state;
}

export type CreateOptions = {
  id?: string;
  text?: string;
  author: string;
  ts?: string;
  /** Explicit title; empty means derive it from the text. */
  title?: string;
  /** Tracked changes on from the start (default true). */
  tracking?: boolean;
  /** Include in the edits library (default false). */
  libraryEligible?: boolean;
  idGen?: IdGen;
};

export function createDocument(opts: CreateOptions): Document {
  const idGen = opts.idGen ?? ulid;
  const ts = opts.ts ?? new Date().toISOString();
  const importOp: Op = {
    id: idGen(),
    type: 'import',
    author: opts.author,
    ts,
    text: opts.text ?? '',
  };
  const applied = applyOp(emptyState(), importOp, { idGen });
  const ops: Op[] = [applied.op];
  let state = applied.state;
  if (opts.title || opts.libraryEligible) {
    const metaOp: Op = {
      id: idGen(),
      type: 'set_meta',
      author: opts.author,
      ts,
      patch: {
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.libraryEligible ? { libraryEligible: true } : {}),
      },
    };
    state = applyOp(state, metaOp, { idGen }).state;
    ops.push(metaOp);
  }
  if (opts.tracking === false) {
    const trackOp: Op = { id: idGen(), type: 'set_tracking', author: opts.author, ts, on: false };
    state = applyOp(state, trackOp, { idGen }).state;
    ops.push(trackOp);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: opts.id ?? idGen(),
    createdAt: ts,
    updatedAt: ts,
    authors: [],
    ops,
    state,
  };
}

/** Appends an op to a document, applying it. Returns the new document (immutable update). */
export function appendOp(
  doc: Document,
  op: Op,
  ctx: ApplyContext = {},
): { doc: Document; op: Op; inverse: Op[] } {
  const applied = applyOp(doc.state, op, ctx);
  return {
    doc: { ...doc, ops: [...doc.ops, applied.op], state: applied.state, updatedAt: op.ts },
    op: applied.op,
    inverse: applied.inverse,
  };
}

/** Convenience for tests and adapters: the current revision text. */
export function revisionText(state: State): string {
  return textOf(flatten(state.blocks));
}

export { sentenceText };
