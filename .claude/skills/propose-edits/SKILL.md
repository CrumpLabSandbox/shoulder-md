---
name: propose-edits
description: Propose edits to a shoulder-md document as tracked changes, guided by its style guides. Use when the user asks Claude to edit, review, tighten or suggest changes to a document that lives in a shoulder-md synced folder (a .md with a .shoulder.json beside it), or names a genre guide such as Grants or Blog to edit by.
---

# Propose edits to a shoulder-md document

shoulder-md mirrors each document into its own folder, `Documents/<name>/`, as `<name>.md` (the
clean text) and `<name>.shoulder.json` (its history). Style guides are in `Style/Guides/`, and
examples of the author's past writing are in `Style/Samples/`. You never edit a document's
`.md` or `.shoulder.json`. You write `<name>.proposals.json` beside them; the app picks it up and shows each proposal as a tracked
change by "Claude", with your reason and the principle it applies, for the author to accept or
reject.

The helper script is `shoulder.mjs` in this skill's folder.

## Steps

1. Find the document. The argument is a path to its `.md` file (or enough of a name to find it in
   the folder the user points at). If it is ambiguous, ask.
2. Run `node <skill folder>/shoulder.mjs context "<document.md>"`. It prints the document id and
   the paths of the base guide and the genre guide that apply. If `isGuide` is true, stop: guides
   are edited by the author. If `proposalsFileExists` is true, the author has not dealt with the
   last batch; ask before replacing it.
3. Read the document's `.md`, the base guide and the genre guide in full. Principles are the
   top-level list items with ids like `[B6]` or `[G17]`; the indented lines under them are the
   author's explanation and examples. A genre principle marked `replaces B3` takes that base
   principle's place.
4. Decide on the edits (see "What to propose").
5. Write `<name>.proposals.json` next to the document, in the format below.
6. Run `node <skill folder>/shoulder.mjs check "<document.md>"` and fix every problem it reports,
   then run it again until it passes.
7. Tell the author how many proposals you wrote, which principles they lean on most, and
   anything you chose not to touch. They will see a banner in the app the next time the document
   is open with the folder connected.

## File format

```json
{
  "document": "<documentId from the context command>",
  "proposals": [
    {
      "quote": "text copied exactly from the .md",
      "replacement": "the same text with your change made",
      "principles": ["G2"],
      "reason": "One plain sentence about this edit."
    }
  ]
}
```

- `quote` must be copied exactly from the `.md` and occur exactly once in it. Quote the smallest
  span that contains the change and is unique: usually a clause or a sentence. If a short quote
  occurs twice, add neighbouring words until it is unique.
- `replacement` is what the quote should become. The app works out which words differ, so keep
  the unchanged words identical. An empty string deletes the quote. To insert, quote the words
  around the spot and repeat them with the new words in place.
- One change per proposal. Two unrelated fixes in one sentence are two proposals only if their
  quotes do not overlap or touch; otherwise make one proposal and say both things in the reason.
- `principles` lists only ids that exist in this document's guides and that the edit applies.
  Leave it empty for a plain correction (a typo, a dropped word).
- `reason` is required: one sentence, specific to this edit, in plain words. Do not restate the
  principle; say what was wrong here or what the change achieves.

## What to propose

- Edit toward the author's guides, not toward your own taste. If no principle supports a change
  and it is not a plain error, do not propose it.
- The guides describe how this author writes. Keep their voice: do not make a casual genre
  formal or a formal one casual.
- Prefer fewer, well-founded proposals to many small ones. Ten to thirty is typical for a few
  pages. Do not rewrite whole paragraphs; if a paragraph needs restructuring, propose the
  smallest edits that fix it, or describe the problem to the author in your reply instead.
- Leave quotations, citations, numbers, names and code as they are unless there is a plain error.
- Never change the `.md` or `.shoulder.json` yourself, and never write outside the document's
  folder.
