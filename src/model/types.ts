/**
 * The document model. Pure data, no DOM. See plan.md §4.
 *
 * Text lives in spans. A sentence is a run of spans; a block is a run of sentences; the
 * document is a run of blocks. Concatenating every span's text, in order, gives the
 * *revision text*: the Markdown source with pending deletions still in place. That is what
 * the editor buffer holds. Structure (block and sentence boundaries) is always derived
 * from the revision text, so ids follow what the writer sees.
 */

export const SCHEMA_VERSION = 1 as const;

export type Author = { id: string; name: string; color?: string };

export type SpanKind = 'text' | 'ins' | 'del';

/** A pending insertion, as carried by a deletion of inserted text. */
export type InsertMark = { changeId: string; author: string };

export type Span = {
  kind: SpanKind;
  text: string;
  /** Present on 'ins' and 'del' spans: the tracked change this span belongs to. */
  changeId?: string;
  author?: string;
  /**
   * Only on 'del' spans: the text was itself a pending insertion when it was deleted (one
   * author deleting another's insertion, as Word does with nested w:ins/w:del). The two changes
   * resolve independently; see `resolveSpan`.
   */
  inserted?: InsertMark;
};

export type Sentence = { id: string; spans: Span[] };

export type BlockKind =
  'paragraph' | 'heading' | 'list_item' | 'code' | 'thematic_break' | 'table' | 'html' | 'other';

export type BlockAttrs = {
  level?: number; // headings
  ordered?: boolean; // list items
  depth?: number; // list nesting, 1-based
  task?: 'checked' | 'unchecked'; // GFM task items
  quote?: number; // blockquote nesting
  lang?: string; // fenced code
};

export type Block = { id: string; kind: BlockKind; attrs: BlockAttrs; sentences: Sentence[] };

/** A position inside a sentence, in that sentence's revision text. */
export type Pos = { sentenceId: string; offset: number };

export type ChangeStatus = 'pending' | 'accepted' | 'rejected';

/** Per-change metadata. The spans say where a pending change is; this says what it is. */
export type ChangeRecord = {
  id: string;
  author: string;
  ts: string;
  /** False for edits made with tracking off; they are auto-accepted and stay out of the margin. */
  tracked: boolean;
  status: ChangeStatus;
  reason?: string;
  reasonTags?: string[];
  /** Ids of the style guide principles this change applies (see src/guides/principles.ts). */
  principles?: string[];
  decidedBy?: string;
  decidedAt?: string;
  /** Captured when the change is decided (or immediately for untracked edits). */
  before?: string;
  after?: string;
};

export type CommentAnchor = {
  /** First to last sentence covered, in document order. */
  sentenceIds: string[];
  /** Offset in the first sentence's revision text. */
  from: number;
  /** Offset in the last sentence's revision text. */
  to: number;
};

export type Comment = { id: string; author: string; ts: string; body: string };

export type CommentThread = {
  id: string;
  /** Null once every anchored sentence is gone; the thread then hangs off `blockId`. */
  anchor: CommentAnchor | null;
  /** Fallback anchor, set when the range is orphaned. */
  blockId?: string;
  /** The anchor the thread had before it was orphaned; restored if those sentences return (undo). */
  orphanedFrom?: CommentAnchor;
  /** Set when the thread is the discussion of a change's reason. */
  changeId?: string;
  resolved: boolean;
  comments: Comment[];
};

/** Set on style guide documents: the base guide, or a genre's add-on. */
export type GuideMeta = {
  role: 'base' | 'genre';
  /** Principle id prefix: 'B' for the base guide, a short unique prefix per genre. */
  prefix: string;
  /** Genres only: documents in this genre keep Claude off unless switched on. */
  private?: boolean;
};

export type DocMeta = {
  /** Set by an explicit rename. Empty means the title is derived from the text. */
  title: string;
  tags: string[];
  status: 'draft' | 'in-review' | 'final';
  libraryEligible: boolean;
  /** The genre guide's document id; absent means the base guide only. */
  genre?: string;
  /** Explicit Claude access for this document; absent means follow the genre's default. */
  claude?: boolean;
  /** Present when this document is a style guide. */
  guide?: GuideMeta;
};

/** A metadata change: set the given fields; `null` clears an optional field. */
export type MetaPatch = { [K in keyof DocMeta]?: DocMeta[K] | null };

export type State = {
  blocks: Block[];
  changes: Record<string, ChangeRecord>;
  comments: CommentThread[];
  trackingOn: boolean;
  meta: DocMeta;
};

/** Fresh ids the reconciler handed out while applying an op, recorded so replay reuses them. */
export type Alloc = { sentenceIds: string[]; blockIds: string[] };

/** What an op did to the structure, derived for readers of the log; not needed for replay. */
export type Effect =
  | { kind: 'split'; sentenceId: string; into: string[] }
  | { kind: 'merge'; sentenceIds: string[]; into: string }
  | { kind: 'sentence_added'; sentenceId: string }
  | { kind: 'sentence_removed'; sentenceId: string }
  | { kind: 'block_added'; blockId: string }
  | { kind: 'block_removed'; blockId: string };

type OpBase = {
  id: string;
  author: string;
  ts: string;
};

type StructuralOp = { alloc?: Alloc; effects?: Effect[] };

export type Op = OpBase &
  (
    | ({ type: 'import'; text: string } & StructuralOp)
    | ({
        type: 'edit';
        changeId: string;
        from: Pos;
        to: Pos;
        insert: string;
        tracked: boolean;
      } & StructuralOp)
    | ({ type: 'accept'; changeIds: string[] } & StructuralOp)
    | ({ type: 'reject'; changeIds: string[] } & StructuralOp)
    | ({
        /**
         * Raw replacement of a revision range with the given spans, marks and all. The inverse
         * of every text-affecting op is a splice; it is how undo and redo are expressed.
         * Offsets are absolute in the revision text. Spans may carry sentence and block ids as
         * hints so a restored sentence can reclaim its old id.
         */
        type: 'splice';
        from: number;
        to: number;
        spans: (Span & { sentenceId?: string; blockId?: string })[];
        /** Change records to restore afterwards; null deletes a record. */
        records?: Record<string, ChangeRecord | null>;
      } & StructuralOp)
    | { type: 'set_reason'; changeId: string; reason?: string; reasonTags?: string[] }
    | { type: 'set_principles'; changeId: string; principles: string[] }
    | {
        type: 'comment_add';
        threadId: string;
        commentId: string;
        anchor: CommentAnchor;
        body: string;
        changeId?: string;
      }
    | { type: 'comment_reply'; threadId: string; commentId: string; body: string }
    | { type: 'comment_edit'; threadId: string; commentId: string; body: string }
    | { type: 'comment_resolve'; threadId: string; resolved: boolean }
    | { type: 'set_tracking'; on: boolean }
    | { type: 'set_meta'; patch: MetaPatch }
  );

export type OpType = Op['type'];

export type Document = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  createdAt: string;
  updatedAt: string;
  authors: Author[];
  ops: Op[];
  /** Materialized cache. Must equal replay(ops). */
  state: State;
};
