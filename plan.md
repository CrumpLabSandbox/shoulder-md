# shoulder-md: Plan

A browser-based Markdown editor with Word-style tracked changes and comments, built on a structured JSON layer that records every edit and the reason for it. Exports to Markdown, Word, PDF, or the full JSON. Over time, a library of edited documents whose history can teach Claude to edit the way this writer edits.

Status: planning. Nothing is built yet. This document is the spec for v1 and the roadmap after it.

---

## 1. Decisions made

These were settled in the planning conversation on 2026-10-05.

| Decision | Choice | Notes |
|---|---|---|
| Editing surface | Raw Markdown source with inline change marks and a toggleable rendered preview | Markdown stays the truth. No WYSIWYG in v1. |
| Storage | Browser storage (IndexedDB) first; local folder on disk (File System Access API) as a later phase | Constant background save is a hard requirement. |
| Claude as editor | Phase 2, after the manual editor works | Human author and human editor first. |
| Change anchoring | Sentences with stable ids; changes record a character range within a sentence | Split and merge are explicit operations. |
| Stack | Vite + TypeScript + CodeMirror 6 + Svelte 5 | Svelte chosen over React for a small, fast app with little boilerplate. Swappable for React before phase 1 ends if preferred. |
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

Every op has `id`, `changeId`, `author`, `ts`, and optional `reason` and `reasonTags`. Ops in the same `changeId` are one tracked change in the UI.

| Op | Payload | Effect |
|---|---|---|
| `insert` | sentenceId, offset (clean coords), text | Add an `ins` span, or plain `text` if tracking is off |
| `delete` | sentenceId, from, to (clean coords) | Convert the range to `del` spans; if the range is inside this author's own pending `ins`, remove it outright (Word behavior) |
| `split_sentence` | sentenceId, offset, newId | Second sentence gets `newId` |
| `merge_sentence` | sentenceId, nextId | Next sentence's spans append to this one; `nextId` retires |
| `insert_block` | afterBlockId, block | New block with new ids |
| `delete_block` | blockId | Block marked deleted (its sentences become all-`del`) |
| `set_block` | blockId, kind, attrs | Heading level, list type, etc. |
| `move_block` | blockId, afterBlockId | Reorder |
| `accept` | changeId | `ins` → `text`; `del` spans removed |
| `reject` | changeId | `ins` spans removed; `del` → `text` |
| `set_reason` | changeId, reason, reasonTags | Attach or edit a reason |
| `comment_add` | threadId, anchor, body | Anchor: sentenceId(s) + range in clean coords |
| `comment_reply` | threadId, body | |
| `comment_edit` | threadId, commentId, body | |
| `comment_resolve` / `comment_reopen` | threadId | |
| `set_tracking` | on | Recorded so history shows when tracking was off |
| `set_meta` | title, tags, status, libraryEligible | |

Replay is deterministic: `apply(apply(empty, ops[0]), ops[1]) ...` must yield `state`. Tests assert this on every fixture and on randomly generated edit sequences.

### Sentence segmentation

Block segmentation uses a small CommonMark block parser (the `mdast` tree from `micromark`/`mdast-util-from-markdown` is enough; we only need block boundaries and kinds, plus inline text for sentence splitting).

Sentence splitting runs on each paragraph-like block's clean text:

- `Intl.Segmenter('en', { granularity: 'sentence' })` where available, with a fallback rule-based splitter.
- Post-rules: do not split on abbreviations (e.g., i.e., Dr., Fig.), inside inline code, inside links, or after a number followed by a period at line start. Keep trailing whitespace with the sentence it follows.
- Headings and list items are usually one sentence but can be several.
- Code, tables, HTML blocks, and thematic breaks are a single sentence each. No splitting.

### Id stability (the hard part)

The editor is a free-form text buffer. The user can type anything anywhere, including a period that splits a sentence or a backspace that merges two. The reconciler turns a CodeMirror text change into model ops while keeping ids stable:

1. Map the change's `from`/`to` from revision coordinates to the affected block(s) and sentence(s).
2. If the change stays inside one sentence and introduces no sentence or block boundary, emit `insert`/`delete` on that sentence. Done. This is the 95% path.
3. Otherwise, re-segment the affected block(s) only. Match new sentences to old by a greedy alignment on clean text (longest common overlap, then position). Each matched sentence keeps its id. Unmatched old sentences retire; unmatched new ones get fresh ids. Boundary changes become explicit `split_sentence` / `merge_sentence` ops, so the log says what happened rather than leaving it to be inferred.
4. A paragraph break inside a sentence becomes `split_sentence` plus `insert_block`; deleting a paragraph break is the reverse.

Rule of thumb: the sentence that keeps the majority of its original characters keeps its id. Comments and reasons anchored to a sentence survive as long as that sentence does. A comment whose anchor range vanishes is marked `orphaned`, shown at the block level, never deleted.

### Tracked-change text in the editor buffer

The CodeMirror document is the **revision text**, which includes pending deletions. Deletions are marked as atomic read-only ranges, so the cursor skips over them and typing cannot land inside. This is the same trick Word uses on screen and it keeps the buffer a simple string. Insertions are ordinary editable text with a mark decoration.

