# Linked documents: editing Markdown files in place

Status: spec, not built. Proposed 2026-10-23. Becomes phase 11 in `plan.md` §10 once settled.

## 1. The goal

Edit a Markdown file where it already lives (a `.qmd` proposal in a git repo, notes in a project folder) without copying it into Shoulder by hand and without a second copy drifting out of date. Opening the file should be one click from Finder, from another app, or from a script, and saving should land in that file.

Two constraints shape the design:

1. **Claude never gets access to the outside folder.** Claude Code works in the shared folder (`~/Shoulder`) and nowhere else, as it does now. Handing it every folder that holds a document is not acceptable.
2. **Nothing changes for other tools.** The outside file stays a plain Markdown file, byte for byte what Shoulder's clean text says, with no Shoulder files next to it. Quarto, git and other editors see an ordinary file.

## 2. The idea in one paragraph

A **linked document** is an ordinary Shoulder document (op log, history, comments, tracked changes, its folder under `Documents/` in the shared or private folder) plus a **link** to one outside file. The Shoulder app, not Claude, holds permission to that one file. It writes the document's clean text to the file after each save and reads outside changes back in as tracked changes by "Edited on disk", the same way folder sync already treats the mirrored `.md`. Claude only ever sees the library copy, in the shared folder, if the document's Claude switch allows it, and never learns where the outside file is.

```
outside folder (any)              Shoulder app (main process)        ~/Shoulder (shared folder)
files/bizdev/proposal.qmd  <---->  link grant: path + identity  <---->  Documents/proposal/
  plain text only                   (userData/links.json)                proposal.md, .shoulder.json,
  written by Shoulder,                                                    proposals, chat, conflicts
  Quarto, git, other editors                                              Claude Code works here only
```

## 3. Decisions

| Decision                       | Choice                                                                                                                                                                      | Why                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit of access                 | One file, picked by the user (dialog, Finder, Dock, `open -a`). Never a folder.                                                                                             | Grants exactly what is needed.                                                                                                                                                           |
| Where the link lives           | Main process, `app.getPath('userData')/links.json`: `{ grantId: { path, dev, ino, addedAt } }`. The page and the document know only the `grantId` and the file's base name. | The path never reaches `~/Shoulder`, the `.shoulder.json`, the edits library export, or Claude.                                                                                          |
| What the page can ask          | `link:read`, `link:write`, `link:stat`, `link:watch`, `link:forget`, all by `grantId`. The main process refuses any other id and never accepts a path from the page.        | Same rule as the folder bridge today: the page cannot widen its own access.                                                                                                              |
| What is written out            | The **clean** text (`viewText(state, 'clean')`), the same text folder sync writes to `<name>.md`.                                                                           | See §5. Writing accepted-only text would revert outside edits until they were accepted.                                                                                                  |
| Files next to the outside file | None. History, proposals, chat and conflict copies stay in the document's library folder.                                                                                   | The outside folder (often a git repo) stays clean.                                                                                                                                       |
| Claude default                 | A newly linked document gets an explicit `claude: false` unless the user turns it on in the open dialog.                                                                    | Opening a private file must not put its text in the shared folder. Today a document without a genre defaults to Claude on (`claudeAllowed`), so linked documents need the explicit flag. |
| Library copy                   | Kept, in the shared or private folder by the usual access rule, or only in IndexedDB when there is no private folder.                                                       | All existing machinery (proposals, chat, records, conflicts) keeps working unchanged.                                                                                                    |
| Name in the library            | The outside file's stem, slugified, through the existing collision rule in `sync.ts` (`proposal`, then `proposal-2`). Fixed once chosen, as now.                            | No new naming rules.                                                                                                                                                                     |
| Extension                      | The outside file keeps its own (`.qmd`, `.md`, `.markdown`); the library copy is `.md`.                                                                                     | Quarto and other tools key off the extension.                                                                                                                                            |
| Deleting or unlinking          | Unlink keeps the library document and stops writing out. Deleting the library document never touches the outside file.                                                      | Shoulder never deletes files it did not create.                                                                                                                                          |

## 4. Opening a file

Entry points, all ending in the same `openLinked(path)` in the main process:

