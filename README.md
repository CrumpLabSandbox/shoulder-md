# shoulder-md

A browser-based Markdown editor that is growing Word-style tracked changes and comments on top of a structured JSON layer that records every edit and the reason for it. See [plan.md](plan.md) for the full design and roadmap, and [idea.json](idea.json) for the seed.

## Status

Phases 0 to 7 of the plan: a Markdown writing app with Word-style tracked changes and comments, on a sentence-level document model and op log, with exports, an edits library, sync to a local folder, and style guides with a per-document Claude switch.

- CodeMirror 6 editor with Markdown highlighting and a rendered preview (editor, split, or preview layouts).
- Background autosave to the browser's IndexedDB on every change, with flushes on blur, tab hide, and unload.
- Several documents, with a document list.
- Bundled open-source fonts (Source Serif 4, Literata, Source Sans 3, Inter, JetBrains Mono, iA Writer Mono, Duo, and Quattro), size, line height, text width, light, dark, sepia and system themes, and presets.
- Every edit is recorded as an operation against a document model of blocks, sentences and spans (`src/model/`), with ids that survive editing. Documents are stored as an append-only op log plus periodic snapshots, so nothing about the editing history is lost.
- Track changes: turn it on and deletions stay struck through, insertions are underlined, and each change gets a card in the margin with author, time, before and after text, accept and reject, and an optional reason (free text, plus tag chips you can switch on in Settings). Accept all and Reject all sit at the top of the margin. Markup, clean, and original views. Undo and redo work on changes, not just text.
- Comments: select text and press ⌘⌥C to open a thread in the margin, with replies, resolve and reopen, and threads attached to a change. Anchors follow the text through edits and undo; a thread whose text is removed is kept and marked as orphaned.
- Exports: Markdown (clean, original, or with changes as CriticMarkup), Word with real tracked changes and threaded comments, the full JSON with its op log, and PDF through the print dialog. Markdown, CriticMarkup, and JSON files import as new documents.
- Library (⌘⌥L): choose which documents join the edits library, set their status and tags, search them, and export every change as JSON lines with its sentence before and after, neighbouring sentences, reason, discussion, and whether it was accepted or rejected. Nothing joins the library unless you include it.
- Folder sync (Chrome and Edge): "Save to a folder…" in the status bar mirrors every document into a folder, such as a git repo, as `.md` and `.shoulder.json`, about a second after each save. Edits made to those files by other tools come back as tracked changes you can accept or reject; if both sides changed, your version wins and the disk version is kept as a `.conflict-` file.

- Style guides: a base guide plus genre guides (Library → Style guides), where each top-level list item is a principle with a stable id like `[B4]`; "Give them ids" numbers new ones. "Import guides from a folder…" loads `base.md` and one `guide.md` per genre folder, creating guides or adding the principles an existing guide lacks. Each document picks a genre, and a change card's § button links the change to the principles behind it.
- The Claude switch (toolbar): each document allows Claude or not, by default from its genre (genres can be private). Documents that allow Claude sync to the shared folder, where Claude Code works; the rest sync only to a separate private folder (Library → Folders). Changing access moves the files, after asking.

- Claude as an editor: in Claude Code, ask for edits to a document in the shared folder (the `propose-edits` skill). Claude writes a proposals file beside it; the app offers them as tracked changes by "Claude", each with a reason and the principle it applies, for you to accept or reject.

## Mac app

The same app runs in its own window with Mac menus and direct folder access (no permission prompts):

```sh
pnpm app          # build and run
pnpm app:build    # package release/mac-arm64/Shoulder.app
```

### Asking Claude from inside the Mac app

Changes → Ask Claude to Suggest Edits… (or the Claude button in the toolbar) has Claude Code read the open document and its style guides and propose edits, which arrive as tracked changes.

- This runs **your own Claude Code**. The app starts the `claude` program already installed on your Mac, in your shared folder. It signs nobody in, stores no credentials, and has no API key; it uses whatever account your Claude Code is signed in with, and that account's usage.
- If Claude Code is not installed and signed in (`claude` in a terminal), the feature is unavailable and the app says so. Everything else works without it.
- Claude Code is allowed to read the folder, write `*.proposals.json` files, and run the skill's helper script. Nothing else is permitted while it runs unattended.
- The app copies the `propose-edits` skill into `.claude/skills/` inside your shared folder.

The Mac app keeps its documents in its own storage, separate from any browser. To bring existing work in, choose your synced folder with File → Choose Shared Folder…; the documents and guides in it are added. Use either the browser or the Mac app on a given folder, not both at once.

Next: a principle inbox that Claude Code fills from your reasoned edits, run through Claude Code on the shared folder (no API key).

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
| ⌘⌥L                | Open or close the library                |
| ⌘Z / ⌘⇧Z           | Undo / redo (through the model)          |

## License

MIT. Bundled fonts are under the SIL Open Font License.
