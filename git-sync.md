# Git sync: one Shoulder folder on several Macs

Status: built 2026-10-23 for the shared folder (§9 steps 1–4): `electron/git.mjs` and `electron/git-merge.mjs` in the main process, the sync loop and `absorbPulled` in the workspace, `src/ui/GitSetup.svelte`. Not built yet: §8 (needs phase 11) and a repository for the private folder. Phase 12 in `plan.md` §10.

## 1. The goal

Work on the same Shoulder library from two Macs (home and work) without putting the Shoulder folder inside OneDrive, Dropbox or iCloud. The shared folder becomes a clone of a private git repository. The app pulls and pushes on its own; the author never has to run git by hand.

What stays the same: the folder layout (`Documents/`, `Style/`), the app's own store as the working copy on each Mac, Claude Code working only in the shared folder, and every rule in `CLAUDE.md` about what Claude may write.

## 2. Decisions

| Decision    | Choice                                                                                                                                                                                                                                                      | Why                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| What syncs  | The shared folder. The private folder can be set up the same way with its own repository, or left on the Mac (the default).                                                                                                                                 | Claude-off documents never leave the Mac unless the author chooses a place for them.         |
| How         | The app runs the Mac's own `git` (`/usr/bin/git`) in the main process. No git library, no GitHub API.                                                                                                                                                       | Any remote works: GitHub now, a Mac mini or a home server later, with only the URL changing. |
| Credentials | None in the app. Git uses whatever the Mac already has: an SSH key, or GitHub CLI's sign-in through `gh auth setup-git`. There is no field for a token anywhere in Shoulder.                                                                                | Same rule as Claude: the app never handles sign-in, tokens or keys.                          |
| Commands    | A fixed set, built in the main process: `ls-remote`, `clone`, `init`, `fetch`, `merge`, `add`, `commit`, `push`, `status`, `rev-parse`, `remote get-url`. The page asks for `git:setup(url)`, `git:sync`, `git:status`; it never passes arguments or paths. | The page cannot turn git into a general command runner.                                      |
| No prompts  | Run with `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, and a timeout.                                                                                                                                                               | A sign-in problem fails with a message instead of hanging in the background.                 |
| Claude Code | Still has no git (none of the allow-lists in `electron/claude-events.mjs` include it). Sync pauses while a Claude run is in progress.                                                                                                                       | Claude never commits, pushes or sees the remote.                                             |
| Remote URL  | Stored in the main process's `userData`, per Mac, not in the folder.                                                                                                                                                                                        | Git keeps it in `.git/config` anyway; nothing new reaches files Claude reads.                |

## 3. What is committed

The app writes and maintains a `.gitignore` at the top of the folder:

```
.DS_Store
.claude/
*.proposals.json
*.proposals.skipped.json
*.revision.md
*.principles.json
Style/Inbox/suggestions.json
Style/Inbox/edits.json
```

- **Committed**: each document's `.md`, `.shoulder.json`, `.chat.md`, `assets/`, conflict copies; `Style/Guides/`; `Style/Samples/README.md`; the inbox's `decisions.json` (what was added or dismissed) and `seen.json` (edits already analysed).
- **Not committed**: `.claude/` (the app copies its skills in on each Mac), and Claude's pending requests (proposals, skipped lists, revisions, suggested principles). A pending request is answered on the Mac that asked; syncing it would show the same banner on both Macs and could apply it twice. Once accepted, its result is ordinary ops in `.shoulder.json` and syncs like any edit. The inbox's `edits.json` is left out too: the app rebuilds it from the documents.
- **Samples stay on each Mac.** `Style/Samples/` holds the author's own writing, often large PDFs, and is git-ignored apart from its README. Each Mac keeps its own samples; drafting principles reads the samples on the Mac where it runs. The guides it produces sync like any document. (Decided 2026-10-23.)

## 4. When it syncs

- **Pull**: on launch, on window focus, every 5 minutes while the app is open, and from File → Sync Now.
- **Push**: 30 seconds after the last folder write, and on quit (with a short timeout, so quitting never hangs). `park()` already flushes folder writes before switching documents; sync runs after it.
- **Commits** are made by the app with a fixed message naming the Mac and the documents, for example `Shoulder (Home iMac): grti-request, provost-notes`. Several saves fold into one commit per push.
- After a pull, changed files go through the existing outside-change path in the workspace (`resolveExternal`): when the pulled history extends the one on this Mac, the new ops are appended with no prompt.

## 5. Conflicts

The case that matters: one document edited on both Macs before they synced.

- Every document file is written by the app, and `.shoulder.json` changes on every save (`updatedAt` in the header, the last op rewritten by typing runs), so git will report a conflict for nearly any edit made on both sides. Git's conflict markers must never reach a file the app reads.
- So the app merges with `git merge --no-commit` and, for each conflicting file, settles it itself:
  - one history extends the other: take the longer one;
  - they diverged: keep this Mac's version as the document and save the other as a conflict copy (`<name>.conflict-<time>.md` and `.shoulder.json`, the copies folder sync already makes), with a notice naming the document.
- Conflicting files the app does not own (a sample, a README) keep this Mac's version and save the other beside it with `.conflict-<time>` in the name.
- Then it commits the merge and pushes. Nothing is ever lost: both versions are in the folder and in git history.
- **Later**: merge the two histories instead of keeping a copy. Ops carry ids, but they are positional edits, so this means rebasing one Mac's ops onto the other's (the same job as the three-way merge in `linked-documents.md` §5). Storing each Mac's ops in its own file would make git's part conflict-free; the merge itself would still be the app's.

## 6. First-run setup

Offered once, when the app first has a shared folder and no sync is set up, and always available from Library → Sync and File → Set Up Sync….

1. **Explain**: "Keep your Shoulder folder the same on each Mac through a private git repository. Shoulder uses your Mac's git and its existing sign-in; it never asks for a password or token." Buttons: Set Up, Not Now. Not Now leaves everything as it is today.
2. **Ask for the repository URL**, with a link "How do I make one?" that opens `docs/git-sync-setup.md` on GitHub. Accept `git@host:owner/repo.git`, `ssh://…`, and `https://…`.
3. **Check** with `git ls-remote`, and say exactly what went wrong: git not installed (offer Xcode's command line tools), sign-in failed (link to the walkthrough's sign-in step), repository not found, no network.
4. **Decide what to do from what is on each side**:
   - Repository empty, folder has files (the first Mac): write `.gitignore`, `init`, commit everything, push. The folder's name does not need to match the repository's. A checkbox, "Rename the folder to match (~/ShoulderDocs)", shown only when the names differ and unticked by default, renames it in the main process before `init` and updates the stored folder, so the app never points at a folder that is gone. It is skipped with a message if a folder of that name already exists.
   - Repository has files, folder empty or new (the second Mac): clone into the folder, then import its documents as connecting a folder does today.
   - Both have files: do not merge two libraries silently. Offer "Use the repository's copy", which renames the local folder to `<folder>-before-sync-<date>` and clones, or Cancel.
