/**
 * The principle inbox (plan.md §9): principles Claude Code suggests from the author's own
 * reasoned edits, for review. Everything lives in `Style/Inbox/` in the shared folder:
 *
 *   edits.json        written by the app: the author's edits that carry a reason
 *   suggestions.json  written by Claude Code: principles to add or reword, and links to confirm
 *   decisions.json    written by the app: what the author did with each suggestion
 *   seen.json         written by the skill's helper: edits already analysed
 *
 * A suggestion the author adds goes into its guide as a tracked change; one they dismiss is
 * remembered in decisions.json so it is not suggested again.
 */
import type { Document } from '../model/types';
import { changeRecords } from '../library/records';
import { placeProposals, type Placed } from '../folder/proposals';

export const INBOX = 'Style/Inbox';
export const EDITS_FILE = 'edits.json';
export const SUGGESTIONS_FILE = 'suggestions.json';
export const DECISIONS_FILE = 'decisions.json';

/** Authors that are not the person writing: their edits are not evidence of the person's style. */
const NOT_PEOPLE = ['claude', 'disk'];

export type InboxEdit = {
  /** `<docId>:<changeId>`, how suggestions refer to it. */
  id: string;
  document: string;
  genre?: string;
  before: string;
  after: string;
  sentenceBefore: string;
  sentenceAfter: string;
  reason?: string;
  /** A reason given for a whole set of changes that this one belongs to. */
  setReason?: string;
  /** Principles already linked to it. */
  principles: string[];
  outcome: string;
};

/** The author's reasoned edits in one document, pending ones included. */
export function inboxEdits(doc: Document, opts: { title: string; genre?: string }): InboxEdit[] {
  const rows = changeRecords(doc, {
    includePending: true,
    ...(opts.genre ? { genreName: opts.genre } : {}),
  });
  const out: InboxEdit[] = [];
  for (const r of rows) {
    const rec = doc.state.changes[r.changeId];
    if (!rec || NOT_PEOPLE.includes(rec.author)) continue;
    if (!r.reason && !r.groupReason) continue;
    out.push({
      id: `${doc.id}:${r.changeId}`,
      document: opts.title,
      ...(opts.genre ? { genre: opts.genre } : {}),
      before: r.before,
      after: r.after,
      sentenceBefore: r.sentenceBefore,
      sentenceAfter: r.sentenceAfter,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.groupReason ? { setReason: r.groupReason } : {}),
      principles: r.principles.map((p) => p.id),
      outcome: r.outcome,
    });
  }
  return out;
}

export type InboxSuggestion = {
  /** A principle to add, or a new wording for one the guide has. */
  kind: 'new' | 'reword';
  /** 'base', or a genre's name. */
  guide: string;
  section?: string;
  /** For a rewording: the principle to change. */
  id?: string;
  principle: string;
  /** Ids of the edits behind it. */
  edits: string[];
  reason?: string;
};

/** An edit whose reason looks like an existing principle, for the author to confirm. */
export type InboxLink = { edit: string; principles: string[]; reason?: string };

export type Inbox = { suggestions: InboxSuggestion[]; links: InboxLink[] };

export class InboxError extends Error {}

export function parseInbox(text: string): Inbox {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new InboxError('it is not valid JSON');
  }
  const r = (raw ?? {}) as { suggestions?: unknown; links?: unknown };
  const one = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  const strings = (a: unknown) => (Array.isArray(a) ? a.map(one).filter(Boolean) : []);
  const suggestions: InboxSuggestion[] = [];
  for (const item of Array.isArray(r.suggestions)
    ? (r.suggestions as Record<string, unknown>[])
    : []) {
    const principle = one(item?.principle)
      .replace(/^[-*+]\s+/, '')
      .replace(/^\[[^\]]*\]\s*/, '');
    if (!principle) throw new InboxError('every suggestion needs a "principle"');
    const kind = item.kind === 'reword' ? 'reword' : 'new';
    const id = one(item.id);
    if (kind === 'reword' && !id) throw new InboxError('a rewording needs the "id" it changes');
    const section = one(item.section).replace(/^#+\s*/, '');
    const reason = one(item.reason);
    suggestions.push({
      kind,
      guide: one(item.guide) || 'base',
      ...(section ? { section } : {}),
      ...(kind === 'reword' ? { id } : {}),
      principle,
      edits: strings(item.edits),
      ...(reason ? { reason } : {}),
    });
  }
  const links: InboxLink[] = [];
  for (const item of Array.isArray(r.links) ? (r.links as Record<string, unknown>[]) : []) {
    const edit = one(item?.edit);
    const principles = strings(item?.principles);
    const reason = one(item?.reason);
    if (edit && principles.length) links.push({ edit, principles, ...(reason ? { reason } : {}) });
  }
  return { suggestions, links };
}

export function serializeInbox(inbox: Inbox): string {
  return JSON.stringify(inbox, null, 2) + '\n';
}

export type InboxDecision = {
  at: string;
  action: 'added' | 'reworded' | 'dismissed' | 'linked' | 'link-skipped';
  guide?: string;
  id?: string;
  principle?: string;
  edits?: string[];
  edit?: string;
  principles?: string[];
};

export function parseDecisions(text: string | undefined): InboxDecision[] {
  if (!text) return [];
  try {
    const list = (JSON.parse(text) as { decisions?: unknown }).decisions;
    return Array.isArray(list) ? (list as InboxDecision[]) : [];
  } catch {
    return [];
  }
}

/** Short evidence lines for a principle added from the inbox: what changed, and where. */
export function evidence(
  suggestion: InboxSuggestion,
  edits: readonly InboxEdit[],
  max = 2,
): string[] {
  const clip = (s: string) => (s.length > 90 ? s.slice(0, 89) + '…' : s);
  return suggestion.edits
    .map((id) => edits.find((e) => e.id === id))
    .filter((e): e is InboxEdit => !!e)
    .slice(0, max)
    .map((e) => {
      const what =
        e.before && e.after
          ? `"${clip(e.before)}" → "${clip(e.after)}"`
          : e.after
            ? `added "${clip(e.after)}"`
            : `cut "${clip(e.before)}"`;
      const why = e.reason ?? e.setReason;
      return `${what} (${e.document}${why ? `: ${clip(why)}` : ''})`;
    });
}

/**
 * Where a rewording goes in a guide's clean text: the words of principle `id` that change.
 * Undefined when the guide has no such principle or the wording is already that.
 */
export function placeReword(clean: string, id: string, wording: string): Placed | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(
    `^([-*+] \\[${escaped}(?:\\s+replaces\\s+[^\\]]+)?\\]\\s*)(.*)$`,
    'm',
  ).exec(clean);
  if (!line) return undefined;
  const { placed } = placeProposals(clean, [{ quote: line[0], replacement: line[1] + wording }]);
  return placed[0];
}
