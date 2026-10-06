/**
 * Markdown exports: clean, original, and CriticMarkup (changes and comments marked up),
 * plus a CriticMarkup importer that rebuilds a document with pending changes and threads.
 *
 * CriticMarkup: {++inserted++}  {--deleted--}  {~~old~>new~~}  {==highlight==}{>>comment<<}
 */
import type { Author, CommentThread, Document, Op, Span, State } from '../model/types';
import { flatten, sameMark, type Tagged } from '../model/spans';
import { commentRanges, text as viewText, type View } from '../model/views';
import { appendOp, createDocument } from '../model/apply';
import { absoluteToPos } from '../model/views';
import { ulid } from '../model/ids';

export function exportMarkdown(state: State, view: Exclude<View, 'revision'>): string {
  return viewText(state, view);
}

/** Flat spans with same-mark neighbours merged across sentence boundaries. */
function mergedSpans(state: State): Span[] {
  const out: Span[] = [];
  for (const s of flatten(state.blocks)) {
    const last = out[out.length - 1];
    if (last && sameMark(last, s)) last.text += s.text;
    else {
      const { kind, text, changeId, author } = s;
      out.push({ kind, text, ...(changeId ? { changeId } : {}), ...(author ? { author } : {}) });
    }
  }
  return out;
}

export type CriticOptions = {
  comments?: boolean; // default true
  authors?: readonly Author[];
};

function esc(s: string): string {
  // Keep a comment body from closing its own marker.
  return s.replace(/<</g, '< <');
}

export function exportCriticMarkup(state: State, opts: CriticOptions = {}): string {
  const spans = mergedSpans(state);
  const withComments = opts.comments !== false;
  const name = (id: string) => opts.authors?.find((a) => a.id === id)?.name ?? id;

  // Comment insertion points, in revision coordinates, with the text to append.
  const notes = new Map<number, string[]>();
  const highlights: { from: number; to: number }[] = [];
  if (withComments) {
    const plainRanges = plainTextRanges(spans);
    for (const r of commentRanges(state)) {
      const t = state.comments.find((x) => x.id === r.threadId)!;
      const body = t.comments.map((c) => `${name(c.author)}: ${esc(c.body)}`).join(' // ');
      const prefix = t.resolved ? '[resolved] ' : '';
      const at = r.orphaned || r.to <= r.from ? r.from : r.to;
      notes.set(at, [...(notes.get(at) ?? []), `{>>${prefix}${body}<<}`]);
      if (!r.orphaned && r.to > r.from && plainRanges.some(([a, b]) => r.from >= a && r.to <= b)) {
        highlights.push({ from: r.from, to: r.to });
      }
    }
  }

  let out = '';
  let pos = 0;
  const emitText = (text: string, kind: Span['kind']) => {
    // Plain text may carry highlight and note boundaries; marked text only notes at its end.
    let i = 0;
    if (kind === 'text') {
      const cuts = new Set<number>();
      for (const h of highlights) {
        if (h.from >= pos && h.from <= pos + text.length) cuts.add(h.from - pos);
        if (h.to >= pos && h.to <= pos + text.length) cuts.add(h.to - pos);
      }
      for (const at of notes.keys()) if (at > pos && at < pos + text.length) cuts.add(at - pos);
      const sorted = [...cuts].sort((a, b) => a - b);
      for (const cut of sorted) {
        out += text.slice(i, cut);
        i = cut;
        const abs = pos + cut;
        if (highlights.some((h) => h.to === abs)) out += '==}';
        for (const n of notes.get(abs) ?? []) out += n;
        notes.delete(abs);
        if (highlights.some((h) => h.from === abs)) out += '{==';
      }
    }
    out += text.slice(i);
    pos += text.length;
  };

  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]!;
    for (const n of notes.get(pos) ?? []) if (s.kind === 'text') out += n;
    if (s.kind === 'text' && notes.has(pos)) notes.delete(pos);
    if (highlights.some((h) => h.from === pos) && s.kind === 'text') out += '{==';
    const next = spans[i + 1];
    if (s.kind === 'ins' && next?.kind === 'del' && next.changeId === s.changeId) {
      out += `{~~${next.text}~>${s.text}~~}`;
      pos += s.text.length + next.text.length;
      i++;
    } else if (s.kind === 'del' && next?.kind === 'ins' && next.changeId === s.changeId) {
      out += `{~~${s.text}~>${next.text}~~}`;
      pos += s.text.length + next.text.length;
      i++;
    } else if (s.kind === 'ins') {
      out += `{++${s.text}++}`;
      pos += s.text.length;
    } else if (s.kind === 'del') {
      out += `{--${s.text}--}`;
      pos += s.text.length;
    } else {
      emitText(s.text, 'text');
      continue;
    }
    if (highlights.some((h) => h.to === pos)) out += '==}';
    for (const n of notes.get(pos) ?? []) out += n;
    notes.delete(pos);
  }
  // Anything left (e.g. notes at the very end).
  for (const [, ns] of [...notes.entries()].sort((a, b) => a[0] - b[0])) out += ns.join('');
  return out;
}

