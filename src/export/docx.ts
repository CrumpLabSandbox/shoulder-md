/**
 * Word export with real tracked changes (w:ins / w:del) and threaded comments.
 *
 * Block kinds map to Word styles (headings, bullet and numbered lists, Quote, Code, tables,
 * a rule). Inline Markdown (bold, italic, code, strikethrough, links) becomes run formatting
 * and its markers are dropped. Pending insertions and deletions become revisions attributed
 * to their author and time; comment threads become Word comments with replies.
 */
import {
  AlignmentType,
  BorderStyle,
  CommentRangeEnd,
  CommentRangeStart,
  CommentReference,
  DeletedTextRun,
  Document as DocxDocument,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  InsertedTextRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  XmlAttributeComponent,
  XmlComponent,
  type IParagraphOptions,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import { parser as markdownParser, GFM } from '@lezer/markdown';
import type { Author, Block, Document, State } from '../model/types';
import { commentRanges, locate, type CommentRange } from '../model/views';
import { displayTitle } from '../docs/title';
import { text as viewText } from '../model/views';

const parser = markdownParser.configure(GFM);

type CharStyle = {
  omit: boolean;
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  link?: string;
  /** On the first character of a Markdown image: what to put there instead of its text. */
  image?: { url: string; alt: string };
};

const MARKERS = new Set([
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'HeaderMark',
  'ListMark',
  'QuoteMark',
  'TaskMarker',
  'CodeInfo',
  'StrikethroughMark',
  'URL',
  'LinkTitle',
  'HardBreak',
]);

/** Per-character inline styles of a block's text, from a standalone Markdown parse. */
function inlineStyles(text: string, kind: Block['kind']): CharStyle[] {
  const styles: CharStyle[] = Array.from({ length: text.length }, () => ({
    omit: false,
    bold: false,
    italic: false,
    code: kind === 'code',
    strike: false,
  }));
  if (kind === 'thematic_break') return styles.map((s) => ({ ...s, omit: true }));
  const tree = parser.parse(text);
  const set = (from: number, to: number, f: (s: CharStyle) => void) => {
    for (let i = from; i < to && i < styles.length; i++) f(styles[i]!);
  };
  tree.iterate({
    enter(node) {
      if (MARKERS.has(node.name)) {
        set(node.from, node.to, (s) => (s.omit = true));
        // A "[text](url)" link: the URL and the LinkMarks are omitted; keep the text.
        return node.name === 'URL' ? false : undefined;
      }
      switch (node.name) {
        case 'StrongEmphasis':
          set(node.from, node.to, (s) => (s.bold = true));
          break;
        case 'Emphasis':
          set(node.from, node.to, (s) => (s.italic = true));
          break;
        case 'InlineCode':
          set(node.from, node.to, (s) => (s.code = true));
          break;
        case 'Strikethrough':
          set(node.from, node.to, (s) => (s.strike = true));
          break;
        case 'Image': {
          // The whole "![alt](url)" is replaced by the picture (or a note, if it is missing).
          const url = node.node.getChild('URL');
          const src = url ? text.slice(url.from, url.to) : '';
          const alt = /^!\[([^\]]*)\]/.exec(text.slice(node.from, node.to))?.[1] ?? '';
          set(node.from, node.to, (s) => (s.omit = true));
          if (styles[node.from]) styles[node.from]!.image = { url: src, alt };
          return false;
        }
        case 'Link': {
          const url = node.node.getChild('URL');
          const href = url ? text.slice(url.from, url.to) : undefined;
          if (href) set(node.from, node.to, (s) => (s.link = href));
          break;
        }
        case 'SetextHeading1':
        case 'SetextHeading2': {
          // The underline is a HeaderMark already; the newline before it goes too.
          const mark = node.node.getChild('HeaderMark');
          if (mark && mark.from > 0) set(mark.from - 1, mark.from, (s) => (s.omit = true));
          break;
        }
      }
      return undefined;
    },
  });
  if (kind === 'code') {
    // Drop the newline after the opening fence and before the closing fence.
    const open = /^(`{3,}|~{3,})[^\n]*\n/.exec(text);
    if (open) set(open[0].length - 1, open[0].length, (s) => (s.omit = true));
    const close = /\n(`{3,}|~{3,})\s*$/.exec(text);
    if (close) set(close.index, close.index + 1, (s) => (s.omit = true));
  }
  return styles;
}

type Rev = {
  kind: 'text' | 'ins' | 'del';
  author: string;
  date: string;
  /** On a deletion: the text was a pending insertion by this author at this time. */
  inserted?: { author: string; date: string };
};

