# shoulder-md

A browser-based Markdown editor that is growing Word-style tracked changes and comments on top of a structured JSON layer that records every edit and the reason for it. See [plan.md](plan.md) for the full design and roadmap, and [idea.json](idea.json) for the seed.

## Status

Phases 0 and 1 of the plan: a quiet Markdown writing app, with the sentence-level document model and op log underneath.

- CodeMirror 6 editor with Markdown highlighting and a rendered preview (editor, split, or preview layouts).
- Background autosave to the browser's IndexedDB on every change, with flushes on blur, tab hide, and unload.
- Several documents, with a document list.
- Bundled open-source fonts (Source Serif 4, Literata, Source Sans 3, Inter, JetBrains Mono, iA Writer Mono, Duo, and Quattro), size, line height, text width, light, dark, sepia and system themes, and presets.
- Every edit is recorded as an operation against a document model of blocks, sentences and spans (`src/model/`), with ids that survive editing. Documents are stored as an append-only op log plus periodic snapshots, so nothing about the editing history is lost.

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

| Keys               | Action            |
| ------------------ | ----------------- |
| ⌘E / Ctrl+E        | Toggle preview    |
| ⌘⇧E / Ctrl+Shift+E | Toggle split view |
| ⌘, / Ctrl+,        | Settings          |
| ⌘⇧D / Ctrl+Shift+D | Documents list    |
| ⌘N / Ctrl+N        | New document      |
| ⌘F / Ctrl+F        | Find and replace  |

## License

MIT. Bundled fonts are under the SIL Open Font License.
