# shoulder-md: Plan

A browser-based Markdown editor with Word-style tracked changes and comments, built on a structured JSON layer that records every edit and the reason for it. Exports to Markdown, Word, PDF, or the full JSON. Over time, a library of edited documents whose history can teach Claude to edit the way this writer edits.

Status: phases 0 to 7 built (writing app with autosave, fonts and preview; sentence-level model and op log; Word-style tracked changes with reasons, accept/reject, views, and model-level undo; comment threads in the same margin; exports to Markdown, CriticMarkup, Word, JSON and PDF, with CriticMarkup and JSON import; the edits library with its JSONL change-record export; folder sync to a local directory or git repo; style guides with stable principle ids, genres, the per-document Claude switch and the private folder). Phase 9 (Claude proposing edits as tracked changes, through Claude Code and the shared folder) is also built. A Mac app (Electron shell with native menus and direct folder access) wraps the same build. Next is phase 8, the principle inbox. This document is the spec for v1 and the roadmap after it.

---

## 1. Decisions made

These were settled in the planning conversation on 2026-10-05.

| Decision | Choice | Notes |
|---|---|---|
| Editing surface | Raw Markdown source with inline change marks and a toggleable rendered preview | Markdown stays the truth. No WYSIWYG in v1. |
| Storage | Browser storage (IndexedDB) first; local folder on disk (File System Access API) as a later phase | Constant background save is a hard requirement. |
| Claude as editor | Phase 2, after the manual editor works | Human author and human editor first. |
| Change anchoring | Sentences with stable ids; changes record a character range within a sentence | Split and merge are explicit operations. |
| Stack | Vite + TypeScript + CodeMirror 6 + Svelte 5 | Svelte chosen over React for a small, fast app with little boilerplate. |
| Typography | Bundled open-source fonts (serif, sans, mono) plus size, line height, text width, and light/dark/sepia themes | Everything works offline. |
| Word import | Not in v1. Export only. | Import of plain .docx text, then of Word revisions, are later phases. |
| Edit reasons | Optional, prompted lightly: pick-list plus free text, never blocking | Required reasons and Claude-written reasons are later options. |

Assumptions I made without asking, easy to change:

- Markdown dialect is CommonMark plus GitHub-flavored tables, task lists, and strikethrough.
- The app deploys as static files to GitHub Pages. No server in v1.
- Single user, single browser tab at a time in v1. Multi-tab safety is handled, real-time collaboration is not.
- License: MIT. Bundled fonts are all SIL Open Font License.

---

## 2. Product shape

### Views

1. **Markup view** (default while editing). Markdown source in the editor. Pending insertions show underlined in an author color. Pending deletions stay in the text, shown struck through, and cannot be typed into. Comment and change cards sit in a right margin aligned to their anchors.
2. **Clean view**. All pending changes applied. Read-only or editable with tracking (editing in clean view is a stretch goal).
3. **Original view**. All pending changes rejected. Read-only.
4. **Preview**. Rendered Markdown of the clean text, in a split pane or a full pane. Preview uses its own font settings.

### Modes

- **Track changes on/off**, like Word. With tracking off, edits apply directly but are still written to the log, so history is never lost.
- **Author identity**. A name and color stored locally. Every change and comment carries the author. Claude will later be an author like any other.

### Core interactions

- Type anywhere. Keystrokes coalesce into one tracked change while they are contiguous and within a short time window, so a change reads as "replaced *this* with *that*", not thirty single-character ops.
- Select text and comment. A comment thread anchors to the selected range.
- Hover or click a change to see its card: author, time, old and new text, reason, accept, reject.
- Add a reason to a change from its card or with a shortcut while the cursor is in the change. Pick-list: clarity, concision, grammar, tone, accuracy, structure, style, other. Free text optional.
- Accept or reject one change, all changes by an author, or all changes.
- Next/previous change and next/previous comment navigation.
- Command palette for everything above.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ UI (Svelte)                                                 │
│  Editor pane  │ Margin (changes, comments) │ Preview │ Lib  │
├─────────────────────────────────────────────────────────────┤
│ Editor adapter (CodeMirror 6)                               │
│  doc = revision text; decorations for ins/del; atomic       │
│  ranges for deletions; transaction → model ops; model →     │
│  decoration rebuild                                         │
├─────────────────────────────────────────────────────────────┤
│ Document model (pure TypeScript, no DOM)                    │
│  op log (truth) · materialized state (cache) · segmenter ·  │
│  reconciler · accept/reject · views (markup/clean/original) │
├─────────────────────────────────────────────────────────────┤
│ Persistence                                                 │
│  IndexedDB op-append store · snapshots · settings           │
│  later: File System Access API folder                       │
├─────────────────────────────────────────────────────────────┤
│ Export                                                      │
│  Markdown (clean/original/CriticMarkup) · JSON · DOCX · PDF │
└─────────────────────────────────────────────────────────────┘
```

The document model is a pure library with no DOM dependency. It is where most of the correctness lives and it is tested in isolation. The editor adapter and the UI are thin layers over it.

### Package layout

```
shoulder-md/
  package.json           pnpm, vite, vitest, svelte, typescript
  src/
    model/               pure TS document model (the heart)
      types.ts           Document, Block, Sentence, Op, Change, CommentThread
      segment.ts         block + sentence segmentation of Markdown
      reconcile.ts       map a text edit onto sentences; emit split/merge
      apply.ts           reduce ops → state; replay
      views.ts           markup / clean / original text + offset maps
      changes.ts         coalescing, accept, reject
      comments.ts        threads, anchors, resolve
      schema.json        JSON Schema for exported documents
    editor/              CodeMirror 6 integration
      state.ts           StateField bridging CM doc ↔ model
      decorations.ts     ins/del marks, atomic deletion ranges, comment highlights
      commands.ts        accept/reject/comment/reason/navigate keymaps
      theme.ts           CM theme driven by settings
    ui/                  Svelte components
      App.svelte, Toolbar, Margin, ChangeCard, CommentThread,
      Preview, Settings, Library, CommandPalette
    persist/
      idb.ts             IndexedDB stores: docs, ops, snapshots, settings
      autosave.ts        debounce, flush on blur/hidden/unload, tab lock
      fs.ts              (later) File System Access API folder sync
    export/
      markdown.ts        clean, original, CriticMarkup
      json.ts
      docx.ts            real w:ins / w:del / comments via `docx`
      pdf.ts             print stylesheet → window.print()
    fonts/               bundled .woff2 + @font-face CSS
    styles/              themes, layout
  tests/                 vitest; model tests are the bulk
  public/
  docs/                  this plan, data model notes, decisions log
