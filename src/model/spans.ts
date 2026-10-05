/**
 * Flat span sequences. The reconciler works on the whole document as one list of spans,
 * each tagged with the sentence and block it came from, then re-derives the structure.
 */
import type { Span, Block, Sentence } from './types';

export type Tagged = Span & { sentenceId: string; blockId: string };

export function flatten(blocks: Block[]): Tagged[] {
  const out: Tagged[] = [];
  for (const b of blocks)
    for (const s of b.sentences)
      for (const sp of s.spans) out.push({ ...sp, sentenceId: s.id, blockId: b.id });
  return out;
}

export function textOf(spans: readonly Span[]): string {
  let t = '';
  for (const s of spans) t += s.text;
  return t;
}

export function sameMark(a: Span, b: Span): boolean {
  return a.kind === b.kind && a.changeId === b.changeId && a.author === b.author;
}

/** Drops empty spans and merges adjacent spans with the same mark and origin. */
export function normalize<T extends Span & { sentenceId?: string; blockId?: string }>(
  spans: T[],
): T[] {
  const out: T[] = [];
  for (const s of spans) {
    if (s.text.length === 0) continue;
    const last = out[out.length - 1];
    if (
      last &&
      sameMark(last, s) &&
      last.sentenceId === s.sentenceId &&
      last.blockId === s.blockId
    ) {
      out[out.length - 1] = { ...last, text: last.text + s.text };
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Splits the sequence so that a span boundary exists at absolute offset `at`. */
export function splitAt<T extends Span>(spans: T[], at: number): T[] {
  const out: T[] = [];
  let pos = 0;
  for (const s of spans) {
    const end = pos + s.text.length;
    if (at > pos && at < end) {
      out.push({ ...s, text: s.text.slice(0, at - pos) }, { ...s, text: s.text.slice(at - pos) });
    } else {
      out.push(s);
    }
    pos = end;
  }
  return out;
}

export type EditMark = { changeId: string; author: string; tracked: boolean };

export type EditResult<T> = { spans: T[]; deleted: string; removedOutright: string };

/**
 * Applies a text edit at absolute revision offsets [from, to) with `insert`.
 * Tracked: plain text in the range becomes a 'del' span; the editing author's own pending
 * insertions in the range vanish outright (Word behavior); other authors' insertions become
 * deletions. Pending deletions already in the range are left as they are. The insertion
 * becomes an 'ins' span. Untracked: the range is removed and the insertion is plain text.
 */
export function editSpans<T extends Span & { sentenceId: string; blockId: string }>(
  spans: T[],
  from: number,
  to: number,
  insert: string,
  mark: EditMark,
): EditResult<T> {
  let seq = splitAt(splitAt(spans, from), to);
  const out: T[] = [];
  let pos = 0;
  let deleted = '';
  let removedOutright = '';
  let inserted = false;

  const pushInsert = () => {
    if (inserted) return;
    inserted = true;
    if (insert.length === 0) return;
    // Inserted text carries no origin: only characters that existed before the edit vote on
    // which old sentence or block a new one continues.
    const tag = { sentenceId: '', blockId: '' };
    const span = mark.tracked
      ? ({ kind: 'ins', text: insert, changeId: mark.changeId, author: mark.author, ...tag } as T)
      : ({ kind: 'text', text: insert, ...tag } as T);
    out.push(span);
  };

  for (const s of seq) {
    const end = pos + s.text.length;
    if (pos >= from && !inserted) pushInsert();
    if (pos >= from && end <= to && s.text.length > 0) {
      // Inside the edited range.
      if (!mark.tracked) {
        if (s.kind !== 'del') deleted += s.text;
        removedOutright += s.text;
      } else if (s.kind === 'del') {
        out.push(s);
      } else if (s.kind === 'ins' && s.author === mark.author && s.changeId === mark.changeId) {
        removedOutright += s.text;
      } else if (s.kind === 'ins' && s.author === mark.author) {
        // Own earlier insertion from another change: also removed outright.
        removedOutright += s.text;
      } else {
        deleted += s.text;
        out.push({ ...s, kind: 'del', changeId: mark.changeId, author: mark.author });
      }
    } else {
      out.push(s);
    }
    pos = end;
  }
  if (!inserted) pushInsert();
  seq = normalize(out);
  return { spans: seq, deleted, removedOutright };
}

/** Rebuilds blocks → sentences → spans from a flat tagged list and boundary positions. */
export function regroup(
  flat: Tagged[],
  blockEnds: number[],
  sentenceEnds: number[][], // per block, absolute ends
): { blockSpans: Tagged[][][] } {
  const cuts = new Set<number>();
  for (const e of blockEnds) cuts.add(e);
  for (const ends of sentenceEnds) for (const e of ends) cuts.add(e);
  let seq = flat;
  for (const c of cuts) seq = splitAt(seq, c);
  const blockSpans: Tagged[][][] = [];
  let i = 0;
  let pos = 0;
  for (let b = 0; b < blockEnds.length; b++) {
    const sentencesOfBlock: Tagged[][] = [];
    for (const sEnd of sentenceEnds[b]!) {
      const spans: Tagged[] = [];
      while (i < seq.length && pos < sEnd) {
        spans.push(seq[i]!);
        pos += seq[i]!.text.length;
        i++;
      }
      sentencesOfBlock.push(spans);
    }
    blockSpans.push(sentencesOfBlock);
  }
  return { blockSpans };
}

export function toSentence(id: string, spans: Tagged[]): Sentence {
  return {
    id,
    spans: normalize(
      spans.map(({ kind, text, changeId, author }) =>
        stripUndefined({ kind, text, changeId, author }),
      ),
    ),
  };
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/* ---------- offset mapping through a text-affecting operation ---------- */

/** A run of the old text and what it became: identical (same length), removed, or replaced. */
export type MapSegment = { oldLen: number; newLen: number; identity: boolean };

/** Maps old absolute offsets to new ones, given the segments of the change in order. */
export class OffsetMap {
  constructor(private readonly segments: MapSegment[]) {}

  /**
   * `assoc` decides where an offset sitting exactly on an insertion goes: -1 stays before the
   * inserted text, 1 moves after it. Offsets inside a removed run collapse to its start.
   */
  map(pos: number, assoc: -1 | 1 = -1): number {
    let oldPos = 0;
    let newPos = 0;
    for (const seg of this.segments) {
      if (seg.oldLen === 0) {
        // Pure insertion at oldPos.
        if (pos === oldPos && assoc === -1) return newPos;
        newPos += seg.newLen;
        continue;
      }
      const oldEnd = oldPos + seg.oldLen;
      if (pos < oldEnd) return seg.identity ? newPos + (pos - oldPos) : newPos;
      oldPos = oldEnd;
      newPos += seg.newLen;
    }
    return newPos + Math.max(0, pos - oldPos);
  }

  static identity(len: number): OffsetMap {
    return new OffsetMap([{ oldLen: len, newLen: len, identity: true }]);
  }
}

export type MappedEdit<T> = EditResult<T> & { map: OffsetMap };

/** `editSpans` plus the offset map of what it did. */
export function editSpansMapped<T extends Span & { sentenceId: string; blockId: string }>(
  spans: T[],
  from: number,
  to: number,
  insert: string,
  mark: EditMark,
): MappedEdit<T> {
  // Build the map by simulating the same decisions editSpans makes inside the range.
  const seq = splitAt(splitAt(spans, from), to);
  const segments: MapSegment[] = [{ oldLen: from, newLen: from, identity: true }];
  segments.push({ oldLen: 0, newLen: insert.length, identity: false });
  let pos = 0;
  for (const s of seq) {
    const end = pos + s.text.length;
    if (pos >= from && end <= to && s.text.length > 0) {
      const kept =
        mark.tracked && (s.kind === 'del' || !(s.kind === 'ins' && s.author === mark.author));
      segments.push({ oldLen: s.text.length, newLen: kept ? s.text.length : 0, identity: kept });
    }
    pos = end;
  }
  const total = textOf(spans).length;
  segments.push({ oldLen: total - to, newLen: total - to, identity: true });
  const result = editSpans(spans, from, to, insert, mark);
  return { ...result, map: new OffsetMap(segments) };
}

/**
 * Resolves pending spans of the given changes. Accept: deletions vanish, insertions become
 * text. Reject: insertions vanish, deletions become text. Returns the new spans and the map.
 */
export function resolveSpans<T extends Span & { sentenceId: string; blockId: string }>(
  spans: T[],
  changeIds: ReadonlySet<string>,
  decision: 'accept' | 'reject',
): { spans: T[]; map: OffsetMap } {
  const out: T[] = [];
  const segments: MapSegment[] = [];
  for (const s of spans) {
    const len = s.text.length;
    if (s.kind !== 'text' && s.changeId && changeIds.has(s.changeId)) {
      const vanish = decision === 'accept' ? s.kind === 'del' : s.kind === 'ins';
      if (vanish) {
        segments.push({ oldLen: len, newLen: 0, identity: false });
        continue;
      }
      const { changeId: _c, author: _a, ...rest } = s;
      void _c;
      void _a;
      out.push({ ...rest, kind: 'text' } as T);
      segments.push({ oldLen: len, newLen: len, identity: true });
    } else {
      out.push(s);
      segments.push({ oldLen: len, newLen: len, identity: true });
    }
  }
  return { spans: normalize(out), map: new OffsetMap(segments) };
}

/* ---------- raw splices (undo/redo) ---------- */

export type HintedSpan = Span & { sentenceId?: string; blockId?: string };

/** Copies of the spans inside [from, to), with their origin tags. */
export function rangeSpans<T extends Span & { sentenceId: string; blockId: string }>(
  spans: T[],
  from: number,
  to: number,
): Tagged[] {
  const seq = splitAt(splitAt(spans, from), to);
  const out: Tagged[] = [];
  let pos = 0;
  for (const s of seq) {
    const end = pos + s.text.length;
    if (pos >= from && end <= to && s.text.length > 0) {
      out.push({
        kind: s.kind,
        text: s.text,
        ...(s.changeId !== undefined ? { changeId: s.changeId } : {}),
        ...(s.author !== undefined ? { author: s.author } : {}),
        sentenceId: s.sentenceId,
        blockId: s.blockId,
      });
    }
    pos = end;
  }
  return out;
}

/** Replaces [from, to) with `replacement` verbatim. Returns the removed spans and the map. */
export function spliceSpans(
  spans: Tagged[],
  from: number,
  to: number,
  replacement: HintedSpan[],
): { spans: Tagged[]; removed: Tagged[]; map: OffsetMap } {
  const seq = splitAt(splitAt(spans, from), to);
  const out: Tagged[] = [];
  const removed: Tagged[] = [];
  let pos = 0;
  let inserted = false;
  const insert = () => {
    if (inserted) return;
    inserted = true;
    for (const r of replacement) {
      if (r.text.length === 0) continue;
      out.push({
        kind: r.kind,
        text: r.text,
        ...(r.changeId !== undefined ? { changeId: r.changeId } : {}),
        ...(r.author !== undefined ? { author: r.author } : {}),
        sentenceId: r.sentenceId ?? '',
        blockId: r.blockId ?? '',
      });
    }
  };
  for (const s of seq) {
    const end = pos + s.text.length;
    if (pos >= from && !inserted) insert();
    if (pos >= from && end <= to && s.text.length > 0) removed.push(s);
    else out.push(s);
    pos = end;
  }
  if (!inserted) insert();
  const total = textOf(spans).length;
  const newLen = replacement.reduce((n, r) => n + r.text.length, 0);
  const map = new OffsetMap([
    { oldLen: from, newLen: from, identity: true },
    { oldLen: to - from, newLen, identity: false },
    { oldLen: total - to, newLen: total - to, identity: true },
  ]);
  return { spans: normalize(out), removed, map };
}

/**
 * What a tracked deletion of [from, to) by `author` leaves in the buffer: pending deletions
 * and other authors' insertions stay (struck through); the author's own insertions vanish.
 */
export function keptText(spans: readonly Span[], from: number, to: number, author: string): string {
  let pos = 0;
  let kept = '';
  for (const s of spans) {
    const end = pos + s.text.length;
    const a = Math.max(from, pos);
    const b = Math.min(to, end);
    if (b > a) {
      const own = s.kind === 'ins' && s.author === author;
      if (!own) kept += s.text.slice(a - pos, b - pos);
    }
    pos = end;
    if (pos >= to) break;
  }
  return kept;
}

/** True when [from, to) consists only of pending deletions (nothing new would be struck). */
export function onlyPendingDeletions(spans: readonly Span[], from: number, to: number): boolean {
  if (to <= from) return false;
  let pos = 0;
  for (const s of spans) {
    const end = pos + s.text.length;
    if (Math.min(to, end) > Math.max(from, pos) && s.kind !== 'del') return false;
    pos = end;
    if (pos >= to) break;
  }
  return true;
}
