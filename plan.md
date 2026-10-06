# shoulder-md: Plan

A browser-based Markdown editor with Word-style tracked changes and comments, built on a structured JSON layer that records every edit and the reason for it. Exports to Markdown, Word, PDF, or the full JSON. Over time, a library of edited documents whose history can teach Claude to edit the way this writer edits.

Status: phases 0 to 5 built (writing app with autosave, fonts and preview; sentence-level model and op log; Word-style tracked changes with reasons, accept/reject, views, and model-level undo; comment threads in the same margin; exports to Markdown, CriticMarkup, Word, JSON and PDF, with CriticMarkup and JSON import; the edits library with its JSONL change-record export). This document is the spec for v1 and the roadmap after it.

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
  | { kind: 'del'; text: string; changeId: string };         // pending deletion
```

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
| `edit` | changeId, from, to (positions: sentenceId + offset in that sentence's revision text), insert, tracked | The one text primitive. Tracked: plain text in the range becomes `del`, the author's own pending `ins` in the range vanishes outright (Word behavior), another author's `ins` becomes `del`, and the insertion becomes `ins`. Untracked: the range is removed and the insertion is plain text |
| `accept` | changeIds | `ins` → text; `del` spans removed |
| `reject` | changeIds | `ins` spans removed; `del` → text |
| `splice` | from, to (absolute revision offsets), spans, records? | Raw replacement of a range with the given spans, marks included, then restore the given change records. The inverse of every other text op; how undo and redo are logged |
| `set_reason` | changeId, reason, reasonTags | Attach or edit a reason |
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
- **Flush points**: on `blur`, `visibilitychange` to hidden, `pagehide`, and `beforeunload`, the queue is flushed synchronously as far as the browser allows.
- **Snapshots**: the document header in the `docs` store carries a materialized `state` snapshot, rewritten every 200 ops or 30 s of activity, whichever first, and when the document is closed or switched. Load = snapshot + replay of ops after it, so opening a long document stays fast.
- **Integrity**: the snapshot carries a hash of its state. On load a mismatch triggers a full replay from the op log and a console warning. In the editor, after every transaction the model's revision text is compared with the buffer; a mismatch is logged as a bug and the model resyncs from the buffer with an `import` op.
- **Status indicator**: "Saved", "Saving…", or "Unsaved changes (n)" in the status bar. Error state if IndexedDB fails, with an immediate "Download JSON" escape hatch.
- **Multi-tab**: a `BroadcastChannel` lock per document. A second tab opening the same document gets it read-only with a "Take over" button.
- **Named versions**: the user can name the current point ("sent to reviewer"). This is a `set_meta`-style marker op; nothing is copied.
- **Storage quota**: request `navigator.storage.persist()` and show usage in settings.
- **Later, local folder**: with the File System Access API the same debounced writer also writes `<title>.md` (clean text) and `<title>.shoulder.json` (full document) into a chosen folder, so a git repo and Claude Code see current files at all times. Writes go through a temp file and rename where possible. Conflict rule: the browser copy wins unless the file on disk changed and the browser did not, in which case the user is asked.

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

## 9. Claude as an editor (phase 2)

Build after the manual editor is solid, because the data model and accept/reject flow are what make Claude's edits useful.

- **Input**: the clean text as a list of `{sentenceId, text}` per block, plus the user's instruction ("tighten this", "copy-edit", "check for jargon"), plus optional style guide text derived from the library.
- **Output**: a JSON array of proposed changes: `{sentenceId, from, to, replacement, reasonTags, reason}`. Validated, then applied as tracked changes with author `claude`. The user accepts or rejects each one. Those decisions become library records.
- **Scope**: whole document, selection, or one sentence.
- **Transport options**, choose one in phase 2:
  1. Direct from the browser with an API key stored locally (fastest to build).
  2. A tiny local Node proxy that holds the key.
  3. Claude Code reading and writing the `.shoulder.json` file in the local folder, which is the most natural fit once folder storage exists: a skill emits ops and the editor picks them up.
- **Secondary features**: "Explain this change" for a human change with no reason, draft replies in comment threads, a per-document summary of what was edited and why.
- **Evaluation**: the acceptance rate of Claude's changes by reason tag over time, computed from the library.

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
- Change cards in a margin aligned to their anchors (pushed apart when they would overlap): author, time, before → after, accept and reject, then the reason row below the buttons so nothing ever shifts them. Reason tag chips are hidden by default (toggle in the margin menu or Settings); with them hidden, "Why?" opens a free-text reason. Accept all and Reject all sit in a bar under the margin header; accept/reject by author is in the margin menu; next/previous change (⌘⌥N, ⌘⌥P); accept/reject the change at the cursor (⌘⌥A, ⌘⌥R); focus its reason (⌘⌥E).
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

### Phase 6: Local folder storage (1 week)
- File System Access API, `.md` plus `.shoulder.json` written continuously, reconnect on reload, conflict rule.
- Done when: a git repo folder stays in sync while writing.

### Phase 7: Claude as editor (2 weeks)
- Section 9. Pick a transport, build proposal → tracked changes, evaluation view.

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

Still open:

- Phase 7 transport: browser API key, local proxy, or Claude Code via folder storage. Decide once phase 6 exists.
