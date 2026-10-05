/** Texts and offset maps derived from the state. */
import type { Block, Pos, Span, State } from './types';

export type View = 'revision' | 'clean' | 'original';

export function spanVisible(span: Span, view: View): boolean {
  if (view === 'revision') return true;
  if (view === 'clean') return span.kind !== 'del';
  return span.kind !== 'ins';
}

export function text(state: State, view: View = 'revision'): string {
  let out = '';
  for (const b of state.blocks)
    for (const s of b.sentences)
      for (const sp of s.spans) if (spanVisible(sp, view)) out += sp.text;
  return out;
}

export function sentenceText(spans: readonly Span[], view: View = 'revision'): string {
  let out = '';
  for (const sp of spans) if (spanVisible(sp, view)) out += sp.text;
  return out;
}

export type SentenceLocation = {
  blockId: string;
  sentenceId: string;
  /** Absolute start in the given view. */
  from: number;
  to: number;
  spans: Span[];
};

/** Every sentence with its absolute range in `view`. */
export function locate(state: State, view: View = 'revision'): SentenceLocation[] {
  const out: SentenceLocation[] = [];
  let pos = 0;
  for (const b of state.blocks) {
    for (const s of b.sentences) {
      const len = sentenceText(s.spans, view).length;
      out.push({ blockId: b.id, sentenceId: s.id, from: pos, to: pos + len, spans: s.spans });
      pos += len;
    }
  }
  return out;
}

export function posToAbsolute(state: State, pos: Pos, view: View = 'revision'): number {
  for (const loc of locate(state, view)) {
    if (loc.sentenceId === pos.sentenceId)
      return loc.from + Math.min(pos.offset, loc.to - loc.from);
  }
  throw new Error(`Unknown sentence ${pos.sentenceId}`);
}

/** The sentence containing absolute `offset` (a boundary belongs to the sentence after it, except at the end). */
export function absoluteToPos(state: State, offset: number, view: View = 'revision'): Pos {
  const locs = locate(state, view);
  for (let i = 0; i < locs.length; i++) {
    const loc = locs[i]!;
    const isLast = i === locs.length - 1;
    if (
      offset < loc.to ||
      (isLast && offset <= loc.to) ||
      (offset === loc.to && offset === loc.from)
    ) {
      return { sentenceId: loc.sentenceId, offset: offset - loc.from };
    }
  }
  const last = locs[locs.length - 1];
  if (!last) throw new Error('Empty state');
  return { sentenceId: last.sentenceId, offset: last.to - last.from };
}

export type MarkedRange = {
  from: number;
  to: number;
  kind: 'ins' | 'del';
  changeId: string;
  author: string;
  sentenceId: string;
};

/** Absolute ranges of every pending insertion and deletion, in revision coordinates. */
export function markedRanges(state: State): MarkedRange[] {
  const out: MarkedRange[] = [];
  let pos = 0;
  for (const b of state.blocks)
    for (const s of b.sentences)
      for (const sp of s.spans) {
        if (sp.kind !== 'text') {
          out.push({
            from: pos,
            to: pos + sp.text.length,
            kind: sp.kind,
            changeId: sp.changeId!,
            author: sp.author!,
            sentenceId: s.id,
          });
        }
        pos += sp.text.length;
      }
  return out;
}

/** Maps a revision offset to the same place in the clean (or original) text. */
export function mapOffset(state: State, offset: number, to: 'clean' | 'original'): number {
  let rev = 0;
  let mapped = 0;
  for (const b of state.blocks)
    for (const s of b.sentences)
      for (const sp of s.spans) {
        const len = sp.text.length;
        const visible = spanVisible(sp, to);
        if (offset <= rev + len) {
          return visible ? mapped + (offset - rev) : mapped;
        }
        rev += len;
        if (visible) mapped += len;
      }
  return mapped;
}

export function blockOf(state: State, sentenceId: string): Block | undefined {
  return state.blocks.find((b) => b.sentences.some((s) => s.id === sentenceId));
}