class RevisionAttributes extends XmlAttributeComponent<{
  id: number;
  author: string;
  date: string;
}> {
  protected override readonly xmlKeys = { id: 'w:id', author: 'w:author', date: 'w:date' };
}

/** Word's form for inserted-then-deleted text: <w:ins><w:del><w:r><w:delText/></w:r></w:del></w:ins>. */
class InsertedDeletion extends XmlComponent {
  constructor(ins: { id: number; author: string; date: string }, deletion: DeletedTextRun) {
    super('w:ins');
    this.root.push(new RevisionAttributes(ins));
    this.root.push(deletion);
  }
}

let revisionCounter = 0;

function makeRun(
  text: string,
  style: CharStyle,
  rev: Rev,
  authors: readonly Author[],
): ParagraphChild {
  const base: IRunOptions = {
    text,
    bold: style.bold || undefined,
    italics: style.italic || undefined,
    strike: style.strike || undefined,
    font: style.code ? 'Consolas' : undefined,
    shading: style.code ? { type: ShadingType.CLEAR, fill: 'F2F2F2' } : undefined,
    color: style.link && rev.kind === 'text' ? '0563C1' : undefined,
    underline: style.link ? {} : undefined,
  };
  const name = authors.find((a) => a.id === rev.author)?.name ?? rev.author;
  if (rev.kind === 'ins')
    return new InsertedTextRun({ ...base, id: ++revisionCounter, author: name, date: rev.date });
  if (rev.kind === 'del') {
    const del = new DeletedTextRun({
      ...base,
      id: ++revisionCounter,
      author: name,
      date: rev.date,
    });
    if (!rev.inserted) return del;
    const insName = authors.find((a) => a.id === rev.inserted!.author)?.name ?? rev.inserted.author;
    return new InsertedDeletion(
      { id: ++revisionCounter, author: insName, date: rev.inserted.date },
      del,
    ) as unknown as ParagraphChild;
  }
  const run = new TextRun(base);
  if (style.link) return new ExternalHyperlink({ children: [run], link: style.link });
  return run;
}

type CommentPlan = {
  /** Word comment ids per thread, root first. */
  ids: Map<string, number[]>;
  ranges: CommentRange[];
};

/** A picture to embed, already measured. Sizes are in pixels. */
export type DocxImage = {
  data: Uint8Array;
  type: 'png' | 'jpg' | 'gif' | 'bmp';
  width: number;
  height: number;
};

export type DocxOptions = {
  authors?: readonly Author[];
  creator?: string;
  /** Images by the path the Markdown uses for them (`assets/<name>`). */
  images?: Record<string, DocxImage>;
};

/** The widest a picture is placed, in pixels (about the text width of a Letter or A4 page). */
const MAX_IMAGE_WIDTH = 600;

/** The picture for a Markdown image, scaled to fit the page, or a note when there is none. */
function imageRun(image: { url: string; alt: string }, images: DocxOptions['images']) {
  let key = image.url;
  try {
    key = decodeURIComponent(image.url);
  } catch {
    // keep the path as written
  }
  const found = images?.[key] ?? images?.[image.url];
  if (!found || found.width <= 0 || found.height <= 0)
    return new TextRun({ text: `[image: ${image.alt || image.url}]`, italics: true });
  const scale = Math.min(1, MAX_IMAGE_WIDTH / found.width);
  return new ImageRun({
    type: found.type,
    data: found.data,
    transformation: {
      width: Math.round(found.width * scale),
      height: Math.round(found.height * scale),
    },
    altText: { title: image.alt, description: image.alt, name: image.alt || 'image' },
  });
}

export async function exportDocx(doc: Document, opts: DocxOptions = {}): Promise<Blob> {
  const file = buildDocx(doc, opts);
  return Packer.toBlob(file);
}

/** For tests and Node: the .docx as a Buffer. */
export async function exportDocxBuffer(doc: Document, opts: DocxOptions = {}): Promise<Uint8Array> {
  const file = buildDocx(doc, opts);
  return Packer.toBuffer(file);
}