- **File → Open File in Place…** (⌘⇧O): the system open dialog, filtered to `.md`, `.qmd`, `.markdown`, `.txt`.
- **Finder**: register `.md`, `.qmd`, `.markdown` in `CFBundleDocumentTypes` (role Editor, rank Alternate, so Shoulder appears under Open With without taking over as the default app).
- **Dock**: dropping a file on the icon.
- **Command line and scripts**: `open -a Shoulder path/to/file.qmd`. Handled by Electron's `open-file` event, including the launch case (the event can arrive before the window exists, so queue it) and a second launch (`requestSingleInstanceLock` and `second-instance`).
- **Later, optional**: a `shoulder://open?path=…` URL scheme for links from web pages (for example the ops tracker's `files.html`). Any web page could fire such a link, so the first open of a path through it shows a confirmation naming the file; it never opens silently.

`openLinked(path)`:

1. Resolve the real path. If a grant already matches it (same path, or same `dev` + `ino`), open that document and stop.
2. Otherwise create a grant, read the file, and create a document from it with an `import` op, `meta.link = { grantId, name: 'proposal.qmd' }` and `claude: false` (or what the dialog said).
3. Write the library copy as usual, and record the link's sync state: the last text read or written, and the file's `mtimeMs` and `size`.

The open dialog (or a small sheet after a Finder open) offers the genre and the Claude switch, defaulting to no genre and Claude off.

## 5. Keeping the two in step

Per link the page keeps `{ lastText, mtimeMs, size }`: the clean text as of the last read or write.

**Shoulder to file.** After each save, debounced the way folder writes are and flushed by `park()`, if the clean text differs from `lastText`, write it and update the state. If the file is missing (moved, deleted, renamed), do not create it: mark the link broken and show "Locate…" in the status bar, which reopens the dialog and moves the grant to the new path.

**File to Shoulder.** The main process watches the file's parent directory (editors that save by rename replace the file's inode, so watching the file alone misses them) and tells the page when the linked name changes. The page also checks on window focus and on launch for every linked document, not only the open one. If the file's text differs from `lastText`:

- Shoulder unchanged since `lastText`: load the difference as tracked changes by "Edited on disk" (`src/folder/merge.ts`), and set `lastText` to the file's text. Nothing is written back, because the clean text now equals the file.
- Both changed: Shoulder wins, as in folder sync. The file's version is kept as `Documents/<name>/<name>.conflict-<time>.md` in the library, the clean text is written out, and a notice names the file. A three-way merge (rebase the outside hunks onto Shoulder's unsynced edits when they do not overlap) is a later improvement.

**Why the clean text, not the accepted text.** Shoulder's text with pending changes applied is what the author currently means; it is also what folder sync writes, so the rules stay the same. The alternative, writing only accepted text, breaks the main use: an edit made outside (by Quarto tooling, `git pull`, or a Claude Code session in that repo) arrives as a pending "Edited on disk" change, so the next write would remove it from the file until it was accepted. The concern behind the alternative, Claude's suggestions reaching the file before review, is already covered: Claude Code never writes a document's own files, and its proposals and revisions become tracked changes only when the user accepts the banner. Once in, they are the user's call like any tracked change. A per-link "write accepted text only" setting can come later if wanted.

**Writes.** Through the main process with the existing whole-file write. Keep the file's mode. Do not leave temporary files in the outside folder longer than the write takes.

## 6. Byte-for-byte fidelity

If opening and saving a file changes anything the author did not type, every save becomes a diff in the outside repo. Requirements:

- `viewText(importText(s), 'clean') === s` for any string: line endings (LF and CRLF), a missing or doubled final newline, tabs, trailing spaces, non-breaking spaces, BOM. Add it as a fast-check property next to the existing ones, plus fixtures from real files (a Quarto proposal with front matter and fenced divs).
- Writing out never reflows, never normalises list markers or emphasis, never changes quotes.
- If the model cannot hold some input exactly (CRLF, say), record the file's convention on the link and restore it on write, rather than converting the file.

## 7. Quarto and other Markdown that is not CommonMark

Quarto sources mix Markdown with things that are not prose. Shoulder should show them and let the author edit them, but keep them out of everything that treats text as sentences:

- **YAML front matter**: a leading `---` … `---` block. Lezer reads it as a thematic break and a setext heading today, which gives odd sentence ids and a heading in the preview.
- **Fenced div lines**: `::: {.fee}`, `::: {.todo}`, `:::`.
- **Attribute blocks and inline attributes**: `{#tbl-schedule}`, `[text]{.todo}`.
- **Cross-references and shortcodes**: `@tbl-schedule`, `{{< pagebreak >}}`.

Proposed handling:

