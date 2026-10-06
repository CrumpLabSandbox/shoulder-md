/**
 * The edits library dataset: one row per change, with the sentence it changed, its
 * neighbours, the reason, any discussion, and whether it was kept. See plan.md §8.
 *
 * Context is captured at decision time by walking the op log: for each accept or reject,
 * the state just before it shows the change in place. Pending changes use the current state.
 */
import type { Block, ChangeRecord, Document, Op, Span, State } from '../model/types';
import { applyOp, emptyState } from '../model/apply';
import { absoluteToPos, posToAbsolute, spanVisible, markedRanges } from '../model/views';
import { resolveSpan } from '../model/spans';
import { displayTitle } from '../docs/title';
import { text as viewText } from '../model/views';

export const RECORD_VERSION = 1 as const;

export type Outcome = 'accepted' | 'rejected' | 'pending' | 'untracked';

export type ChangeRow = {
  v: typeof RECORD_VERSION;
  docId: string;
  docTitle: string;
  changeId: string;
  author: string;
  ts: string;
  blockKind: Block['kind'] | 'unknown';
  /** Text the change removed and added. */
  before: string;
  after: string;
  /**
   * The sentence(s) the change touched, without it and with it. Other changes that were still
   * pending appear in their original form, so the pair differs only by this change.
   */
  sentenceBefore: string;
  sentenceAfter: string;
  /** The neighbouring sentences, with pending changes in their original form. */
  contextBefore: string;
  contextAfter: string;
  reason?: string;
  reasonTags: string[];
  /** Style guide principles linked to this change, with their current text where known. */
  principles: { id: string; text?: string }[];
  /** The document's genre, by name. */
  genre?: string;
  /** Comment threads attached to this change. */
  discussion: { author: string; ts: string; body: string }[];
  outcome: Outcome;
  decidedBy?: string;
  decidedAt?: string;
};

type Capture = Pick<
  ChangeRow,
  'blockKind' | 'sentenceBefore' | 'sentenceAfter' | 'contextBefore' | 'contextAfter'
>;

const EMPTY_CAPTURE: Capture = {
  blockKind: 'unknown',
  sentenceBefore: '',
  sentenceAfter: '',
  contextBefore: '',
  contextAfter: '',
};

type SentenceRef = { blockId: string; blockKind: Block['kind']; id: string; spans: Span[] };

function sentencesOf(state: State): SentenceRef[] {
  const out: SentenceRef[] = [];
  for (const b of state.blocks)
    for (const s of b.sentences)
      out.push({ blockId: b.id, blockKind: b.kind, id: s.id, spans: s.spans });
  return out;
}

