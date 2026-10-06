# shoulder-md

A browser Markdown editor with Word-style tracked changes and comments, built on a sentence-level JSON model that records every edit and its reason. `plan.md` is the spec and roadmap; read its status line and the current phase before starting work. `idea.json` is the original seed.

Status: phases 0–6 are built (editor, model and op log, tracked changes, comments, exports, edits library, folder sync), plus nested insert/delete marks. Next is phase 7, Claude as editor (see `plan.md` §9 and §10).

## Commands

```sh
pnpm install      # Node 22+. If pnpm is missing: corepack enable
pnpm dev          # http://localhost:5173
pnpm test         # vitest (jsdom, fake-indexeddb); includes fast-check property tests
pnpm check        # svelte-check (types)
pnpm lint         # eslint + prettier --check
pnpm format       # prettier --write
pnpm build        # static site in dist/
```

Run `pnpm format && pnpm lint && pnpm check && pnpm test && pnpm build` before every commit. All five must be clean.

## Architecture

Stack: Vite, TypeScript (strict, `noUncheckedIndexedAccess`), Svelte 5 runes, CodeMirror 6, IndexedDB via `idb`. No server.

```
src/model/     Pure TS document model, no DOM. Most correctness lives here.
src/editor/    CodeMirror setup, tracking extension, buffer sync.
src/docs/      workspace.svelte.ts: the app's reactive store and all editing commands.
src/persist/   IndexedDB op log + snapshots; debounced autosave.
src/export/    Markdown/CriticMarkup, JSON (+ schema.json), docx, print/PDF.
src/library/   Change-record dataset (records.ts) and per-document stats (stats.ts).
src/folder/    Folder sync engine (sync.ts), text → tracked edits (merge.ts), File System Access surface (fs.ts).
src/ui/        Svelte components. App.svelte wires shortcuts and layout.
src/settings/  Fonts catalog and appearance settings (localStorage).
tests/         vitest. tests/helpers/model.ts is the model test harness.
```

### The model (read before touching `src/model/`)

- A document is blocks → sentences → spans. Spans are `text`, `ins`, or `del`. Concatenating all spans gives the **revision text**, which is exactly what the CodeMirror buffer holds (pending deletions included).
- Three views derive from spans: revision (all), clean (no `del`), original (no `ins`).
- **Structure is always re-derived.** After any text op, `reconcile()` re-segments the whole revision text (Lezer Markdown for blocks, `Intl.Segmenter` plus merge rules for sentences) and reassigns ids by character overlap. Inserted text carries no origin tag and does not vote. There are no block or sentence ops.
- **The op log is the truth.** `state` is a cache that must equal `replay(ops)`. Fresh ids are recorded on each op (`alloc`) so replay is deterministic; replay must never call the id generator. The property tests enforce this.
- One text primitive: `edit` (sentence-relative positions). Also `import`, `accept`, `reject`, `splice`, `set_reason`, comment ops, `set_tracking`, `set_meta`.
- **Every text op returns its inverse** as `splice` ops. Undo/redo run through the model, not CodeMirror history. Do not reintroduce CodeMirror's `history()`.
- Comment anchors are carried through each op by an `OffsetMap`. A thread whose text vanishes becomes orphaned (`anchor: null`, `orphanedFrom` kept) and re-anchors if undo brings the sentences back. Never delete threads.
- Tracked deletions keep text in place; an author deleting their own pending insertion removes it outright (Word behaviour). Deleting **another** author's pending insertion gives a `del` span with `inserted: { changeId, author }`, so both marks survive.
- **Every accept/reject decision goes through `resolveSpan`** (`src/model/spans.ts`): the model, buffer sync, the dataset's before/after sentences, and anything new must use it rather than re-deriving rules from `kind`. A span can belong to two changes; use `changeIdsOf(span)` and copy marks with `marksOf(span)` so `inserted` is never dropped.

### Editor ↔ model

- `editor/tracking.ts` has a transaction filter that, while tracking is on, rewrites user edits so deleted text stays in the buffer, and records the user's original change in a `userIntent` annotation. The adapter turns that intent into `edit` ops.
- Changes that come from the model (accept, reject, undo, imports) are dispatched with the `fromModel` annotation; the filter and adapter ignore them. `editor/sync.ts#bufferChangesFor` computes the buffer change for any op.
- After each user transaction the workspace checks model revision text == buffer text. A mismatch is logged as a bug and resynced with an `import` op. If you see that error, it is a real model bug: reproduce it in a test.

### Persistence

IndexedDB v3: `docs` (header + hashed snapshot), `ops` (keyed `[docId, seq]`), and `folder` (the folder handle, file records, tombstones). Load = snapshot + tail replay; a bad hash triggers a full replay. Phase 0 raw-text docs migrate via an `import` op. Snapshots every 200 ops / 30 s and when a document is closed.

## Conventions and gotchas

- **Svelte proxies break IndexedDB.** Anything stored must be plain data. The workspace uses `$state.raw` for documents and JSON-clones every op in `push()`. Keep it that way.
- ESLint's `svelte/prefer-svelte-reactivity` flags `new Date`, `new Set`, `new Map` in `.svelte.ts` files. Use helpers in `src/util/time.ts`, arrays, or plain objects.
- Ops from the UI go through `workspace.push()`; never call `applyOp` on workspace state directly.
- Keyboard: ⌘⌥ chords are matched on `e.code` (Alt changes `e.key` on some layouts). Undo/redo keys are handled in a `keydown` DOM handler, not the keymap.
- Prettier formats `.svelte` files and reflows code; do not assume an exact earlier layout when patching a file by string match.
- `plan.md` and `idea.json` are excluded from Prettier on purpose.
- Folder writes are debounced per document and `park()` flushes them before switching documents. Only raise an outside-change prompt when the browser has not moved on since the copy being written; otherwise the next write applies browser-wins.
- Opening IndexedDB by hand in tests: `openDB('shoulder-md')` with no version, so tests keep working when the schema version goes up.
- The `.docx` exporter is dynamically imported so it stays out of the main bundle.
- Commit messages: imperative summary line, a body explaining what and why. Update `plan.md` (status line and the phase entry) and `README.md` when a phase lands.

## Testing

- Model changes need unit tests in `tests/model.test.ts` and, for anything structural, a property in `tests/model.property.test.ts` (replay equality, inverse round-trip, untracked edits = string edits, accept-all = clean, reject-all = original).
- Use `harness()` from `tests/helpers/model.ts`: it gives `edit(from, to, insert, opts)` at absolute revision offsets, `accept`/`reject`, `op()`, `inverse`, `applyOps()`, and the three texts.
- Editor behaviour is tested headless with `EditorState.update` (`tests/tracking.test.ts`).
- Word export is tested by unzipping with JSZip and checking the XML (`tests/export-docx.test.ts`).
- Folder sync is tested against `tests/helpers/memfs.ts` (an in-memory folder). In the browser, stub the picker with `ctx.addInitScript(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('repo', { create: true }); })` to get a real handle from Chromium's private file system.
- For a real-browser check, build, run `pnpm vite preview --port 4173`, and drive it with `playwright-core`. Scripts must live inside the repo to resolve the package (ESM ignores `NODE_PATH`); use a throwaway `.smoke/` directory and delete it after. Wait for the status bar to read "Saved" before reloading.