- Recognise front matter and fence lines as **protected blocks** during segmentation: one block each, no sentences, not counted in stats, not part of edit records or the edits library, and shown in a muted style. The author can still edit them (tracked as usual).
- Claude proposals or revisions that would change a protected block are skipped, with the skip reason "touches front matter or a fence", so a fee section or a `quote:` id is never changed by a suggestion.
- Preview: front matter as a small collapsed metadata box; fenced divs as a labelled box around their content (`fee`, `todo`). Real rendering stays Quarto's job.
- Inline attributes, cross-references and shortcodes are left as text in v1; the sentence segmenter must not split inside `{…}` or `{{< … >}}`.

## 8. The browser version

The browser version uses the same design with the File System Access API: `showOpenFilePicker()` gives a `FileSystemFileHandle`, stored in IndexedDB as the grant (handles survive there; permission may need a click after reload, like "Reconnect" today). There is no watcher, so outside changes are found by the existing two-second poll and on focus. There are no Finder or Dock entry points. The `link:*` calls sit behind the same interface `fs.ts` and `native.ts` already split, so nothing above them branches on "is this the app".

## 9. UI

- Status bar on a linked document: the outside file's base name with a link mark, then "Saved", "Writing…", or "Link broken: Locate…". Hover shows the full path (shown by the main process in a tooltip or a native menu, never stored in the page).
- File menu: Open File in Place…, Reveal Original in Finder, Unlink, Locate… (when broken).
- Library: a "Linked" column, and a filter for linked documents.
- Each new menu item goes in `electron/menu.mjs`, `src/app/commands.ts` and `menuActions` in `App.svelte`, as the existing test requires.

## 10. Build order

1. **Links core**: grants in the main process, `link:*` IPC, `meta.link`, write after save, read on focus and launch, conflict copies in the library, broken links. File → Open File in Place…, Unlink, Reveal. Tests against an in-memory link (extend `tests/helpers/memfs.ts` with a single-file handle).
2. **Fidelity**: the round-trip property and fixtures from §6. This should go in early, because a lossy save in someone's repo is the worst failure this feature can have.
3. **Entry points**: document types, `open-file` (with launch queueing), single instance, Dock drop, the open sheet with genre and Claude choice.
4. **Watching**: the parent-directory watcher, so changes show up without a focus change.
5. **Quarto awareness**: protected blocks, proposal skips, preview boxes (§7).
6. **Later**: `shoulder://` links with confirmation, three-way merge, accepted-only writes per link, browser polish.

## 11. Tests

- Opening a file twice opens one document; a renamed file with the same `dev` + `ino` still matches.
- A save writes exactly the clean text; nothing else appears in the outside folder.
- An outside edit while Shoulder is unchanged arrives as "Edited on disk" changes and is not written back. Undo and reject restore the earlier text and write it out.
- Both sides changed: the conflict copy goes to the library folder, the file gets Shoulder's text, and a notice is shown.
- A missing file marks the link broken and never recreates the file; Locate… moves the grant.
- The page cannot read or write through an unknown `grantId` or a path.
- A linked document with Claude off never appears in the shared folder, and turning Claude on goes through `changeAccess()` as now.
- The link path never appears in `.shoulder.json`, the JSONL export, the inbox digest, or anything else under `~/Shoulder`.
- Round trip: the property and fixtures from §6.
- Protected blocks: front matter and fences are not sentences, are not in edit records, and proposals touching them are skipped.

## 12. Open questions

1. **Author for outside edits.** Keep "Edited on disk", or name the change after the file ("Edited in proposal.qmd") so changes from several linked files are told apart in the library?
2. **History for linked documents.** Should the edits library include them by default (`libraryEligible`), or leave them out because they are often other people's or work documents?
3. **A document already in the library.** Should an existing Shoulder document be linkable to an outside file (File → Link to File…, writing it out), or does a link only come from opening a file?
4. **Claude default without a genre.** `claudeAllowed` returns on for a document without a genre, while `CLAUDE.md` says a missing genre means off. This spec sidesteps it with an explicit `claude: false` on linked documents, but the two should agree.

## 13. On the Tuned Echo ops side

Once phases 1 and 3 land, the ops repo needs only:

- `node scripts/doc.mjs edit <ref>`, which runs `open -a Shoulder <source>`.
- Optionally an "Edit in Shoulder" link in `files.html` (after the `shoulder://` scheme exists).
- A line in its doc skill: a Claude Code session in that repo edits the `.qmd` directly, and Matt reviews those edits in Shoulder, where they arrive as tracked changes by "Edited on disk".

Rendering is unchanged: Quarto reads the `.qmd`, which always holds Shoulder's clean text.