Consequences:

- Backspacing onto a pending deletion skips it; backspacing onto someone else's insertion deletes it as a tracked deletion; backspacing onto your own insertion removes it outright.
- Search, cursor movement, and selection work on the revision text. Preview and exports work on clean text via the offset maps.

---

## 5. Autosave and persistence

Requirement: changes are saved consistently behind the scenes, with no save button, and a crash or closed tab loses almost nothing.

Design: the op log is append-only, so saving means appending new ops. Each op is tiny. This makes continuous save cheap and robust.

- **Op append**: every editor transaction produces ops that are queued and written to the IndexedDB `ops` store within ~250 ms (debounced). The write is a single transaction per batch.
- **Flush points**: on `blur`, `visibilitychange` to hidden, `pagehide`, and `beforeunload`, the queue is flushed synchronously as far as the browser allows.
- **Snapshots**: a materialized `state` snapshot is written every N ops (say 200) or 30 s of activity, whichever first, and on document close. Load = latest snapshot + replay of ops after it, so opening a long document stays fast.
- **Integrity**: on load, the replayed state's hash is compared with the snapshot hash. A mismatch triggers full replay and logs a model bug.
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
| JSON | The full `Document`, validated against `schema.json` | `JSON.stringify` with a stable key order |
| Word (.docx) | Real tracked changes and comments | The `docx` npm package: `InsertedTextRun`, `DeletedTextRun`, `CommentRangeStart/End`, `CommentReference`, author and date per revision. Markdown block kinds map to Word styles (Heading 1–6, List Paragraph, Quote, code in a monospace style) |
| PDF | Clean or markup view | Print stylesheet and `window.print()` in v1. Margin comments render as footnotes in print |
| Library export | JSONL of change records for training | See section 8 |

Export of the current document is a single menu. Export of the whole library is from the library view.

---

## 8. The edits library

A library is a collection of documents, each carrying its full history. In v1 it lives in IndexedDB.

- Library view: list with title, status, tags, last edited, counts of pending/accepted/rejected changes, search by title and text.
- Per document: `libraryEligible` flag, default off. Only eligible documents appear in library exports. This is the privacy gate.
- **Change record export** (JSONL), one row per tracked change:

```json
{
  "docId": "...", "changeId": "...", "author": "matt",
  "blockKind": "paragraph",
  "before": "The results was significant.",
  "after": "The results were significant.",
  "contextBefore": "…previous sentence…", "contextAfter": "…next sentence…",
  "reasonTags": ["grammar"], "reason": "subject-verb agreement",
  "outcome": "accepted", "decidedBy": "matt", "ts": "2026-10-05T…"
}
```

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

### Phase 1: Document model (1 to 2 weeks)
- `src/model/`: types, segmenter, reconciler, apply/replay, views and offset maps.
- Property tests: random edit sequences replay to the same state; ids stable under in-sentence edits; split/merge produce the expected ops.
- Editor adapter: every CodeMirror transaction becomes ops; the model's revision text matches the buffer at all times.
- Persistence switches from raw text to the op log plus snapshots (section 5).
- Done when: documents written in phase 0 migrate, and the model survives a fuzz test.

### Phase 2: Track changes (1 to 2 weeks)
- Tracking toggle, insertion and deletion decorations, atomic deletion ranges, keystroke coalescing.
- Change cards in the margin, accept/reject (one, by author, all), next/previous change.
- Markup, clean, and original views.
- Reasons: pick-list plus free text, from the card and from a shortcut.
- Done when: a full edit pass on a real paper with a second author identity reads correctly in all three views.

### Phase 3: Comments (1 week)
- Select-and-comment, threads with replies, resolve/reopen, margin alignment, orphan handling.
- Link a reason to a comment thread when the reason needs discussion.
- Done when: comments survive heavy editing around them.

### Phase 4: Exports (1 week)
- Markdown clean/original/CriticMarkup, JSON with schema validation, DOCX with real revisions and comments, PDF via print.
- CriticMarkup import.
- Done when: a .docx opened in Word shows the same changes and comments as the editor.

### Phase 5: Library (1 week)
- Library view, tags, status, search, `libraryEligible`, JSONL change-record export.
- Done when: an exported JSONL from a few edited documents is something you would hand to a Claude skill.

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

## 13. Open questions

Not blocking, but worth settling before the relevant phase.

1. Svelte 5 is my pick. Confirm, or switch to React before phase 1 ends.
2. Which of the bundled fonts to actually ship. Eight is a lot; four might do: Source Serif 4, Source Sans 3, JetBrains Mono, iA Writer Duo.
3. Should "tracking off" edits still get `changeId`s and show in history as auto-accepted changes, or be invisible in the margin? I lean toward visible in history, hidden in the margin.
4. Comment anchors across sentence boundaries: allow (anchor to a list of sentence ids) or clamp to one sentence. I lean toward allow.
5. Default `libraryEligible`: off per document, with a per-library default you can flip.
6. Name: keep `shoulder-md` (an editor looking over your shoulder) or rename when there is a UI.
7. Phase 7 transport: browser API key, local proxy, or Claude Code via folder storage. Decide once phase 6 exists.