5. **Done**: the status bar shows the sync state.

## 7. UI

- Status bar: "Synced", "Syncing…", "3 changes not pushed", "Offline", or "Sync failed: sign-in". Clicking it opens Library → Sync with the last error and a Sync Now button.
- Library → Sync: the remote URL, the last sync time, Sync Now, Stop Syncing (keeps the folder and `.git`, stops pulling and pushing).
- File menu: Sync Now, Set Up Sync…. Each goes in `electron/menu.mjs`, `src/app/commands.ts` and `menuActions` in `App.svelte`.
- The browser version has no git and does not show any of this.

## 8. Linked documents on a second Mac

A linked file (`linked-documents.md`) sits at a different path on each Mac (OneDrive's folder name includes the account). The link itself stays per Mac, in `userData`, and never syncs, because a path in the folder would be readable by Claude. Instead:

- The document records a hash of the clean text it last wrote out (`meta.link.textHash`). The hash says nothing about where the file is.
- On the second Mac, opening the file (Finder, Open File in Place…) finds a library document whose hash matches and offers "This is linked to _proposal_ on your other Mac. Reconnect?", which makes a local link to the same document.
- If the file changed since (no hash match), match by file name and offer the same, taking the difference in as "Edited on disk" changes.

## 9. Build order

1. **Git core in the main process**: the fixed command set, no-prompt environment, timeouts, `git:status`, errors mapped to plain messages. Tests against a temporary bare repository and two clones (two "Macs") using real git.
2. **Setup flow** (§6) and the `.gitignore`.
3. **Sync loop**: pull and push timing (§4), pausing during Claude runs, status bar.
4. **Conflicts** (§5) with the existing conflict copies.
5. **Linked documents on a second Mac** (§8), once phase 11 exists.
6. **Later**: history merge instead of conflict copies; a private-folder repository from the same setup screen.

## 10. Tests

- Setup in each of the three cases in §6; the both-sides case never merges silently.
- An edit on Mac A appears on Mac B after a sync, as appended ops with no prompt.
- Both Macs edit one document: neither loses text; one version becomes a conflict copy; no file contains conflict markers.
- Pending Claude files are never committed; accepted results are.
- A sign-in failure, a missing repository and no network each give their own message and never hang.
- The page cannot run any git command outside the fixed set, or pass a path.
- No credential appears in any file under the shared folder (the address is only in `.git/config`).

## 11. Open questions

1. **Pull frequency.** Five minutes plus focus is a guess; a Mac that sleeps with unpushed edits is the main gap. Push on sleep as well?
2. ~~Samples.~~ Decided: they stay on each Mac (§3).
3. **One repository for both folders?** Simpler to set up, but it would put Claude-off documents next to Claude-on ones in one remote. Two repositories keeps the line clear.