/** Ends like a sentence: a terminator, optionally followed by closing quotes, brackets, or `*`. */
const ENDS_SENTENCE = /[.!?…:]["'”’)\]*]*$/;

/**
 * A sentence's text with every other pending change in its original form (insertions dropped,
 * deletions kept), and `changeId` shown as `side`.
 */
function render(spans: Span[], changeId: string | undefined, side: 'before' | 'after'): string {
  const only = new Set(changeId ? [changeId] : []);
  let t = '';
  for (const sp of spans) {
    // Decide this change one way, then show everything else as it originally was.
    const r = changeId ? resolveSpan(sp, only, side === 'after' ? 'accept' : 'reject') : sp;
    if (r && spanVisible(r, 'original')) t += sp.text;
  }
  return t;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Context for a pending change in `state`. */
export function captureChange(state: State, changeId: string): Capture | undefined {
  const all = sentencesOf(state);
  const idx = all
    .map((s, i) =>
      s.spans.some((sp) => sp.changeId === changeId || sp.inserted?.changeId === changeId) ? i : -1,
    )
    .filter((i) => i >= 0);
  if (idx.length === 0) return undefined;
  const first = idx[0]!;
  let last = idx[idx.length - 1]!;
  // While pending, a deleted terminator still ends its sentence. If the change leaves the last
  // touched sentence without an ending on either side, the sentence runs on into the next one
  // in the same block, so include that too.
  while (last + 1 < all.length && all[last + 1]!.blockId === all[last]!.blockId) {
    const before = tidy(render(all[last]!.spans, changeId, 'before'));
    const after = tidy(render(all[last]!.spans, changeId, 'after'));
    if (ENDS_SENTENCE.test(before) && ENDS_SENTENCE.test(after)) break;
    last++;
  }
  const touched = all.slice(first, last + 1);
  return {
    blockKind: all[first]!.blockKind,
    sentenceBefore: tidy(touched.map((s) => render(s.spans, changeId, 'before')).join('')),
    sentenceAfter: tidy(touched.map((s) => render(s.spans, changeId, 'after')).join('')),
    contextBefore: first > 0 ? tidy(render(all[first - 1]!.spans, undefined, 'after')) : '',
    contextAfter:
      last + 1 < all.length ? tidy(render(all[last + 1]!.spans, undefined, 'after')) : '',
  };
}

/** The clean sentence around an absolute revision offset, with neighbours. */
function sentenceAt(
  state: State,
  offset: number,
): { blockKind: Block['kind']; text: string; prev: string; next: string } | undefined {
  if (state.blocks.length === 0) return undefined;
  const pos = absoluteToPos(state, offset);
  const all = sentencesOf(state);
  const i = all.findIndex((s) => s.id === pos.sentenceId);
  if (i < 0) return undefined;
  return {
    blockKind: all[i]!.blockKind,
    text: tidy(render(all[i]!.spans, undefined, 'after')),
    prev: i > 0 ? tidy(render(all[i - 1]!.spans, undefined, 'after')) : '',
    next: i + 1 < all.length ? tidy(render(all[i + 1]!.spans, undefined, 'after')) : '',
  };
}

export type RecordOptions = {
  includePending?: boolean; // default false
  includeUntracked?: boolean; // default false
  /** Author ids to display names. */
  authorNames?: Record<string, string>;
  /** Principle ids to their text, from the style guides. */
  principleTexts?: Record<string, string>;
  /** The document's genre name. */
  genreName?: string;
};

/** Every change in the document as a dataset row, in the order the changes were made. */
export function changeRecords(doc: Document, opts: RecordOptions = {}): ChangeRow[] {
  const decided = new Map<string, Capture>();
  const untracked = new Map<string, Capture>();
  let state = emptyState();
  for (const op of doc.ops) {
    if (op.type === 'accept' || op.type === 'reject') {
      for (const id of op.changeIds) {
        const c = captureChange(state, id);
        if (c) decided.set(id, c);
      }
    }
    const pre = state;
    state = applyOp(state, op).state;
    if (op.type === 'edit' && !op.tracked && opts.includeUntracked)
      captureUntracked(untracked, pre, state, op);
  }

  const name = (id: string | undefined) => (id ? (opts.authorNames?.[id] ?? id) : undefined);
  const final = doc.state;
  const title = displayTitle(final.meta.title, viewText(final, 'clean'));
  const rows: ChangeRow[] = [];
  const live = new Set(markedRanges(final).map((r) => r.changeId));
  const records = Object.values(final.changes).sort((a, b) =>
    a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
  );
  for (const rec of records) {
    const outcome: Outcome = !rec.tracked ? 'untracked' : rec.status;
    if (outcome === 'pending' && !opts.includePending) continue;
    if (outcome === 'pending' && !live.has(rec.id)) continue; // no marks left: nothing to review
    if (outcome === 'untracked' && !opts.includeUntracked) continue;
    const capture =
      (outcome === 'pending'
        ? captureChange(final, rec.id)
        : outcome === 'untracked'
          ? untracked.get(rec.id)
          : decided.get(rec.id)) ?? EMPTY_CAPTURE;
    const { before, after } = textsOf(rec, final);
    rows.push({
      v: RECORD_VERSION,
      docId: doc.id,
      docTitle: title,
      changeId: rec.id,
      author: name(rec.author)!,
      ts: rec.ts,
      ...capture,
      before,
      after,
      ...(rec.reason ? { reason: rec.reason } : {}),
      reasonTags: rec.reasonTags ?? [],
      principles: (rec.principles ?? []).map((id) => {
        const text = opts.principleTexts?.[id];
        return text !== undefined ? { id, text } : { id };
      }),
      ...(opts.genreName ? { genre: opts.genreName } : {}),
      discussion: final.comments
        .filter((t) => t.changeId === rec.id)
        .flatMap((t) =>
          t.comments.map((c) => ({ author: name(c.author)!, ts: c.ts, body: c.body })),
        ),
      outcome,
      ...(outcome !== 'pending' && rec.decidedBy ? { decidedBy: name(rec.decidedBy)! } : {}),
      ...(outcome !== 'pending' && rec.decidedAt ? { decidedAt: rec.decidedAt } : {}),
    });
  }
  return rows;
}

function textsOf(rec: ChangeRecord, state: State): { before: string; after: string } {
  if (rec.status !== 'pending') return { before: rec.before ?? '', after: rec.after ?? '' };
  let before = '';
  let after = '';
  for (const b of state.blocks)
    for (const s of b.sentences)
      for (const sp of s.spans) {
        if (sp.inserted?.changeId === rec.id) after += sp.text;
        if (sp.changeId !== rec.id) continue;
        if (sp.kind === 'del') before += sp.text;
        if (sp.kind === 'ins') after += sp.text;
      }
  return { before, after };
}

function captureUntracked(
  map: Map<string, Capture>,
  pre: State,
  post: State,
  op: Extract<Op, { type: 'edit' }>,
) {
  let from: number;
  try {
    from = posToAbsolute(pre, op.from);
  } catch {
    return;
  }
  const was = sentenceAt(pre, from);
  const now = sentenceAt(post, from + op.insert.length);
  const prev = map.get(op.changeId);
  map.set(op.changeId, {
    blockKind: prev?.blockKind ?? was?.blockKind ?? 'unknown',
    sentenceBefore: prev?.sentenceBefore ?? was?.text ?? '',
    sentenceAfter: now?.text ?? '',
    contextBefore: prev?.contextBefore ?? was?.prev ?? '',
    contextAfter: now?.next ?? '',
  });
}

export function toJsonl(rows: readonly ChangeRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}
