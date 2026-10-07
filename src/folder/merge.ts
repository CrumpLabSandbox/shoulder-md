/**
 * Turns an outside edit of a document's clean text (say, the .md file changed by another tool)
 * into tracked changes: a word-level diff against the current clean text, one edit op per hunk.
 */
import type { Op, State } from '../model/types';
import { absoluteToPos, text as viewText } from '../model/views';

export type Hunk = { from: number; to: number; insert: string };

const TOKEN = /\s+|[\p{L}\p{N}_'’]+|[^\s\p{L}\p{N}_'’]/gu;

export function tokenize(s: string): string[] {
  return s.match(TOKEN) ?? [];
}

/** Myers' O(ND) diff over token arrays. Returns edit scripts as [aStart, aEnd, bStart, bEnd] runs. */
function diffTokens(
  a: string[],
  b: string[],
  maxD = 4000,
): [number, number, number, number][] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  let v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    const next = v;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && next[offset + k - 1]! < next[offset + k + 1]!))
        x = next[offset + k + 1]!;
      else x = next[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
    if (found) {
      trace.push(v.slice());
      break;
    }
  }
  if (!found) return undefined;

  // Backtrack into a list of matched (equal) diagonals, then derive change runs between them.
  const equal: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1]! < vv[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : vv[offset + prevK]!;
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      equal.push([x, y]);
    }
    if (d === 0) break;
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    equal.push([x, y]);
  }
  equal.reverse();

  const runs: [number, number, number, number][] = [];
  let ai = 0;
  let bi = 0;
  for (const [ea, eb] of equal) {
    if (ea > ai || eb > bi) runs.push([ai, ea, bi, eb]);
    ai = ea + 1;
    bi = eb + 1;
  }
  if (ai < n || bi < m) runs.push([ai, n, bi, m]);
  return runs;
}

/** Character hunks turning `a` into `b`, in a's coordinates, ascending and non-overlapping. */
export function textHunks(a: string, b: string): Hunk[] {
  if (a === b) return [];
  const ta = tokenize(a);
  const tb = tokenize(b);
  // Tokens cover the whole string, so offsets are prefix sums.
  const offA = [0];
  for (const t of ta) offA.push(offA[offA.length - 1]! + t.length);
  const offB = [0];
  for (const t of tb) offB.push(offB[offB.length - 1]! + t.length);
  const runs = diffTokens(ta, tb);
  if (!runs) return [{ from: 0, to: a.length, insert: b }];
  return runs.map(([a0, a1, b0, b1]) => ({
    from: offA[a0]!,
    to: offA[a1]!,
    insert: b.slice(offB[b0]!, offB[b1]!),
  }));
}

/**
 * Joins hunks that are only a few unchanged characters apart, so a rewritten sentence reads as
 * one change instead of a dozen single-word ones. Hunks on different lines are never joined,
 * and a hunk that adds a line break (a new paragraph, say) stays a change of its own.
 */
export function coarsen(a: string, hunks: readonly Hunk[], maxGap: number): Hunk[] {
  const out: Hunk[] = [];
  for (const h of hunks) {
    const last = out[out.length - 1];
    const gap = last ? a.slice(last.to, h.from) : '';
    const breaks = (s: string) => s.includes('\n');
    if (last && gap.length <= maxGap && !breaks(gap) && !breaks(last.insert) && !breaks(h.insert))
      out[out.length - 1] = { from: last.from, to: h.to, insert: last.insert + gap + h.insert };
    else out.push({ ...h });
  }
  return out;
}

/** The revision offset where clean offset `c` sits (before any pending deletions at that spot). */
export function cleanToRevision(state: State, c: number): number {
  let rev = 0;
  let clean = 0;
  for (const b of state.blocks)
    for (const s of b.sentences)
      for (const sp of s.spans) {
        if (clean === c) return rev;
        if (sp.kind === 'del') {
          rev += sp.text.length;
          continue;
        }
        if (clean + sp.text.length > c) return rev + (c - clean);
        clean += sp.text.length;
        rev += sp.text.length;
      }
  return rev;
}

export type OpBuilder = (state: State) => Op | undefined;

/**
 * Builders for tracked edit ops that turn the document's clean text into `target`. With
 * `joinWithin`, changes that close together become one (for rewrites). They must be
 * applied in order, each against the state the previous one leaves (later hunks come first, so
 * clean offsets of the remaining hunks stay valid).
 */
export function editsToMatch(
  state: State,
  target: string,
  opts: { author: string; ts: string; id: () => string; joinWithin?: number },
): OpBuilder[] {
  const clean = viewText(state, 'clean');
  const fine = textHunks(clean, target);
  const hunks = opts.joinWithin ? coarsen(clean, fine, opts.joinWithin) : fine;
  return hunks
    .slice()
    .reverse()
    .map((h) => (s: State) => {
      const revFrom = cleanToRevision(s, h.from);
      const revTo = Math.max(revFrom, cleanToRevision(s, h.to));
      return {
        id: opts.id(),
        type: 'edit',
        author: opts.author,
        ts: opts.ts,
        changeId: opts.id(),
        from: absoluteToPos(s, revFrom),
        to: absoluteToPos(s, revTo),
        insert: h.insert,
        tracked: true,
      } satisfies Op;
    });
}
