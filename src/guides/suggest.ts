/**
 * Principles Claude Code suggests for a style guide after reading the author's samples,
 * written next to the guide as `<name>.principles.json`:
 *
 *   { "principles": [ { "section": "Openings", "principle": "Open with …",
 *                       "examples": ["\"quoted words\" (file)"], "reason": "why" } ] }
 *
 * The app adds each one to the guide as its own tracked insertion, at the end of its section,
 * so the author accepts or rejects principles one at a time.
 */
import type { Op, State } from '../model/types';
import { absoluteToPos } from '../model/views';
import { cleanToRevision, type OpBuilder } from '../folder/merge';
import { parsePrinciples } from './principles';

export const SUGGESTIONS_EXT = '.principles.json';

export type Suggestion = {
  /** The heading to put it under; empty means the end of the guide. */
  section: string;
  principle: string;
  examples: string[];
  reason?: string;
};

export class SuggestionError extends Error {}

export function parseSuggestions(text: string): { document?: string; principles: Suggestion[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SuggestionError('it is not valid JSON');
  }
  const list = (raw as { principles?: unknown } | null)?.principles;
  if (!Array.isArray(list)) throw new SuggestionError('it has no "principles" list');
  const one = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const principles: Suggestion[] = [];
  for (const item of list as Record<string, unknown>[]) {
    const principle = one(item?.principle)
      .replace(/^[-*+]\s+/, '')
      .replace(/^\[[^\]]*\]\s*/, '');
    if (!principle) throw new SuggestionError('every entry needs a "principle"');
    const reason = one(item.reason);
    principles.push({
      section: one(item.section).replace(/^#+\s*/, ''),
      principle,
      examples: Array.isArray(item.examples) ? item.examples.map(one).filter(Boolean) : [],
      ...(reason ? { reason } : {}),
    });
  }
  const document = (raw as { document?: unknown }).document;
  return { ...(typeof document === 'string' ? { document } : {}), principles };
}

export type PlacedSuggestion = { suggestion: Suggestion; at: number; insert: string };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Where a section's content ends: before the next heading (or the end), blank lines excluded. */
function sectionEnd(clean: string, section: string): number | undefined {
  const lines = clean.split('\n');
  let offset = 0;
  let inside = false;
  let end: number | undefined;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (inside) break;
      if (norm(heading[1]!) === norm(section)) inside = true;
    }
    if (inside && line.trim()) end = offset + line.length;
    offset += line.length + 1;
  }
  return inside ? end : undefined;
}

/**
 * Turns suggestions into insertions in the guide's clean text. A suggestion the guide already
 * has (same wording) is skipped. A section the guide lacks is added at the end, once.
 */
export function placeSuggestions(
  clean: string,
  suggestions: readonly Suggestion[],
): { placed: PlacedSuggestion[]; skipped: Suggestion[] } {
  const have = new Set(parsePrinciples(clean).principles.map((p) => norm(p.text)));
  const placed: PlacedSuggestion[] = [];
  const skipped: Suggestion[] = [];
  const started = new Set<string>();
  const docEnd = clean.replace(/\s+$/, '').length;
  for (const s of suggestions) {
    if (have.has(norm(s.principle))) {
      skipped.push(s);
      continue;
    }
    have.add(norm(s.principle));
    const item = `- ${s.principle}` + s.examples.map((e) => `\n  - ${e}`).join('');
    const end = s.section ? sectionEnd(clean, s.section) : undefined;
    if (end !== undefined) {
      placed.push({ suggestion: s, at: end, insert: `\n${item}` });
    } else if (s.section && !started.has(norm(s.section))) {
      started.add(norm(s.section));
      placed.push({ suggestion: s, at: docEnd, insert: `\n\n## ${s.section}\n\n${item}` });
    } else {
      placed.push({ suggestion: s, at: docEnd, insert: s.section ? `\n${item}` : `\n\n${item}` });
    }
  }
  return { placed, skipped };
}

/**
 * Ops that add each placed suggestion as its own tracked insertion with its reason. Apply in
 * order: later positions first, and within one position last first, so the result reads in
 * the order given.
 */
export function suggestionOps(
  placed: readonly PlacedSuggestion[],
  opts: { author: string; ts: string; id: () => string },
): (Op | OpBuilder)[] {
  const out: (Op | OpBuilder)[] = [];
  const order = placed.map((p, i) => ({ p, i })).sort((a, b) => b.p.at - a.p.at || b.i - a.i);
  for (const { p } of order) {
    const changeId = opts.id();
    const base = { author: opts.author, ts: opts.ts };
    out.push((s: State) => {
      const at = absoluteToPos(s, cleanToRevision(s, p.at));
      return {
        ...base,
        id: opts.id(),
        type: 'edit',
        changeId,
        from: at,
        to: at,
        insert: p.insert,
        tracked: true,
      } satisfies Op;
    });
    if (p.suggestion.reason)
      out.push({
        ...base,
        id: opts.id(),
        type: 'set_reason',
        changeId,
        reason: p.suggestion.reason,
      });
  }
  return out;
}