function plainTextRanges(spans: Span[]): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.kind === 'text') out.push([pos, pos + s.text.length]);
    pos += s.text.length;
  }
  return out;
}

/* ---------- import ---------- */

export type ParsedComment = { from: number; to: number; body: string };
export type ParsedCritic = { spans: Span[]; comments: ParsedComment[]; changeIds: string[] };

const TOKEN =
  /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{==([\s\S]*?)==\}|\{>>([\s\S]*?)<<\}/g;

/** Parses CriticMarkup into revision spans (offsets are revision offsets) and comments. */
export function parseCriticMarkup(src: string, author = 'imported'): ParsedCritic {
  const spans: Span[] = [];
  const comments: ParsedComment[] = [];
  const changeIds: string[] = [];
  let pos = 0; // revision offset
  let last = 0; // source offset
  let lastHighlight: { from: number; to: number } | undefined;
  let lastWordEnd = 0;
  const pushText = (t: string) => {
    if (!t) return;
    spans.push({ kind: 'text', text: t });
    pos += t.length;
    lastHighlight = undefined;
  };
  const mark = (kind: 'ins' | 'del', text: string, changeId: string) => {
    if (!text) return;
    spans.push({ kind, text, changeId, author });
    pos += text.length;
  };
  for (const m of src.matchAll(TOKEN)) {
    pushText(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const id = ulid();
      changeIds.push(id);
      mark('ins', m[1], id);
      lastHighlight = undefined;
    } else if (m[2] !== undefined) {
      const id = ulid();
      changeIds.push(id);
      mark('del', m[2], id);
      lastHighlight = undefined;
    } else if (m[3] !== undefined) {
      const id = ulid();
      changeIds.push(id);
      mark('ins', m[4] ?? '', id);
      mark('del', m[3], id);
      lastHighlight = undefined;
    } else if (m[5] !== undefined) {
      const from = pos;
      spans.push({ kind: 'text', text: m[5] });
      pos += m[5].length;
      lastHighlight = { from, to: pos };
    } else if (m[6] !== undefined) {
      let range = lastHighlight;
      if (!range) {
        // Standalone comment: anchor to the word before it (or the word after, at the start).
        const text = spans.map((s) => s.text).join('');
        let from = pos;
        while (from > 0 && /[\p{L}\p{N}'’-]/u.test(text[from - 1]!)) from--;
        range = { from, to: pos };
        if (range.to === range.from) range = { from: pos, to: pos };
      }
      comments.push({ ...range, body: m[6].replace(/^\[resolved\] /, '') });
      lastWordEnd = pos;
    }
  }
  pushText(src.slice(last));
  void lastWordEnd;
  return { spans, comments, changeIds };
}

/** Builds a new document from CriticMarkup: an import of the original text, one splice applying the marks, then the comments. */
export function documentFromCriticMarkup(
  src: string,
  opts: {
    author: string;
    title?: string;
    ts?: string;
    tracking?: boolean;
    libraryEligible?: boolean;
  },
): Document {
  const parsed = parseCriticMarkup(src, opts.author);
  const ts = opts.ts ?? new Date().toISOString();
  const original = parsed.spans
    .filter((s) => s.kind !== 'ins')
    .map((s) => s.text)
    .join('');
  let doc = createDocument({
    text: original,
    author: opts.author,
    ts,
    title: opts.title,
    tracking: opts.tracking ?? true,
    libraryEligible: opts.libraryEligible,
  });
  if (parsed.spans.some((s) => s.kind !== 'text')) {
    const records = Object.fromEntries(
      parsed.changeIds.map((id) => [
        id,
        { id, author: opts.author, ts, tracked: true as const, status: 'pending' as const },
      ]),
    );
    const splice: Op = {
      id: ulid(),
      type: 'splice',
      author: opts.author,
      ts,
      from: 0,
      to: original.length,
      spans: parsed.spans,
      records,
    };
    doc = appendOp(doc, splice).doc;
  }
  for (const c of parsed.comments) {
    const anchor = anchorAt(doc.state, c.from, c.to);
    if (!anchor) continue;
    const op: Op = {
      id: ulid(),
      type: 'comment_add',
      author: opts.author,
      ts,
      threadId: ulid(),
      commentId: ulid(),
      anchor,
      body: c.body,
    };
    doc = appendOp(doc, op).doc;
  }
  return doc;
}

function anchorAt(state: State, from: number, to: number): CommentThread['anchor'] {
  const start = absoluteToPos(state, from);
  const end = absoluteToPos(state, Math.max(from, to));
  const ids: string[] = [];
  let collecting = false;
  outer: for (const b of state.blocks)
    for (const s of b.sentences) {
      if (s.id === start.sentenceId) collecting = true;
      if (collecting) ids.push(s.id);
      if (s.id === end.sentenceId) break outer;
    }
  if (ids.length === 0) return null;
  return { sentenceIds: ids, from: start.offset, to: end.offset };
}

export type { Tagged };
