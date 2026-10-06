# shoulder-md

A browser-based Markdown editor that is growing Word-style tracked changes and comments on top of a structured JSON layer that records every edit and the reason for it. See [plan.md](plan.md) for the full design and roadmap, and [idea.json](idea.json) for the seed.

## Status

Phases 0 to 4 of the plan: a Markdown writing app with Word-style tracked changes and comments, on a sentence-level document model and op log, with exports.

- CodeMirror 6 editor with Markdown highlighting and a rendered preview (editor, split, or preview layouts).
- Background autosave to the browser's IndexedDB on every change, with flushes on blur, tab hide, and unload.
- Several documents, with a document list.
- Bundled open-source fonts (Source Serif 4, Literata, Source Sans 3, Inter, JetBrains Mono, iA Writer Mono, Duo, and Quattro), size, line height, text width, light, dark, sepia and system themes, and presets.
- Every edit is recorded as an operation against a document model of blocks, sentences and spans (`src/model/`), with ids that survive editing. Documents are stored as an append-only op log plus periodic snapshots, so nothing about the editing history is lost.
- Track changes: turn it on and deletions stay struck through, insertions are underlined, and each change gets a card in the margin with author, time, before and after text, accept and reject, and an optional reason (free text, plus tag chips you can switch on in Settings). Accept all and Reject all sit at the top of the margin. Markup, clean, and original views. Undo and redo work on changes, not just text.
- Comments: select text and press ⌘⌥C to open a thread in the margin, with replies, resolve and reopen, and threads attached to a change. Anchors follow the text through edits and undo; a thread whose text is removed is kept and marked as orphaned.
- Exports: Markdown (clean, original, or with changes as CriticMarkup), Word with real tracked changes and threaded comments, the full JSON with its op log, and PDF through the print dialog. Markdown, CriticMarkup, and JSON files import as new documents.

Tracked changes, comments, exports, the edits library, and Claude as an editor come in later phases.

## Develop

Requires Node 22 or newer. The project uses pnpm; if it is not installed, `corepack enable` (bundled with Node) sets it up, or run `npm install -g pnpm`. Plain `npm install` and `npm run dev` also work.

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # vitest
pnpm check      # svelte-check
pnpm lint       # eslint + prettier
pnpm build      # static site in dist/
```

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml`.

## Shortcuts

| Keys               | Action                                   |
| ------------------ | ---------------------------------------- |
| ⌘E / Ctrl+E        | Toggle preview                           |
| ⌘⇧E / Ctrl+Shift+E | Toggle split view                        |
| ⌘, / Ctrl+,        | Settings                                 |
| ⌘⇧D / Ctrl+Shift+D | Documents list                           |
| ⌘N / Ctrl+N        | New document                             |
| ⌘F / Ctrl+F        | Find and replace                         |
| ⌘⌥T                | Toggle track changes                     |
| ⌘⌥A / ⌘⌥R          | Accept / reject the change at the cursor |
| ⌘⌥N / ⌘⌥P          | Next / previous change                   |
| ⌘⌥E                | Add a reason to the change at the cursor |
| ⌘⌥C                | Comment on the selection                 |
| ⌘⌥M                | Show or hide the margin                  |
| ⌘Z / ⌘⇧Z           | Undo / redo (through the model)          |

## License

MIT. Bundled fonts are under the SIL Open Font License.