export function buildDocx(doc: Document, opts: DocxOptions = {}): DocxDocument {
  revisionCounter = 0;
  const state = doc.state;
  const authors = opts.authors ?? doc.authors;
  const name = (id: string) => authors.find((a) => a.id === id)?.name ?? id;

  // Comments: one Word comment per model comment; replies point at the root.
  const plan: CommentPlan = { ids: new Map(), ranges: commentRanges(state) };
  const commentDefs: ConstructorParameters<typeof DocxDocument>[0]['comments'] = { children: [] };
  let nextCommentId = 0;
  for (const t of state.comments) {
    const ids: number[] = [];
    t.comments.forEach((c, i) => {
      const id = nextCommentId++;
      ids.push(id);
      (commentDefs.children as unknown[]).push({
        id,
        author: name(c.author),
        initials: initials(name(c.author)),
        date: new Date(c.ts),
        children: [new Paragraph({ children: [new TextRun(c.body)] })],
        ...(i > 0 ? { parentId: ids[0] } : {}),
        ...(t.resolved && i === 0 ? { resolved: true } : {}),
      });
    });
    plan.ids.set(t.id, ids);
  }

  // Numbering: one instance per run of consecutive list items so numbers restart per list.
  const numberingConfig: {
    reference: string;
    levels: {
      level: number;
      format: 'bullet' | 'decimal';
      text: string;
      alignment: 'left';
      style: { paragraph: { indent: { left: number; hanging: number } } };
    }[];
  }[] = [];
  const listRefOfBlock = new Map<string, string>();
  {
    let runIndex = -1;
    let prevList = false;
    let prevOrdered = false;
    for (const b of state.blocks) {
      const isList = b.kind === 'list_item';
      const ordered = !!b.attrs.ordered;
      if (isList && (!prevList || ordered !== prevOrdered)) {
        runIndex++;
        const reference = `list-${runIndex}`;
        numberingConfig.push({
          reference,
          levels: Array.from({ length: 6 }, (_, level) => ({
            level,
            format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
            text: ordered ? `%${level + 1}.` : ['•', '◦', '▪'][level % 3]!,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        });
      }
      if (isList) listRefOfBlock.set(b.id, `list-${runIndex}`);
      prevList = isList;
      prevOrdered = ordered;
    }
  }

  const locs = locate(state);
  const children: (Paragraph | Table)[] = [];
  let blockStart = 0;
  for (const block of state.blocks) {
    const blockText = block.sentences.map((s) => s.spans.map((sp) => sp.text).join('')).join('');
    const blockEnd = blockStart + blockText.length;
    if (block.kind === 'table') {
      const table = buildTable(block, blockText, blockStart, state);
      if (table) children.push(table);
      blockStart = blockEnd;
      continue;
    }
    const styles = inlineStyles(blockText, block.kind);
    // Trailing newlines separate blocks; drop them.
    for (let i = blockText.length - 1; i >= 0 && blockText[i] === '\n'; i--) styles[i]!.omit = true;

    // Cut points: comment range boundaries inside this block.
    const cuts = new Map<number, { start: number[]; end: number[] }>();
    const cutAt = (abs: number) => {
      const rel = Math.min(Math.max(abs - blockStart, 0), blockText.length);
      let c = cuts.get(rel);
      if (!c) cuts.set(rel, (c = { start: [], end: [] }));
      return c;
    };
    for (const r of plan.ranges) {
      const ids = plan.ids.get(r.threadId) ?? [];
      if (r.orphaned) {
        if (
          r.from >= blockStart &&
          (r.from < blockEnd || (r.from === blockEnd && blockEnd === blockStart))
        ) {
          cutAt(r.from).start.push(...ids);
          cutAt(r.from).end.push(...ids);
        }
        continue;
      }
      if (r.from >= blockStart && r.from < blockEnd) cutAt(r.from).start.push(...ids);
      if (r.to > blockStart && r.to <= blockEnd) cutAt(r.to).end.push(...ids);
    }

    const runs: ParagraphChild[] = [];
    const emitCuts = (rel: number) => {
      const c = cuts.get(rel);
      if (!c) return;
      for (const id of c.start) runs.push(new CommentRangeStart(id));
      for (const id of c.end) {
        runs.push(new CommentRangeEnd(id));
        runs.push(new TextRun({ children: [new CommentReference(id)] }));
      }
      cuts.delete(rel);
    };

    let rel = 0;
    for (const sentence of block.sentences) {
      for (const span of sentence.spans) {
        const rev: Rev = {
          kind: span.kind,
          author: span.author ?? doc.ops[0]?.author ?? 'unknown',
          date: (span.changeId && state.changes[span.changeId]?.ts) || doc.updatedAt,
          ...(span.inserted
            ? {
                inserted: {
                  author: span.inserted.author,
                  date: state.changes[span.inserted.changeId]?.ts || doc.updatedAt,
                },
              }
            : {}),
        };
        let buf = '';
        let bufStyle: CharStyle | undefined;
        const flush = () => {
          if (buf && bufStyle) runs.push(makeRun(buf, bufStyle, rev, authors));
          buf = '';
          bufStyle = undefined;
        };
        for (let i = 0; i < span.text.length; i++) {
          if (cuts.has(rel)) {
            flush();
            emitCuts(rel);
          }
          const st = styles[rel]!;
          const ch = span.text[i]!;
          rel++;
          if (st.image) {
            flush();
            runs.push(imageRun(st.image, opts.images));
          }
          if (st.omit) continue;
          if (ch === '\n') {
            if (block.kind === 'code') {
              flush();
              runs.push(new TextRun({ break: 1 }));
            } else {
              // Soft line break: a space, once.
              if (buf.endsWith(' ')) continue;
              if (bufStyle && !sameStyle(bufStyle, st)) flush();
              buf += ' ';
              bufStyle ??= st;
            }
            continue;
          }
          if (bufStyle && !sameStyle(bufStyle, st)) flush();
          bufStyle ??= st;
          buf += ch;
        }
        flush();
      }
    }
    emitCuts(rel);
    for (const key of [...cuts.keys()]) emitCuts(key);

    children.push(new Paragraph({ ...paragraphOptions(block, listRefOfBlock), children: runs }));
    blockStart = blockEnd;
  }
  void locs;

  return new DocxDocument({
    creator: opts.creator ?? name(doc.ops[0]?.author ?? ''),
    title: displayTitle(state.meta.title, viewText(state, 'clean')),
    comments: commentDefs,
    numbering: { config: numberingConfig },
    styles: {
      paragraphStyles: [
        {
          id: 'Quote',
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          run: { italics: true, color: '555555' },
          paragraph: {
            indent: { left: 720 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 8 } },
          },
        },
        {
          id: 'Code',
          name: 'Code',
          basedOn: 'Normal',
          next: 'Normal',
          run: { font: 'Consolas', size: 20 },
          paragraph: {
            shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' },
            spacing: { before: 120, after: 120 },
          },
        },
      ],
    },
    sections: [{ children }],
  });
}

function sameStyle(a: CharStyle, b: CharStyle): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.code === b.code &&
    a.strike === b.strike &&
    a.link === b.link
  );
}

