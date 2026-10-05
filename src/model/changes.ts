/** Derived views of tracked changes for the margin and the dataset. */
import type { ChangeRecord, State } from './types';
import { markedRanges, type MarkedRange } from './views';

export type PendingChange = {
  id: string;
  record: ChangeRecord;
  author: string;
  /** Deleted text (all del spans) and inserted text (all ins spans), in order. */
  before: string;
  after: string;
  ranges: MarkedRange[];
  sentenceIds: string[];
  /** Absolute revision offset of the first marked span; for ordering and scrolling. */
  from: number;
};

/** Pending changes in document order, grouped by change id. */
export function pendingChanges(state: State): PendingChange[] {
  const groups = new Map<string, PendingChange>();
  for (const r of markedRanges(state)) {
    let g = groups.get(r.changeId);
    if (!g) {
      const record = state.changes[r.changeId] ?? {
        id: r.changeId,
        author: r.author,
        ts: '',
        tracked: true,
        status: 'pending',
      };
      g = {
        id: r.changeId,
        record,
        author: r.author,
        before: '',
        after: '',
        ranges: [],
        sentenceIds: [],
        from: r.from,
      };
      groups.set(r.changeId, g);
    }
    g.ranges.push(r);
    if (r.kind === 'del') g.before += textAt(state, r);
    else g.after += textAt(state, r);
    if (!g.sentenceIds.includes(r.sentenceId)) g.sentenceIds.push(r.sentenceId);
  }
  return [...groups.values()].sort((a, b) => a.from - b.from);
}

function textAt(state: State, r: MarkedRange): string {
  // Spans are contiguous in document order; re-reading by offset keeps this simple.
  let pos = 0;
  for (const b of state.blocks)
    for (const s of b.sentences)
      for (const sp of s.spans) {
        if (pos === r.from) return sp.text;
        pos += sp.text.length;
      }
  return '';
}

/**
 * Keystroke coalescing policy: a new edit joins the previous change when the same author
 * continues typing where they left off, within `windowMs`. The adapter keeps the last edit's
 * end position and time and asks this before choosing a changeId.
 */
export type LastEdit = {
  changeId: string;
  author: string;
  endOffset: number;
  at: number;
  tracked: boolean;
};

export function shouldCoalesce(
  last: LastEdit | undefined,
  next: { author: string; from: number; to: number; at: number; tracked: boolean },
  windowMs = 5000,
): boolean {
  if (!last) return false;
  if (last.author !== next.author || last.tracked !== next.tracked) return false;
  if (next.at - last.at > windowMs) return false;
  // Typing forward from the last end, or backspacing into it.
  return next.from === last.endOffset || next.to === last.endOffset;
}
