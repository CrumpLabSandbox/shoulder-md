# Welcome to shoulder

By Matt Crump

> **The web version is a demo.** The [browser version](https://crumplabsandbox.github.io/shoulder-md/) is there to try the editor. It is missing features of the Mac app, such as the Ask Claude and chat panels, which need Claude Code on your own machine. For the full app, build it from this repository (see [Mac app](#mac-app)).

This is a markdown editor with tracked changes and more. It is also a personal experimental tool, built primarily with Claude Code, that may involve breaking changes across iterations.

## Reasons around my writing

In my own writing and editing, I have found it useful to justify my sentences and word choices. For every part of a paper, I should be able to articulate why I chose the order of paragraphs I did, or within a paragraph, what I want each sentence "to do". I'm not always successful in this kind of meta-writing exercise, but it has helped me get clearer about what I'm trying to accomplish in writing and thinking. It often helps me identify problems in my writing that need to be fixed. If I can't give myself a good reason for a writing choice, then I think I should probably rewrite that part until it has a reason for being.

For the most part I don't record the mental dialogue (peanut gallery in my head) that occurs throughout writing and editing. Building this app is partly a suggestion to myself to preserve some of my editorial thoughts alongside my writing.

## Reasons for changes and a document memory

So, in addition to being able to track changes in a markdown editor, this app allows one to enter reasons for the changes. In the background, a structured JSON file records the construction of the whole document: what was written, all associated changes, and reasons for those changes.

## Claude tools

This app is also a personal experiment in using Claude-type tools for specific writing tasks, particularly around spell-checking, line-editing, and personal style choices.

In 2023, I messed around a bit with gpt for editing my writing, particularly as a spell-checker and for finding missing words that normal spell-checkers can't find. It worked OK.

<https://www.crumplab.com/blog/665_realworld_editing/index.html>

In this app, there are a few more possibilities. Some are:

1. Create documents that record my own reasons for sentence changes, then use them as a training set so that a tool like Claude can take a pass as a line editor and suggest tracked changes that I can accept or reject
2. Do the first thing across different genres of my own writing
3. Create editing style guides and editing principle guides based on corpuses of my own writing, and use them to constrain suggested edits

## Messing around

I'm trying this out, changing it, trying it out some more. It's an experiment to learn more about my own writing process, and about coding apps this way.

---

## The rest of this README

Everything below this line was written by Claude (Anthropic's AI model), which also wrote most of the code in this repository under Matt's direction. The text above is Matt's own, and is also the welcome document a new install opens with.

### Examples

[`examples/welcome-to-shoulder-md/`](examples/welcome-to-shoulder-md/) holds the welcome document above as the app saves it: the Markdown, and its `.shoulder.json` history file, which records how it was written, including tracked changes by Matt and edits suggested by Claude. Import the `.shoulder.json` file into the app (Documents → Import…) to step through it.

### What it does

A Markdown writing app with Word-style tracked changes and comments, on a sentence-level document model that records every edit and its reason. It runs in the browser and as a Mac app. Style guides, written as plain documents, hold the author's principles; Claude, run through the user's own Claude Code, can suggest edits against them, draft principles from writing samples, and suggest principles from the author's own reasoned edits. See [plan.md](plan.md) for the full design and what is built.

- CodeMirror 6 editor with Markdown highlighting and a rendered preview (editor, split, or preview layouts).
- Background autosave to the browser's IndexedDB on every change, with flushes on blur, tab hide, and unload.
- Several documents, with a document list.
- Bundled open-source fonts (Source Serif 4, Literata, Source Sans 3, Inter, JetBrains Mono, iA Writer Mono, Duo, and Quattro), size, line height, text width, light, dark, sepia and system themes, and presets.
- Every edit is recorded as an operation against a document model of blocks, sentences and spans (`src/model/`), with ids that survive editing. Documents are stored as an append-only op log plus periodic snapshots, so nothing about the editing history is lost.
- Track changes: turn it on and deletions stay struck through, insertions are underlined, and each change gets a card in the margin with author, time, before and after text, accept and reject, and an optional reason (free text, plus tag chips you can switch on in Settings). Accept all and Reject all sit at the top of the margin. Markup, clean, and original views. Undo and redo work on changes, not just text.
- Comments: select text and press ⌘⌥C to open a thread in the margin, with replies, resolve and reopen, and threads attached to a change. Anchors follow the text through edits and undo; a thread whose text is removed is kept and marked as orphaned.
- Exports: Markdown (clean, original, or with changes as CriticMarkup), Word with real tracked changes and threaded comments, the full JSON with its op log, and PDF through the print dialog. Markdown, CriticMarkup, and JSON files import as new documents.
- Library (⌘⌥L): choose which documents join the edits library, set their status and tags, search them, and export every change as JSON lines with its sentence before and after, neighbouring sentences, reason, discussion, and whether it was accepted or rejected. Nothing joins the library unless you include it.
- Folder sync (Chrome and Edge): "Save to a folder…" in the status bar mirrors every document into a folder, such as a git repo, as `.md` and `.shoulder.json`, about a second after each save. Edits made to those files by other tools come back as tracked changes you can accept or reject; if both sides changed, your version wins and the disk version is kept as a `.conflict-` file. Inside the folder, each document has its own folder under `Documents/`, style guides are in `Style/Guides/`, and `Style/Samples/` is for examples of your own writing, one folder per genre. Images dropped or pasted into a document (or added with File → Insert Image in the Mac app) are saved in that document's `assets/` folder.

- Style guides: a base guide plus genre guides (Library → Style guides), where each top-level list item is a principle with a stable id like `[B4]`; "Give them ids" numbers new ones. "Import guides from a folder…" loads `base.md` and one `guide.md` per genre folder, or guide files side by side as in `Style/Guides/`, creating guides or adding the principles an existing guide lacks. Each document picks a genre, and a change card's § button links the change to the principles behind it.
- The Claude switch (toolbar): each document allows Claude or not, by default from its genre (genres can be private). Documents that allow Claude sync to the shared folder, where Claude Code works; the rest sync only to a separate private folder (Library → Folders). Changing access moves the files, after asking.

- Claude as an editor: in Claude Code, ask for edits to a document in the shared folder (the `propose-edits` skill). Claude writes a proposals file beside it; the app offers them as tracked changes by "Claude", each with a reason and the principle it applies, for you to accept or reject.

### Mac app

The same app runs in its own window with Mac menus and direct folder access (no permission prompts):

There is no download: you build the app on your own Mac. An app built on the machine that runs it opens without macOS security warnings, which a downloaded copy would not, since it is not signed with an Apple developer account.

You need [Node.js](https://nodejs.org) 22 or later and git. In Terminal:

```sh
git clone https://github.com/CrumpLabSandbox/shoulder-md.git
cd shoulder-md
corepack enable      # makes pnpm available; it comes with Node
pnpm install
pnpm app:build
```

This makes `release/mac-arm64/Shoulder.app` (`release/mac/Shoulder.app` on an Intel Mac). Drag it to your Applications folder. To update later, run `git pull`, then `pnpm install` and `pnpm app:build` again, and replace the copy in Applications; your documents are kept outside the app and are not affected.

To run it without packaging, `pnpm app` builds and opens it directly.

#### Asking Claude from inside the Mac app

Changes → Ask Claude to Suggest Edits… (or the Claude button in the toolbar) has Claude Code read the open document and its style guides and propose edits, which arrive as tracked changes.

Changes → Chat with Claude (⌥⌘J) opens a conversation about the open document. Claude can answer questions without editing, suggest small tracked edits, or write a larger revision; a revision comes back as tracked changes that share one stated reason. A model menu chooses which Claude model runs the request. Conversations are saved next to each document as `<name>.chat.md` (Settings has a switch to turn this off).

On a genre guide, **Draft principles from samples…** has Claude read the examples of your writing in `Style/Samples/<Genre>/` (only files new since the last run, unless you ask for all) and suggest principles. Each arrives as a tracked change in the guide with a quoted example and a reason, for you to accept or reject.

The **Principle inbox** in the Library has Claude read the edits you gave reasons for and suggest principles they have in common, rewordings of existing ones, and links from edits to principles. You add, change or dismiss each one; what you add arrives in the guide as a tracked change, and what you dismiss is not suggested again.

- This runs **your own Claude Code**. The app starts the `claude` program already installed on your Mac, in your shared folder. It signs nobody in, stores no credentials, and has no API key; it uses whatever account your Claude Code is signed in with, and that account's usage.
- If Claude Code is not installed and signed in (`claude` in a terminal), the feature is unavailable and the app says so. Everything else works without it.
- Claude Code is allowed to read the folder, write `*.proposals.json` files (and, in a chat, one `*.revision.md` copy per document), and run the skill's helper script. Nothing else is permitted while it runs unattended, and it never writes to a document's own files.
- The app copies its skills (`propose-edits`, `draft-principles`, `suggest-principles`) into `.claude/skills/` inside your shared folder.

The Mac app keeps its documents in its own storage, separate from any browser. To bring existing work in, choose your synced folder with File → Choose Shared Folder…; the documents and guides in it are added. Use either the browser or the Mac app on a given folder, not both at once.

Next: measuring whether the guides make Claude edit more like you, once there are enough reasoned edits to test against.

### Develop

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

### Shortcuts

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

### License

Shoulder is open source under the [MIT License](LICENSE), copyright Matt Crump.

It is built on other open-source software and fonts, each under its own licence (mostly MIT, with the bundled fonts under the SIL Open Font License). They are listed with their copyright notices and licence texts in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which also ships inside the Mac app. Run `pnpm notices` to regenerate it after changing dependencies.