function initials(n: string): string {
  return n
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

function paragraphOptions(block: Block, listRefs: Map<string, string>): IParagraphOptions {
  switch (block.kind) {
    case 'heading': {
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ] as const;
      return { heading: levels[Math.min(6, Math.max(1, block.attrs.level ?? 1)) - 1] };
    }
    case 'list_item':
      return {
        numbering: {
          reference: listRefs.get(block.id) ?? 'list-0',
          level: Math.min(5, Math.max(0, (block.attrs.depth ?? 1) - 1)),
        },
        ...(block.attrs.quote ? { style: 'Quote' } : {}),
      };
    case 'code':
      return { style: 'Code' };
    case 'thematic_break':
      return {
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 1 } },
      };
    default:
      return block.attrs.quote ? { style: 'Quote' } : {};
  }
}

/** A GFM table from the block's clean text (marks inside tables are not carried over). */
function buildTable(
  block: Block,
  blockText: string,
  blockStart: number,
  state: State,
): Table | undefined {
  void blockStart;
  void state;
  const deleted = new Set<number>();
  {
    let pos = 0;
    for (const s of block.sentences)
      for (const sp of s.spans) {
        if (sp.kind === 'del') for (let i = pos; i < pos + sp.text.length; i++) deleted.add(i);
        pos += sp.text.length;
      }
  }
  const tree = parser.parse(blockText);
  const rows: string[][] = [];
  tree.iterate({
    enter(node) {
      if (node.name === 'TableHeader' || node.name === 'TableRow') {
        const cells: string[] = [];
        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          if (c.name !== 'TableCell') continue;
          let s = '';
          for (let i = c.from; i < c.to; i++) if (!deleted.has(i)) s += blockText[i];
          cells.push(s.trim());
        }
        rows.push(cells);
        return false;
      }
      return undefined;
    },
  });
  if (rows.length === 0) return undefined;
  const width = Math.max(...rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (cells, ri) =>
        new TableRow({
          tableHeader: ri === 0,
          children: Array.from(
            { length: width },
            (_, ci) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: cells[ci] ?? '', bold: ri === 0 || undefined })],
                  }),
                ],
              }),
          ),
        }),
    ),
  });
}
