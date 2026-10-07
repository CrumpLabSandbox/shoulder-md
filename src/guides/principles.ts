/**
 * Style guide principles. A principle is a top-level list item in a guide document that starts
 * with its id in brackets:
 *
 *   - [B7] Prefer the active voice unless the actor is unknown.
 *   - [P2 replaces B3] In papers, report statistics in the past tense.
 *
 * The id lives in the text, so rewording or reordering never breaks a link from an edit to it.
 * Top-level list items without an id are new principles waiting for one. Lists inside
 * blockquotes and nested items (explanations, examples) are not principles.
 */
import { parser as markdownParser, GFM } from '@lezer/markdown';

const parser = markdownParser.configure(GFM);

export type Principle = {
  id: string;
  /** The principle's text, without the id, whitespace collapsed. */
  text: string;
  /** A base principle this one replaces (genre guides only). */
  replaces?: string;
};

export type ParsedGuide = {
  principles: Principle[];
  /** Offsets (in the parsed text) where a new principle's text starts and needs an id. */
  unnumbered: number[];
};

const ID = /^\[([A-Za-z][A-Za-z0-9]*-?\d+)(?:\s+replaces\s+([A-Za-z][A-Za-z0-9]*-?\d+))?\]\s*/;

export function parsePrinciples(text: string): ParsedGuide {
  const tree = parser.parse(text);
  const principles: Principle[] = [];
  const unnumbered: number[] = [];
  const cursor = tree.cursor();
  // Walk only the document's direct children: top-level lists, never quoted or nested ones.
  if (!cursor.firstChild()) return { principles, unnumbered };
  do {
    if (cursor.name !== 'BulletList' && cursor.name !== 'OrderedList') continue;
    const list = cursor.node;
    for (let item = list.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const mark = item.getChild('ListMark');
      // The item's own first paragraph (or task); nested lists below it are explanation.
      const body = item.getChild('Paragraph') ?? item.getChild('Task');
      if (!mark || !body) continue;
      const start = body.from;
      const raw = text.slice(start, body.to);
      const m = ID.exec(raw);
      if (m) {
        const rest = raw.slice(m[0].length).replace(/\s+/g, ' ').trim();
        principles.push({ id: m[1]!, text: rest, ...(m[2] ? { replaces: m[2] } : {}) });
      } else if (raw.trim()) {
        unnumbered.push(start);
      }
    }
  } while (cursor.nextSibling());
  return { principles, unnumbered };
}

export type PrincipleItem = {
  id?: string;
  text: string;
  /** The whole list item as written: marker, id, and any indented lines under it. */
  raw: string;
};

/** Every top-level list item of a guide, numbered or not, with its source text. */
export function principleItems(text: string): PrincipleItem[] {
  const tree = parser.parse(text);
  const out: PrincipleItem[] = [];
  const cursor = tree.cursor();
  if (!cursor.firstChild()) return out;
  do {
    if (cursor.name !== 'BulletList' && cursor.name !== 'OrderedList') continue;
    for (let item = cursor.node.firstChild; item; item = item.nextSibling) {
      if (item.name !== 'ListItem') continue;
      const body = item.getChild('Paragraph') ?? item.getChild('Task');
      if (!body) continue;
      const first = text.slice(body.from, body.to);
      const m = ID.exec(first);
      const rest = (m ? first.slice(m[0].length) : first).replace(/\s+/g, ' ').trim();
      if (!rest) continue;
      out.push({ ...(m ? { id: m[1]! } : {}), text: rest, raw: text.slice(item.from, item.to) });
    }
  } while (cursor.nextSibling());
  return out;
}

/** The next free id for a prefix: B1, B2, ... after the highest existing number. */
export function nextIds(prefix: string, existing: readonly string[], count: number): string[] {
  let max = 0;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  for (const id of existing) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Array.from({ length: count }, (_, i) => `${prefix}${max + i + 1}`);
}

/** Text insertions that give every unnumbered principle the next id, last first. */
export function numberingEdits(text: string, prefix: string): { at: number; insert: string }[] {
  const parsed = parsePrinciples(text);
  const ids = nextIds(
    prefix,
    parsed.principles.map((p) => p.id),
    parsed.unnumbered.length,
  );
  return parsed.unnumbered.map((at, i) => ({ at, insert: `[${ids[i]}] ` })).reverse();
}

export type ResolvedPrinciple = Principle & { source: 'base' | 'genre' };

/** The principles that apply to a document: the base guide, with the genre's added and overriding. */
export function resolvePrinciples(
  base: readonly Principle[],
  genre: readonly Principle[] = [],
): ResolvedPrinciple[] {
  const replaced = new Set(genre.map((p) => p.replaces).filter((x): x is string => !!x));
  return [
    ...base.filter((p) => !replaced.has(p.id)).map((p) => ({ ...p, source: 'base' as const })),
    ...genre.map((p) => ({ ...p, source: 'genre' as const })),
  ];
}

/** A short prefix for a new genre from its name, unique among `taken` (which includes 'B'). */
export function genrePrefix(name: string, taken: readonly string[]): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '') || 'G';
  const used = new Set(taken.map((t) => t.toUpperCase()));
  for (let n = 1; n <= letters.length; n++) {
    const p = letters.slice(0, n);
    if (!used.has(p)) return p;
  }
  for (let i = 2; ; i++) {
    const p = `${letters[0]}${i}`;
    if (!used.has(p)) return p;
  }
}

export function baseGuideTemplate(): string {
  return `# Base style guide

Principles that apply to everything I write. Genre guides add to these or replace some of them.

> Each principle is a top-level list item that starts with its id in brackets, like
> \`- [B1] Prefer the active voice unless the actor is unknown.\` Indented items under a principle
> are explanation and examples. Write new principles without an id and use "Give them ids".

`;
}

export function genreGuideTemplate(name: string, prefix: string): string {
  return `# ${name}

Principles for ${name.toLowerCase()} that add to the base guide.

> Ids here start with ${prefix}. To change a base principle for this genre, write
> \`- [${prefix}1 replaces B3] ...\` and it takes that principle's place in ${name.toLowerCase()} documents.

`;
}
