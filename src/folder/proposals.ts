/**
 * Proposed edits written next to a document by Claude Code, as `<name>.proposals.json`:
 *
 *   { "proposals": [ { "quote": "text as it is in the .md", "replacement": "new text",
 *                      "principles": ["G2"], "reason": "why" } ] }
 *
 * Each proposal is anchored by its quote, which must occur exactly once in the document's
 * clean text, so proposals survive typing elsewhere in the meantime. The app turns each into
 * one tracked change by "Claude" with the reason and principle links already set.
 */
import type { Op, State } from '../model/types';
import { absoluteToPos } from '../model/views';
import { cleanToRevision, tokenize, type OpBuilder } from './merge';

export const PROPOSALS_EXT = '.proposals.json';
export const SKIPPED_EXT = '.proposals.skipped.json';

export type Proposal = {
  quote: string;
  replacement: string;
  reason?: string;
  principles?: string[];
};

export type ProposalFile = { document?: string; proposals: Proposal[] };

export class ProposalError extends Error {}

export function parseProposals(text: string): ProposalFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProposalError('it is not valid JSON');
  }
  const list = (raw as { proposals?: unknown } | null)?.proposals;
  if (!Array.isArray(list)) throw new ProposalError('it has no "proposals" list');
  const proposals: Proposal[] = [];
  for (const item of list as Record<string, unknown>[]) {
    if (!item || typeof item.quote !== 'string' || typeof item.replacement !== 'string')
      throw new ProposalError('every proposal needs a "quote" and a "replacement"');
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    const principles = Array.isArray(item.principles)
      ? item.principles.filter((p): p is string => typeof p === 'string')
      : [];
    proposals.push({
      quote: item.quote,
      replacement: item.replacement,
      ...(reason ? { reason } : {}),
      ...(principles.length ? { principles } : {}),
    });
  }
  const document = (raw as { document?: unknown }).document;
  return { ...(typeof document === 'string' ? { document } : {}), proposals };
}

export type Placed = {
  proposal: Proposal;
  /** The part of the quote that changes, in clean-text offsets, and what replaces it. */
  from: number;
  to: number;
  insert: string;
};

export type SkipReason = 'not-found' | 'ambiguous' | 'overlap' | 'no-change';
export type Skipped = { proposal: Proposal; why: SkipReason };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where the quote sits: exactly, or failing that with any run of whitespace matching any other. */
function locate(clean: string, quote: string): { from: number; to: number } | SkipReason {
  if (!quote.trim()) return 'not-found';
  const first = clean.indexOf(quote);
  if (first >= 0) {
    if (clean.indexOf(quote, first + 1) >= 0) return 'ambiguous';
    return { from: first, to: first + quote.length };
  }
  const loose = new RegExp(quote.trim().split(/\s+/).map(escape).join('\\s+'), 'g');
  const hits = [...clean.matchAll(loose)];
  if (hits.length === 0) return 'not-found';
  if (hits.length > 1) return 'ambiguous';
  return { from: hits[0]!.index, to: hits[0]!.index + hits[0]![0].length };
}

/**
 * The middle of `actual` that differs from `replacement`, after dropping the words they share
 * at the start and end. Whitespace of any kind counts as the same, so a line wrap in the
 * document is not itself reported as a change.
 */
function narrow(
  actual: string,
  replacement: string,
): { from: number; to: number; insert: string } | undefined {
  const a = tokenize(actual);
  const b = tokenize(replacement);
  const same = (x: string, y: string) => x === y || (!x.trim() && !y.trim());
  const most = Math.min(a.length, b.length);
  let head = 0;
  while (head < most && same(a[head]!, b[head]!)) head++;
  if (head === a.length && head === b.length) return undefined;
  let tail = 0;
  while (tail < most - head && same(a[a.length - 1 - tail]!, b[b.length - 1 - tail]!)) tail++;
  const len = (t: string[]) => t.reduce((n, s) => n + s.length, 0);
  return {
    from: len(a.slice(0, head)),
    to: actual.length - len(a.slice(a.length - tail)),
    insert: b.slice(head, b.length - tail).join(''),
  };
}

/**
 * Anchors proposals in the clean text. Each placed proposal is narrowed to the words that
 * actually change, so the tracked change shows the edit and not the whole quoted sentence.
 */
export function placeProposals(
  clean: string,
  proposals: readonly Proposal[],
): { placed: Placed[]; skipped: Skipped[] } {
  const placed: Placed[] = [];
  const skipped: Skipped[] = [];
  for (const proposal of proposals) {
    const at = locate(clean, proposal.quote);
    if (typeof at === 'string') {
      skipped.push({ proposal, why: at });
      continue;
    }
    const change = narrow(clean.slice(at.from, at.to), proposal.replacement);
    if (!change) {
      skipped.push({ proposal, why: 'no-change' });
      continue;
    }
    const from = at.from + change.from;
    const to = at.from + change.to;
    // Touching counts as overlapping: two edits at one spot would tangle their marks.
    if (placed.some((p) => from <= p.to && p.from <= to)) {
      skipped.push({ proposal, why: 'overlap' });
      continue;
    }
    placed.push({ proposal, from, to, insert: change.insert });
  }
  return { placed, skipped };
}

/**
 * Ops that turn placed proposals into tracked changes: for each, an edit, then its reason and
 * principle links. Apply in order; later proposals come first so clean offsets stay valid.
 * `known` limits principle links to ids the document's guides actually have.
 */
export function proposalOps(
  placed: readonly Placed[],
  opts: { author: string; ts: string; id: () => string; known?: readonly string[] },
): (Op | OpBuilder)[] {
  const out: (Op | OpBuilder)[] = [];
  for (const p of [...placed].sort((a, b) => b.from - a.from)) {
    const changeId = opts.id();
    const base = { author: opts.author, ts: opts.ts };
    out.push((s: State) => {
      const revFrom = cleanToRevision(s, p.from);
      const revTo = Math.max(revFrom, cleanToRevision(s, p.to));
      return {
        ...base,
        id: opts.id(),
        type: 'edit',
        changeId,
        from: absoluteToPos(s, revFrom),
        to: absoluteToPos(s, revTo),
        insert: p.insert,
        tracked: true,
      } satisfies Op;
    });
    if (p.proposal.reason)
      out.push({
        ...base,
        id: opts.id(),
        type: 'set_reason',
        changeId,
        reason: p.proposal.reason,
      });
    const ids = (p.proposal.principles ?? []).filter(
      (id) => !opts.known || opts.known.includes(id),
    );
    if (ids.length)
      out.push({ ...base, id: opts.id(), type: 'set_principles', changeId, principles: ids });
  }
  return out;
}