```

---

## 4. Document model

### Entities

```ts
type Document = {
  schemaVersion: 1;
  id: string;                 // ulid
  title: string;
  createdAt: string;          // ISO
  updatedAt: string;
  authors: Author[];
  tags: string[];
  status: 'draft' | 'in-review' | 'final';
  libraryEligible: boolean;   // privacy gate for the edits library
  ops: Op[];                  // append-only, the source of truth
  state: State;               // materialized cache; must equal replay(ops)
};

type State = {
  blocks: Block[];
  comments: CommentThread[];
  trackingOn: boolean;
};

type Block = {
  id: string;
  kind: 'heading' | 'paragraph' | 'list_item' | 'blockquote' | 'code' | 'thematic_break' | 'table' | 'html';
  attrs: { level?: number; ordered?: boolean; indent?: number; fence?: string; lang?: string };
  sentences: Sentence[];      // code/table/html blocks have exactly one "sentence"
};

type Sentence = {
  id: string;
  spans: Span[];              // revision text as a sequence of spans
};

// A span is a run of text with a tracked status.
type Span =
  | { kind: 'text'; text: string }                           // accepted, plain
  | { kind: 'ins'; text: string; changeId: string }          // pending insertion
  | { kind: 'del'; text: string; changeId: string;           // pending deletion
      inserted?: { changeId: string; author: string } };    // ...of someone's pending insertion
```

A deletion of another author's pending insertion keeps both marks, as Word nests `w:del` inside `w:ins`. The two changes resolve independently (`resolveSpan` in `src/model/spans.ts`): rejecting the deletion gives the insertion back, accepting the insertion leaves a plain deletion, and accepting the deletion or rejecting the insertion removes the text. The text is hidden in both clean and original views.

Three texts derive from a sentence's spans:

- **revision**: all spans concatenated. This is what the editor shows in markup view.
- **clean**: `text` + `ins` spans. What preview, clean export, and Claude see.
- **original**: `text` + `del` spans. What original view shows.

Offset maps between the three are computed on demand so decorations and comment anchors can move between views.

### Operations

Every op has `id`, `author`, and `ts`. Text-affecting ops also carry `alloc` (the fresh ids the reconciler handed out, so a replay reuses them) and `effects` (what happened to the structure, for readers of the log). Ops in the same `changeId` are one tracked change in the UI.

| Op | Payload | Effect |
|---|---|---|
| `import` | text | Sets the whole document, untracked. The first op of every document; also the resync safety net |
| `edit` | changeId, from, to (positions: sentenceId + offset in that sentence's revision text), insert, tracked | The one text primitive. Tracked: plain text in the range becomes `del`, the author's own pending `ins` in the range vanishes outright (Word behavior), another author's `ins` becomes a `del` that remembers the insertion (`inserted`), and the insertion becomes `ins`. Untracked: the range is removed and the insertion is plain text |
| `accept` | changeIds | `ins` → text; `del` spans removed |
| `reject` | changeIds | `ins` spans removed; `del` → text |
| `splice` | from, to (absolute revision offsets), spans, records? | Raw replacement of a range with the given spans, marks included, then restore the given change records. The inverse of every other text op; how undo and redo are logged |
| `set_reason` | changeId, reason, reasonTags | Attach or edit a reason |
| `set_group_reason` | groupId, changeIds, reason | One reason for a set of changes, kept beside each change's own reason as `group: { id, reason }` on the record; no reason clears it |
| `comment_add` | threadId, commentId, anchor, body, changeId? | Anchor: first-to-last sentence ids plus offsets in the first and last |
| `comment_reply` | threadId, commentId, body | |
| `comment_edit` | threadId, commentId, body | |
| `comment_resolve` | threadId, resolved | |
| `set_tracking` | on | Recorded so history shows when tracking was off |
| `set_meta` | patch of title, tags, status, libraryEligible | An empty title means "derive from the text" |

There are no block or sentence ops. Headings, list markers and paragraph breaks are text, so an `edit` is how they change, and the reconciler re-derives the structure afterwards. Splits and merges are reported as `effects` on the op (`split`, `merge`, `sentence_added`, `sentence_removed`, `block_added`, `block_removed`) rather than being ops of their own.

Per-change metadata lives in `state.changes[changeId]`: author, time, tracked or not, status, reason, who decided and when, and the before/after text captured at decision time. Edits made with tracking off get a record too, auto-accepted, so history is complete without cluttering the margin.

Replay is deterministic: `apply(apply(empty, ops[0]), ops[1]) ...` yields `state`, ids included. A property test replays random edit, accept and reject sequences and asserts equality with an id generator that throws if called.

### Sentence segmentation

Block segmentation uses the Lezer Markdown parser that CodeMirror already bundles (with GFM), so what the writer sees as a block is what the model calls a block. Leaf nodes (paragraphs, headings, fenced and indented code, tables, rules, HTML blocks) become blocks; list items and blockquotes are containers whose markers are glued onto the leaf they introduce. Gaps between leaves are split at the gap's last newline: blank lines trail the previous block, markers and indentation lead the next. Every character belongs to exactly one block, so concatenating the blocks reproduces the source.

Sentence splitting runs on each prose block's revision text (paragraphs, headings, list items):

- `Intl.Segmenter('en', { granularity: 'sentence' })` where available, with a regex fallback.
- Hard-wrapped lines are not sentence ends: newlines are treated as spaces for boundary finding only.
- Merge rules: no split after an abbreviation (e.g., i.e., Dr., Fig., ...), inside inline code, link destinations or URLs, after a bare marker such as `1. ` or `# `, or when no whitespace follows the terminator. Trailing whitespace stays with the sentence before it.
- Code, tables, HTML blocks, and thematic breaks are a single sentence each.

