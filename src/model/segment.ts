/**
 * Block and sentence segmentation of Markdown source.
 *
 * Blocks come from the Lezer Markdown parser (the same one CodeMirror highlights with, so
 * what the writer sees as a block is what the model calls a block). Leaf blocks are
 * paragraphs, headings, code, tables, rules and HTML; lists and blockquotes are containers
 * whose markers are glued onto the leaf they introduce. Every character of the source
 * belongs to exactly one block, so concatenating the blocks gives the source back.
 *
 * Sentences come from Intl.Segmenter plus a few Markdown-aware merge rules. Every character
 * of a block belongs to exactly one sentence. Trailing whitespace stays with the sentence
 * before it; a block's leading marker stays with its first sentence.
 */
import { parser as markdownParser, GFM } from '@lezer/markdown';
import type { SyntaxNode, Tree } from '@lezer/common';
import type { BlockAttrs, BlockKind } from './types';

const parser = markdownParser.configure(GFM);

export type BlockRange = { from: number; to: number; kind: BlockKind; attrs: BlockAttrs };

type Leaf = { from: number; to: number; kind: BlockKind; attrs: BlockAttrs };

const HEADING = /^(ATX|Setext)Heading(\d)$/;

function leafFor(node: SyntaxNode, text: string): Leaf | undefined {
  const name = node.name;
  const base = { from: node.from, to: node.to };
  const h = HEADING.exec(name);
  if (h) return { ...base, kind: 'heading', attrs: { level: Number(h[2]) } };
  switch (name) {
    case 'Paragraph':
    case 'Task':
      return { ...base, kind: 'paragraph', attrs: {} };
    case 'FencedCode': {
      const info = node.getChild('CodeInfo');
      const lang = info ? text.slice(info.from, info.to).trim() : undefined;
      return { ...base, kind: 'code', attrs: lang ? { lang } : {} };
    }
    case 'CodeBlock':
      return { ...base, kind: 'code', attrs: {} };
    case 'HorizontalRule':
      return { ...base, kind: 'thematic_break', attrs: {} };
    case 'Table':
      return { ...base, kind: 'table', attrs: {} };
    case 'HTMLBlock':
    case 'CommentBlock':
      return { ...base, kind: 'html', attrs: {} };
    case 'LinkReference':
      return { ...base, kind: 'other', attrs: {} };
    default:
      return undefined;
  }
}

function collectLeaves(tree: Tree, text: string): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (node: SyntaxNode, ctx: { depth: number; ordered: boolean; quote: number }) => {
    const leaf = leafFor(node, text);
    if (leaf) {
      if (ctx.depth > 0 && leaf.kind === 'paragraph') {
        leaf.kind = 'list_item';
        leaf.attrs.depth = ctx.depth;
        leaf.attrs.ordered = ctx.ordered;
        if (node.name === 'Task') {
          const marker = node.getChild('TaskMarker');
          const m = marker ? text.slice(marker.from, marker.to) : '';
          leaf.attrs.task = /x/i.test(m) ? 'checked' : 'unchecked';
        }
      }
      if (ctx.quote > 0) leaf.attrs.quote = ctx.quote;
      leaves.push(leaf);
      return;
    }
    let next = ctx;
    if (node.name === 'ListItem') {
      const parentOrdered = node.parent?.name === 'OrderedList';
      next = { ...ctx, depth: ctx.depth + 1, ordered: parentOrdered };
    } else if (node.name === 'Blockquote') {
      next = { ...ctx, quote: ctx.quote + 1 };
    }
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child, next);
  };
  walk(tree.topNode, { depth: 0, ordered: false, quote: 0 });
  leaves.sort((a, b) => a.from - b.from);
  return leaves;
}

/**
 * Splits `text` into contiguous block ranges covering [0, text.length].
 * Gaps between leaves are divided at the gap's last newline: the part through that newline
 * trails the previous block; what follows (indentation, list or quote markers) leads the next.
 */
export function segmentBlocks(text: string): BlockRange[] {
  if (text.length === 0) return [{ from: 0, to: 0, kind: 'paragraph', attrs: {} }];
  const leaves = collectLeaves(parser.parse(text), text);
  if (leaves.length === 0) return [{ from: 0, to: text.length, kind: 'paragraph', attrs: {} }];

  const ranges: BlockRange[] = [];
  let cursor = 0;
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]!;
    // Lead-in: everything from the cursor to this leaf. Blank lines belong to the previous block.
    let from = cursor;
    if (ranges.length > 0 && leaf.from > cursor) {
      const gap = text.slice(cursor, leaf.from);
      const nl = gap.lastIndexOf('\n');
      if (nl >= 0) {
        const prev = ranges[ranges.length - 1]!;
        prev.to = cursor + nl + 1;
        from = prev.to;
      }
    }
    const next = leaves[i + 1];
    const to = next ? Math.max(leaf.to, Math.min(next.from, leaf.to)) : text.length;
    ranges.push({ from, to, kind: leaf.kind, attrs: leaf.attrs });
    cursor = to;
  }
  ranges[ranges.length - 1]!.to = text.length;
  // Each block ends where the next begins; the lead-in adjustment above moved `to` of the
  // previous block, and the next block starts there.
  for (let i = 1; i < ranges.length; i++) ranges[i]!.from = ranges[i - 1]!.to;
  return ranges;
}

