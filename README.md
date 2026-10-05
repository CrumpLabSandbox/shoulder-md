# shoulder-md

A browser-based Markdown editor that is growing Word-style tracked changes and comments on top of a structured JSON layer that records every edit and the reason for it. See [plan.md](plan.md) for the full design and roadmap, and [idea.json](idea.json) for the seed.

## Status

Phase 0 of the plan: a quiet Markdown writing app.

- CodeMirror 6 editor with Markdown highlighting and a rendered preview (editor, split, or preview layouts).
- Background autosave to the browser's IndexedDB on every change, with flushes on blur, tab hide, and unload.
- Several documents, with a document list.
- Bundled open-source fonts (Source Serif 4, Literata, Source Sans 3, Inter, JetBrains Mono, iA Writer Mono, Duo, and Quattro), size, line height, text width, light, dark, sepia and system themes, and presets.

Tracked changes, comments, exports, the edits library, and Claude as an editor come in later phases.

## Develop

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