### Id stability (the hard part)

The editor is a free-form text buffer. The user can type anything anywhere, including a period that splits a sentence or a backspace that merges two. The model works on the document as one flat sequence of spans, each tagged with the sentence and block it came from:

1. An edit is applied to the flat spans at absolute revision offsets. Inserted text carries no tag.
2. The whole revision text is re-segmented into blocks and sentences (fast enough: Lezer is incremental-grade and the segmenter is per block).
3. Each new sentence takes the id of the old sentence that contributed the most of its characters, as long as no other new sentence has a stronger claim on that id (greedy by overlap, ties to document order). Blocks follow the same rule. Everything else gets a fresh id, recorded on the op. Because inserted text does not vote, typing a new sentence never steals the id of the one before it.
4. Comment anchors are carried through as absolute ranges via an offset map of the edit, then re-anchored to the new sentences. An anchor whose text is entirely gone becomes orphaned (`anchor: null`, with the block id as fallback), never deleted.

Rule of thumb: the sentence that keeps the majority of its original characters keeps its id. Structure follows the revision text, so a pending deletion of a period still ends a sentence until it is accepted; accepting it then merges, and the merge is reported as an effect.

### Tracked-change text in the editor buffer

The CodeMirror document is the **revision text**, which includes pending deletions. Deletions are marked as atomic read-only ranges, so the cursor skips over them and typing cannot land inside. This is the same trick Word uses on screen and it keeps the buffer a simple string. Insertions are ordinary editable text with a mark decoration.

Consequences:

- Backspacing onto a pending deletion skips it; backspacing onto someone else's insertion deletes it as a tracked deletion; backspacing onto your own insertion removes it outright.
- Search, cursor movement, and selection work on the revision text. Preview and exports work on clean text via the offset maps.

How it is built: a CodeMirror transaction filter rewrites user edits while tracking is on, so that text the model keeps as a pending deletion stays in the buffer (the rewritten change inserts the typed text followed by the kept text), and records the user's original change as an annotation that the adapter turns into `edit` ops. A deletion that would only cover pending deletions becomes a cursor move. Model-originated changes (accept, reject, undo, Claude's proposals later) are dispatched with a "from model" annotation that the filter and the adapter ignore.

**Undo goes through the model**, not CodeMirror's history. Every text-affecting op returns its inverse as `splice` ops (a raw replacement of a revision range with given spans, marks included, plus the change records to restore). The workspace keeps undo and redo stacks of inverse ops with the selection before and after, groups keystrokes by change id within half a second, and mirrors each applied op into the buffer. Undoing a tracked deletion therefore restores the pending state rather than inserting text, and undoing an accept brings the marks and the pending record back. Restored spans carry their old sentence ids as hints, so a sentence an undo brings back usually reclaims its id; a sentence the op merged into a neighbour may come back with a fresh id, and comments follow by offset either way.

---

## 5. Autosave and persistence

Requirement: changes are saved consistently behind the scenes, with no save button, and a crash or closed tab loses almost nothing.

Design: the op log is append-only, so saving means appending new ops. Each op is tiny. This makes continuous save cheap and robust.