/* ---------- sentences ---------- */

const ABBREVIATIONS = new Set(
  [
    'e.g',
    'i.e',
    'cf',
    'vs',
    'etc',
    'al',
    'approx',
    'ca',
    'viz',
    'fig',
    'figs',
    'eq',
    'eqs',
    'no',
    'nos',
    'vol',
    'ch',
    'sec',
    'p',
    'pp',
    'ed',
    'eds',
    'dr',
    'mr',
    'mrs',
    'ms',
    'prof',
    'sr',
    'jr',
    'st',
    'mt',
    'ft',
    'inc',
    'ltd',
    'co',
    'corp',
    'dept',
    'univ',
    'est',
    'jan',
    'feb',
    'mar',
    'apr',
    'jun',
    'jul',
    'aug',
    'sep',
    'sept',
    'oct',
    'nov',
    'dec',
    'u.s',
    'u.k',
    'ph.d',
    'm.d',
    'b.a',
    'm.a',
    'a.m',
    'p.m',
  ].map((a) => a.toLowerCase()),
);

/** Kinds whose content is prose and gets sentence-split. */
const PROSE: ReadonlySet<BlockKind> = new Set(['paragraph', 'heading', 'list_item']);

type Segmenter = { segment(s: string): Iterable<{ index: number; segment: string }> };

let segmenter: Segmenter | undefined;
function getSegmenter(): Segmenter {
  if (segmenter) return segmenter;
  const S = (globalThis as { Intl?: { Segmenter?: new (loc: string, o: object) => Segmenter } })
    .Intl?.Segmenter;
  segmenter = S ? new S('en', { granularity: 'sentence' }) : fallbackSegmenter();
  return segmenter;
}

/** Regex splitter for runtimes without Intl.Segmenter: break after .!? plus closers and space. */
function fallbackSegmenter(): Segmenter {
  return {
    *segment(s: string) {
      const re = /[.!?]+["')\]]*\s+/g;
      let last = 0;
      for (const m of s.matchAll(re)) {
        const end = m.index + m[0].length;
        yield { index: last, segment: s.slice(last, end) };
        last = end;
      }
      if (last < s.length || s.length === 0) yield { index: last, segment: s.slice(last) };
    },
  };
}

/** Ranges of inline code and link destinations, where a period never ends a sentence. */
function protectedRanges(s: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of s.matchAll(/`+[^`]*`+/g)) out.push([m.index, m.index + m[0].length]);
  for (const m of s.matchAll(/\]\([^)]*\)/g)) out.push([m.index, m.index + m[0].length]);
  for (const m of s.matchAll(/<?https?:\/\/[^\s>]+>?/g)) out.push([m.index, m.index + m[0].length]);
  return out;
}

function lastWord(s: string): string {
  const trimmed = s.replace(/[\s"')\]*_]+$/u, '');
  const m = /([\p{L}.]+)\.$/u.exec(trimmed);
  return m ? m[1]!.toLowerCase() : '';
}

const NO_LETTERS = /^[^\p{L}]*$/u;

/**
 * Splits a block's text into contiguous sentence boundaries. Returns the end offsets of each
 * sentence; the last is always `text.length`. Non-prose blocks are a single sentence.
 */
export function segmentSentences(text: string, kind: BlockKind): number[] {
  if (!PROSE.has(kind) || text.length === 0) return [text.length];

  // Hard-wrapped lines are not sentence ends. Newlines become spaces for boundary finding
  // only; offsets are unchanged because the replacement is one char for one char.
  const flat = text.replace(/\n/g, ' ');
  const raw: number[] = [];
  for (const seg of getSegmenter().segment(flat)) raw.push(seg.index + seg.segment.length);
  if (raw.length === 0 || raw[raw.length - 1] !== text.length) raw.push(text.length);

  const protect = protectedRanges(text);
  const inProtected = (end: number) => protect.some(([a, b]) => end > a && end < b);

  // Merge rules walk boundaries in order; a boundary survives unless a rule removes it.
  const ends: number[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const end = raw[i]!;
    const isLast = i === raw.length - 1;
    const piece = text.slice(start, end);
    let merge = false;
    if (!isLast) {
      if (inProtected(end)) merge = true;
      else if (NO_LETTERS.test(piece))
        merge = true; // a bare marker like "1. " or "# "
      else if (ABBREVIATIONS.has(lastWord(piece))) merge = true;
      else if (!/\s$/.test(piece)) merge = true; // no whitespace after the terminator
    }
    if (!merge) {
      ends.push(end);
      start = end;
    }
  }
  if (ends.length === 0 || ends[ends.length - 1] !== text.length) ends.push(text.length);
  return ends;
}
