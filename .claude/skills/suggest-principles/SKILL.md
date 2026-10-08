---
name: suggest-principles
description: Suggest style guide principles from the author's own reasoned edits in a shoulder-md synced folder (the principle inbox). Use when the user asks Claude to learn from their edits, fill or refresh the principle inbox, or work out what their editing reasons have in common.
---

# Suggest principles from the author's edits

In shoulder-md the author edits with track changes and often says why. The app collects those
reasoned edits in `Style/Inbox/edits.json`. You read them alongside the style guides in
`Style/Guides/` and write suggestions to `Style/Inbox/suggestions.json`. The author reviews each
one in the app's inbox: adds it to a guide, changes it, or dismisses it. You never edit a guide.

The helper script is `inbox.mjs` in this skill's folder. Run it from the top of the folder.

## Steps

1. Run `node <skill folder>/inbox.mjs edits` (add `--all` only if told to look at every edit
   again). It prints:
   - `guides`: the base guide (`"base"`) and each genre guide by name, with their sections and
     existing principles;
   - `edits`: the edits to learn from. Each has an `id`, the document and its genre, the text
     `before` and `after`, the sentence before and after, the author's `reason` (and a
     `setReason` if they explained a group of changes together), and any `principles` already
     linked;
   - `dismissed`: principles the author has turned down.
     If there is a `note`, stop and tell the author what it says. If `suggestionsWaiting` is more
     than zero, earlier suggestions are still in the inbox; say so and stop.
2. Work out what to suggest (see below).
3. Write `Style/Inbox/suggestions.json` in the format below.
4. Run `node <skill folder>/inbox.mjs check` and fix what it reports until it passes.
5. Run `node <skill folder>/inbox.mjs done` so these edits are not analysed again.
6. Tell the author how many principles and links you suggested, and anything notable you left
   out and why.

## File format

```json
{
  "suggestions": [
    {
      "kind": "new",
      "guide": "base",
      "section": "Sentences and words",
      "principle": "Cut a sentence's wind-up so it opens with its point.",
      "edits": ["01ABC…:01DEF…", "01ABC…:01GHI…"],
      "reason": "Three edits in two documents delete an opening clause, each with a reason like 'gets to the point'."
    },
    {
      "kind": "reword",
      "guide": "Grants",
      "id": "G24",
      "principle": "Write formal, declarative sentences, but keep contractions in quoted speech.",
      "edits": ["01ABC…:01JKL…"],
      "reason": "The author restored a contraction inside a quotation, against the current wording."
    }
  ],
  "links": [
    {
      "edit": "01ABC…:01MNO…",
      "principles": ["B12"],
      "reason": "The reason given is 'said this already'."
    }
  ]
}
```

- `guide` is `"base"` or a genre name exactly as the helper printed it.
- `principle` is one sentence in the voice of the existing principles. No list marker, no id.
- `edits` are the ids of the edits that support it.
- `reason` says what the edits have in common, in plain words.

## What to suggest

- **A new principle** needs at least two edits that do the same kind of thing for the same kind
  of reason. One edit is an edit, not a habit. Put it in a genre guide if all its edits come
  from that genre, and in `"base"` if they span genres or come from documents with no genre.
- **A rewording** is for an existing principle that the edits show to be too narrow, too broad,
  or wrong as written. Keep the id and give the improved sentence.
- **A link** is for an edit whose reason plainly applies a principle that already exists and
  that is not linked to it yet. Do not suggest a new principle for what a guide already says.
- The author's reasons are the evidence. Do not invent a rationale the reasons do not support,
  and do not turn a one-off fix (a typo, a fact corrected) into a principle.
- Never suggest something in `dismissed` again, in the same words or others.
- Prefer a few well-supported suggestions to many thin ones. Ten in one run is plenty.
- Write nothing except `Style/Inbox/suggestions.json`.