- **Op append**: every editor transaction produces ops that are queued and written to the IndexedDB `ops` store (keyed by document id and sequence number) within ~250 ms (debounced). The write is a single transaction per batch; batches that queue up during a slow write are merged in order.
- **Typing runs**: a run of typing is one `edit` op, not one per keystroke. Each keystroke is applied on its own (for its undo inverse), then folded into the run's op: the longer op is applied to the state the run started from, and adopted only if it gives the same text, marks, change records and comment ranges (`src/model/coalesce.ts`). The run's op is then rewritten in place at its sequence number; a snapshot that already covered it is retaken. Anything else (a cursor move, a pause past the coalescing window, an undo, any other op) ends the run. Undoing a run logs one `splice`, composed from the per-keystroke inverses. Because the op count no longer changes with every edit, "has the browser moved on" is judged by the last op itself and the folder record keeps the document's `updatedAt`.
- **The JSON file** is compact, with one op per line so it still diffs line by line in git. Logs written before typing runs keep their per-keystroke ops.
- **Flush points**: on `blur`, `visibilitychange` to hidden, `pagehide`, and `beforeunload`, the queue is flushed synchronously as far as the browser allows.
- **Snapshots**: the document header in the `docs` store carries a materialized `state` snapshot, rewritten every 200 ops or 30 s of activity, whichever first, and when the document is closed or switched. Load = snapshot + replay of ops after it, so opening a long document stays fast.
- **Integrity**: the snapshot carries a hash of its state. On load a mismatch triggers a full replay from the op log and a console warning. In the editor, after every transaction the model's revision text is compared with the buffer; a mismatch is logged as a bug and the model resyncs from the buffer with an `import` op.
- **Status indicator**: "Saved", "Saving…", or "Unsaved changes (n)" in the status bar. Error state if IndexedDB fails, with an immediate "Download JSON" escape hatch.
- **Multi-tab**: a `BroadcastChannel` lock per document. A second tab opening the same document gets it read-only with a "Take over" button.
- **Named versions**: the user can name the current point ("sent to reviewer"). This is a `set_meta`-style marker op; nothing is copied.
- **Storage quota**: request `navigator.storage.persist()` and show usage in settings.
- **Local folder (built in phase 6)**: with the File System Access API (Chrome and Edge), every document is mirrored to a chosen folder as `<name>.md` (clean text) and `<name>.shoulder.json` (the full document with its op log), about a second after each save, so a git repo and Claude Code see current files. Names come from the title once and then stay put. Writes use `createWritable()`, which writes a swap file and replaces the original on close. The folder handle is remembered in IndexedDB; on reload the folder reconnects by itself if the browser still allows it, and otherwise the status bar offers "Reconnect".
  - Outside changes are found by polling the open document's files every two seconds and on window focus, comparing modification time and size with what was last written.
  - Conflict rule: the browser copy wins unless the files changed on disk and the browser did not, in which case the user is asked. An edited `.md` loads as tracked changes by "Edited on disk" (a word-level diff turned into `edit` ops, so it can be reviewed and undone); a `.shoulder.json` whose log extends ours loads the new ops; a different history can replace the document. When both changed, the disk version is saved as `<name>.conflict-<time>.md|.shoulder.json` before being overwritten, and a notice says so.
  - Connecting a folder imports any `*.shoulder.json` documents the browser does not have, so a second machine or browser picks up the same library. Deleting a document in the browser leaves its files alone and records a tombstone so they are not re-imported.

---

## 6. Typography and appearance

Bundled fonts, all SIL OFL, self-hosted as `.woff2` subsets (Latin plus Latin Extended), loaded with `font-display: swap`:

| Role | Fonts |
|---|---|
| Serif | Source Serif 4, Literata |
| Sans | Source Sans 3, Inter |
| Mono | JetBrains Mono, iA Writer Mono |
| Duospace | iA Writer Duo, iA Writer Quattro (comfortable for Markdown source) |

Settings, stored in `localStorage` and applied as CSS custom properties:

- Editor font, preview font (separately).
- Font size (12 to 24 px) and line height (1.2 to 2.0).
- Text width (measure) from 50 to 100 characters, or full width.
- Theme: light, dark, sepia, or follow system.
- Change mark style: underline/strikethrough with author colors, or color-only, or hidden (clean editing).
- Presets that set several at once: Manuscript (serif, 1.6, 70ch, sepia), Draft (duospace, 1.5, 80ch, light), Mono (JetBrains Mono, 1.5, 90ch, dark), plus Custom.

Later: allow any installed font by name, and list local fonts via the Local Font Access API where supported.

---

## 7. Exports

| Format | Content | Implementation |
|---|---|---|
| Markdown, clean | All pending changes accepted | Serialize clean text |
| Markdown, original | All pending changes rejected | Serialize original text |
| Markdown with changes | [CriticMarkup](http://criticmarkup.com/) `{++ins++}`, `{--del--}`, `{>>comment<<}`, `{==highlight==}` | Serialize revision spans; comments as `{>>…<<}` after the anchored range. Round-trips back into the model (import of CriticMarkup is cheap and useful for Claude Code workflows) |
| JSON | The full `Document`; `src/export/schema.json` describes it and the test suite validates exports against it | On import, the op log is replayed and must reproduce the stored state |
| Word (.docx) | Real tracked changes and comments | The `docx` npm package: `InsertedTextRun`, `DeletedTextRun`, `CommentRangeStart/End`, `CommentReference`, author and date per revision. Markdown block kinds map to Word styles (Heading 1–6, List Paragraph, Quote, code in a monospace style) |
| PDF | Clean or markup view | A print-only root in the page plus `window.print()`; insertions and deletions styled inline, comments as footnotes |
| Library export | JSONL of change records for training | See section 8 |

Export of the current document is a single menu. Export of the whole library is from the library view.

---

## 8. The edits library

A library is a collection of documents, each carrying its full history. In v1 it lives in IndexedDB.

- Library view: list with title, status, tags, last edited, counts of pending/accepted/rejected changes, search by title and text.
- Per document: `libraryEligible` flag, default off. Only eligible documents appear in library exports. This is the privacy gate.
- **Change record export** (JSONL), one row per change, version 1 (`src/library/records.ts`):

```json
{
  "v": 1, "docId": "...", "docTitle": "...", "changeId": "...",
  "author": "Matt", "ts": "2026-10-05T…", "blockKind": "paragraph",
  "before": "was", "after": "were",
  "sentenceBefore": "The results was significant.",
  "sentenceAfter": "The results were significant.",
  "contextBefore": "We ran it.", "contextAfter": "Then we stopped.",
  "reason": "subject-verb agreement", "reasonTags": ["grammar"],
  "discussion": [{ "author": "Matt", "ts": "…", "body": "plural subject" }],
  "outcome": "accepted", "decidedBy": "Matt", "decidedAt": "2026-10-05T…"
}
```

  - `outcome` is `accepted`, `rejected`, `pending` (only when asked), or `untracked` (edits made with tracking off; only when asked).
  - Sentences and context are captured at decision time by replaying the op log, so they show the text the decider saw. Other changes still pending at that moment appear in their original form, so `sentenceBefore` and `sentenceAfter` differ only by this change. A change that removes a sentence boundary pulls in the following sentence.
  - `discussion` is the comment threads attached to the change. Author ids are mapped to the local author's display name.
- This is the dataset the idea describes: edits with reasons and whether they were kept. It feeds a style guide, examples for a Claude skill, and later an evaluation of whether Claude's suggestions improve.
- Later: the local folder storage makes the library a plain directory in a git repo, which is where the "Claude Training Guides" and paper-librarian ideas can read from.

---

## 9. Style guides, the principle inbox, and Claude as an editor

Agreed on 2026-10-06. The idea: before Claude edits anything, build up a written account of how you edit (your principles), learn it from your own reasoned edits, and only then let Claude propose edits guided by it. Everything runs locally through Claude Code on your existing plan, working on the synced folder. No API key and no separate API billing.

### Style guides

- **A base guide plus genre add-ons.** The base guide holds principles that apply to everything; each genre (papers, grants, emails, ...) adds principles or overrides base ones. Each document picks a genre; its principles are the base plus that genre's add-on.
- Guides are documents in the app like any other, so they get tracked changes, comments and history.
- Each principle has a **stable id** (for example `B7`, `papers-3`) that survives rewording and reordering, so links from edits to principles never break.

### Reasons and principles

- While editing, reasons stay **free text** (the tag chips stay optional, as now).
- Reasons get **linked to principles afterwards**, suggested by Claude in the inbox (below) and confirmed by you. Manual linking is available too, and is the only route for documents with Claude switched off.

### The Claude switch

- A per-document switch for whether Claude may read and work with the document. It is independent of library inclusion (the dataset export) and of JSON storage.
- **Defaults come from the genre**: on by default, and a genre can be marked private so its documents default to off. Any document can be switched either way.
- **Enforced through the folders.** Documents that allow Claude sync to the shared folder, where Claude Code works. Documents with Claude off sync to a **separate private folder** you choose, outside any repo Claude Code works in. Switching a document off removes its files from the shared folder (after you confirm: the first time the app deletes files) and writes them to the private folder; switching it on moves them back.

### The principle inbox

- A review document that Claude fills with **suggested principles** drawn from your reasoned edits. Each entry has: the principle; base or which genre; the edits behind it (before, after, your reason, a link to the document); how many edits support it; and any overlap with an existing principle, proposed as a rewording of that principle instead.
- **Review actions** per entry: add to the base guide, add to a genre, merge into an existing principle, edit then add, or dismiss. Additions land in the guide as tracked changes. Dismissed ideas are remembered and not suggested again. Your add/merge/dismiss decisions are kept as data too.
- The same pass suggests **links from new reasons to existing principles**, for you to confirm.
- **Input**: reasoned edits from documents that allow Claude (that is, the shared folder only).
- **Runs only when you ask**: you run a Claude Code command (`/suggest-principles`) in the shared folder. The app cannot launch Claude Code itself, so it shows the command with a copy button.
- **The app prepares the input**: each sync it writes a compact digest of reasoned edits since the last run (before/after sentences, reason, document, genre) into the shared folder, so the command reads that rather than op logs. Claude writes its suggestions to an inbox file; the app picks the change up through folder sync and shows the new entries for review.

### Claude as an editor (after the guide has grown)

- Same route: a Claude Code command writes **proposals** next to a document (each quoting the text to change, the replacement, the principle it applies, and a reason). The app turns them into tracked changes by "Claude", anchored by the quoted text so they survive typing in the meantime. You accept or reject; those decisions feed the library and the inbox.
- Only documents that allow Claude are ever touched.

### Measurement (later)

- Once the guide has a few hundred reasoned edits behind it: hold back some of your past edits, have Claude edit the same "before" sentences with the guide, and compare with what you did. This says whether the guide is making Claude edit more like you, and whether a guide change helped.

---

## 10. Phases and milestones

Each phase ends with something usable. Phases 0 and 1 overlap in time.

### Phase 0: Scaffold and writing app (1 week)
- Vite + TypeScript + Svelte 5 + CodeMirror 6 + vitest. ESLint, Prettier. GitHub Actions for lint, test, build, deploy to Pages.
- Markdown editing with syntax highlighting, preview pane (`markdown-it` + DOMPurify), bundled fonts and the settings panel (section 6).
- Autosave of the raw text to IndexedDB, status indicator, multi-document list.
- Done when: it is a pleasant Markdown writing app you would use daily, with no track changes yet.

### Phase 1: Document model (built)
- `src/model/`: types, segmenter, span editing, reconciler, apply/replay, views and offset maps, change and comment helpers, state hash.
- Property tests: random edit, accept and reject sequences replay to the identical state; untracked edits equal plain string edits; accept-all equals the clean text and reject-all the original.
- Editor adapter: every CodeMirror transaction becomes `edit` ops (later changes first so earlier offsets stay valid), with keystroke coalescing into one change id; the model's revision text is checked against the buffer after each transaction.
- Persistence is the op log plus snapshots (section 5). Phase 0 raw-text documents migrate on first open via an `import` op.
- Known gap for phase 2: undo is CodeMirror's buffer undo, which the model sees as a new edit. With tracking on, undoing a tracked deletion must restore the pending state rather than insert text; the adapter will handle undo through the model.

### Phase 2: Track changes (built)
- Tracking toggle (toolbar, ⌘⌥T), insertion and deletion decorations coloured by author, atomic deletion ranges, keystroke coalescing into one change.
- Change cards in a margin aligned to their anchors (pushed apart when they would overlap): author, time, before → after, accept and reject, then the reason row below the buttons so nothing ever shifts them. Reason tag chips are hidden by default (toggle in the margin menu or Settings); the free-text "Why?" field is shown on every card by default (same two places to turn it off, after which a "Why?" button opens it). A second "Why?" field under Accept all and Reject all gives every pending change one shared reason (a group); each card shows it as "Set: …", changes made later are covered when all are accepted or rejected, and the JSONL export carries it as `groupId` and `groupReason`. Accept all and Reject all sit in a bar under the margin header; accept/reject by author is in the margin menu; next/previous change (⌘⌥N, ⌘⌥P); accept/reject the change at the cursor (⌘⌥A, ⌘⌥R); focus its reason (⌘⌥E).
- Markup, clean, and original views; clean and original are read-only.
- Undo and redo through the model (see §4), with ⌘Z, ⌘⇧Z, ⌘Y and toolbar buttons.
- Author name and colour in settings.
- Still to do within this phase, before calling v1 done: the edit pass on a real paper with a second author identity, which needs comments (phase 3) to be a fair test; a per-author filter in the margin; keyboard navigation inside cards.

### Phase 3: Comments (built)
- Select text (or put the cursor in a word) and press ⌘⌥C or the toolbar button: a composer card appears in the margin at the anchor, the range is highlighted, Enter posts. Threads show replies, inline editing of your own comments, resolve and reopen; resolved threads are hidden unless "Show resolved" is on in the margin menu.
- Changes and comments share one margin, in document order. A change card's 💬 opens a thread linked to that change, shown right after it and marked "↳ change".
- Anchors ride through edits, accept, reject, undo and redo via the offset map. A thread whose text is entirely gone becomes orphaned: its card says so and sits at its block's start; undo brings the anchor back.
- Done: comments survive heavy editing around them (property-tested at the model level, exercised in the browser).

### Phase 4: Exports (built)
- Export menu in the toolbar: Markdown clean, Markdown original, Markdown with changes (CriticMarkup, with `{~~old~>new~~}` substitutions and `{==text==}{>>author: comment<<}` threads), Word (.docx, lazy-loaded), JSON (the full document with its op log), and Print / PDF clean or with changes (insertions and deletions inline, comments as footnotes) through the browser's print dialog.
- Word export writes real `w:ins` and `w:del` revisions attributed to their author and time, threaded comments (replies via parent ids, resolved state), headings, bullet and numbered lists that restart per list, Quote and Code styles, tables, rules, and bold, italic, code, strikethrough and links from inline Markdown with the markers dropped.
- Import from the document list: a Markdown or CriticMarkup file becomes a new document (markup becomes pending changes and threads via one `splice` op, so the log stays replayable); a `.shoulder.json` export is checked by replaying its op log and the replayed state wins over the stored one.
- Verified in Node by unzipping the generated .docx and checking the XML, and in the browser by downloading each format and re-importing the CriticMarkup and JSON exports. Still to check by hand: opening the .docx in Word and LibreOffice.

### Phase 5: Library (built)
- Library view (toolbar button or ⌘⌥L): every document with an "In" checkbox (`libraryEligible`), status, comma-separated tags, accepted/rejected/pending counts, reasons, words and last edit; search across titles, tags and text with a snippet for body matches; filters for status and library-only.
- A summary of the library (documents, decided changes, how many have reasons, acceptance rate) and the JSONL export, with options to include pending changes and untracked edits.
- "New documents join the library" sets the per-library default (off by default); it applies to new and imported Markdown documents.
- Metadata edits on documents that are not open go straight to the stored op log as `set_meta` ops with a fresh snapshot.
- Done: the export from a few edited documents is clean enough to hand to a Claude skill; each record isolates one change with its sentence, neighbours, reason and outcome.

### Phase 6: Local folder storage (built)
- "Save to a folder…" in the status bar or Library → Folders; the status bar then shows the folder, or "Reconnect" when the browser needs permission again. Details in §5.
- `src/folder/`: `sync.ts` (the engine: stable names, change detection, browser-wins backups, scan and import), `merge.ts` (text → tracked edit ops via a word-level Myers diff), `fs.ts` (the API surface, so tests use an in-memory folder).
- Verified with unit tests against an in-memory folder, a property test that any target text is reached through tracked edits, and a browser run against a real directory handle from Chromium's origin-private file system: continuous writes, an outside `.md` edit loaded as tracked changes and undone, an op appended by another tool, both sides changing, reconnect on reload, and a fresh browser profile importing the folder.
- Done: a git repo folder stays in sync while writing. This is also the transport phase 7 can use: Claude Code edits the `.md` (arriving as tracked changes) or appends ops to the `.shoulder.json`.
- File names are chosen at the first write and do not follow later title changes, except that files named `untitled` (the folder was connected before the document had a title) are renamed, with any waiting proposals, once the title is set or the text moves past its first line.
- **Layout inside the folder**: `Documents/<name>/` holds one document (`<name>.md`, `<name>.shoulder.json`, waiting proposals, conflict copies, and later an `assets/` folder for images); `Style/Guides/` holds the base and genre guides; `Style/Samples/<Genre>/` is where the user puts examples of their own writing for Claude Code to read, and the app never changes it. The private folder uses the same layout. Documents are not grouped by genre, since a genre can change. Folders written by the earlier flat layout are found on connect and their files moved into place on the next write, with waiting proposals and conflict copies carried along.

### Phase 7: Style guides and genres (built)
- **Guides are documents** with `meta.guide` (`role: base | genre`, an id `prefix`, and `private` for genres). The Library's "Style guides" panel creates or opens the base guide (prefix `B`) and creates genres (prefix from the name, unique, never `B`) with a Private checkbox. A banner over an open guide counts its principles and, when top-level list items have no id yet, offers "Give them ids", one untracked, undoable edit that writes the next free ids.
- **Principle syntax** (`src/guides/principles.ts`): a principle is a top-level list item starting `[ID]`; `[P2 replaces B3]` in a genre guide replaces a base principle for that genre. Nested items and quoted lists are explanation. The id is in the text, so rewording or reordering never breaks a link.
- **Genre and Claude control** in the toolbar: the genre picker, and the Claude switch with three states (genre default, on, off), plus links to the guides. The Library has Genre and Claude columns. Access is `claude` if set; otherwise on without a genre, off if the genre no longer exists, else not private. A private genre's own guide is private too.
- **Two folders**: Library → Folders has the shared folder and a private folder (records under `rec:` and `prec:`, roots `root` and `privateRoot` in the `folder` store). Each document is written only to the folder its access picks; a change of access deletes its files from the other folder after a confirm that names the documents and both folders. Without a private folder, Claude-off documents stay in the browser and Settings says how many.
- **Seeding from a folder**: "Import guides from a folder…" in the Library reads `base.md` and every `<genre>/guide.md` under a picked folder (`src/guides/seed.ts`). A guide the app lacks is created (genre named by the file's first heading, prefix taken from its ids when free); for one it has, only principles it lacks (by id, else by wording) are appended with their indented notes, so a folder can be imported again as it grows. Other files are ignored.
- **Linking**: the § button on a change card opens a filterable list of the document's principles (base plus genre, replacements applied); links are a `set_principles` op on the change record and appear in the JSONL export with each principle's text and the genre.
- Verified with unit tests (parsing, numbering, resolution with replacements, stats and replay of the new ops, moving between folders, private folder records) and a browser run against two directories in Chromium's origin-private file system: guide creation and numbering, a document joining a private genre (files moved after a confirm), a link that survives reload, switching Claude on again, and un-privating a genre.

### Phase 8: The principle inbox
- The inbox document and its review actions; the edits digest the app writes to the shared folder; the `/suggest-principles` Claude Code command (a skill in the repo) and the inbox file format; suggested links from reasons to principles. See §9.

### Phase 9: Claude as an editor (built, ahead of phase 8)
- **Proposals file**: `<name>.proposals.json` next to the document in the shared folder: `{ "document": id, "proposals": [{ "quote", "replacement", "principles", "reason" }] }`. A quote must occur exactly once in the clean text (whitespace runs may differ); the app narrows each proposal to the words that change (`src/folder/proposals.ts`).
- **In the app**: the folder poll finds the file for the open document and shows a banner. "Show as tracked changes" adds one tracked change per proposal by the built-in author "Claude", with the reason set and the principles linked (ids the document's guides do not have are dropped), as a single undo step. Proposals that cannot be placed (missing, repeated, overlapping, or no change) are kept in `<name>.proposals.skipped.json`; the proposals file is removed either way. "Discard" removes it without applying.
- **In Claude Code**: the `propose-edits` skill (`.claude/skills/propose-edits/`) reads the document's `.md` and its base and genre guides, writes the proposals file, and validates it with the bundled `shoulder.mjs check`. It never edits the `.md` or `.shoulder.json`.
- Only looked for in the shared folder, so documents with Claude off are never touched.

### Phase 10: Measurement
- Once the guide has grown: held-out edits, Claude's edits of the same sentences with the guide, side-by-side comparison and a match rate over time. See §9.

### The Mac app (built)
- An Electron shell around the same web build (`electron/`, `pnpm app`, `pnpm app:build`), added so the app can have native menus, remember its folders without permission prompts, and later run Claude Code itself (a browser page cannot). The browser version keeps working unchanged.
- **Menus**: File (new, import, documents, library, sync folder, exports, print), Edit (undo and redo routed to the model, or to the focused text field), View, Changes, Window. Each item sends a command name to the page (`src/app/commands.ts`).
- **Folders**: picked with the system dialog and used through a small file bridge restricted to the picked folders; stored as a path, so they reconnect silently on launch (`src/folder/native.ts`).
- **Storage** is unchanged: documents live in the app's own IndexedDB (served from the fixed origin `app://shoulder`), separate from any browser's. Connecting an existing synced folder brings its documents and guides in. Making the folder the primary store is a separate decision, not yet made.
- **Ask Claude** (Changes menu, or the Claude button): the main process starts the user's own installed Claude Code (`claude -p`, stream-json) in the shared folder to run the `propose-edits` skill on the open document, shows its progress in a small panel, and the proposals then arrive through the normal folder poll. The app holds no credentials and offers no sign-in: it uses whatever account that Claude Code is signed in with, and the feature is unavailable without it. Unattended, Claude Code may only read, write `*.proposals.json`, and run the skill's helper (`electron/claude.mjs`, `electron/claude-events.mjs`). 
- **Chat** (Changes menu, or the Claude button): a panel beside the editor holding one conversation per document, continued across turns with Claude Code's `--resume`. Each turn tells Claude Code where the document and guides are and what it may do: answer without writing anything, write per-edit proposals (the skill above), or, for larger changes, write a complete revised copy to `<name>.revision.md` led by `<!-- reason: … -->`. The app offers a waiting revision in a banner and loads it as tracked changes by Claude: a word-level diff against the current text, with changes fewer than 24 unchanged characters apart joined so a rewritten sentence is one change (added paragraphs stay separate), all sharing the revision's reason as a set reason. The panel has a model menu (`--model`, from a fixed list) shared with Ask Claude, and a button that asks for tracked edits. Conversations are kept only while the app is open.
- Packaged unsigned (ad-hoc) for this machine only; no icon, auto-update, or notarization yet.

### Later, unscheduled
- Word import: plain text first, then revisions and comments.
- Rich (WYSIWYG) mode over the same model.
- Real-time collaboration (the op log is CRDT-friendly in shape, but merging concurrent sentence ops needs design).
- Required reasons mode. Claude-written reasons for human edits.
- Mobile layout.

---

## 11. Testing and quality

- The model is the bulk of the tests: fixtures of Markdown documents, scripted edit sequences, snapshot replays, and property tests with `fast-check`.
- Editor adapter tests run CodeMirror headless in vitest with jsdom.
- A small Playwright suite for the happy path: write, track, comment, accept, export, reload and find everything still there.
- Every exported JSON validates against `schema.json`. The schema is versioned; migrations are functions in `src/model/migrate.ts`.
- CI blocks merge on lint, type check, and tests.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Sentence id stability feels wrong in edge cases (abbreviations, lists, code) | Keep the reconciler small and heavily tested; fall back to block-level anchoring when a sentence cannot be matched; never lose a comment, only orphan it |
| Deletions-in-buffer makes cursor movement feel odd | Match Word's behavior exactly and provide "hide deletions" as a setting that keeps them in the model but out of the buffer |
| DOCX fidelity (nested lists, tables, code) | Start with headings, paragraphs, simple lists; table and code support follow; verify in Word and LibreOffice |
| Long documents slow down | Segment and reconcile only affected blocks; snapshots keep load fast; measure with a 50k-word fixture |
| IndexedDB eviction | Request persistent storage; show quota; make "Export JSON" one click; folder storage in phase 6 removes the dependency |
| Scope creep toward WYSIWYG | The source editor is the v1 contract; rich mode is explicitly later |

---

## 13. Decisions log

Settled on 2026-10-05, after the first draft of this plan:

1. UI framework: Svelte 5.
2. Fonts: ship the full list in section 6.
3. Edits made with tracking off get a `changeId` and appear in history as auto-accepted changes, but do not show in the margin.
4. Comment anchors may span sentences: an anchor is a list of sentence ids with a range in the first and last.
5. `libraryEligible` defaults to off per document, with a per-library default that can be flipped.
6. Name stays `shoulder-md`.

Resolved after phase 6:

- Deleting another author's pending insertion used to turn it into a plain deletion, losing the insertion, so "Original" view and reject-all showed text that was never in the original. Spans now carry both marks (see §4). Property tests with three authors check that accept-all gives the clean text, reject-all gives the original, and any mix of decisions gives the same text in any order. CriticMarkup writes such text as `{--{++text++}--}`, Word export nests `w:del` inside `w:ins`, and a change whose marks all disappear with another decision (a deletion of an insertion that was rejected) no longer counts as pending.

Settled on 2026-10-06, planning phases 7 to 10 (details in §9):

7. Style guides: one base guide plus genre add-ons; each document picks a genre.
8. Reasons stay free text while editing; principles are linked afterwards, suggested by Claude and confirmed by you.
9. Claude access is per document, defaulting from the genre: on by default, and genres can be private (off by default).
10. Documents with Claude off sync to a separate private folder; switching off removes their files from the shared folder, after confirmation.
11. A principle inbox collects Claude's suggested principles for review; it learns from reasoned edits in documents that allow Claude.
12. The inbox runs only when you ask.
13. Transport: Claude Code on the synced folder, on your existing plan. No separate API key or API billing for now.
14. Measurement comes after the guide has grown.
