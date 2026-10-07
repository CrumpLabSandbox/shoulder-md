---
name: draft-principles
description: Draft or extend a shoulder-md style guide from the author's own writing samples. Use when the user asks Claude to learn their style, build or grow a genre guide, or derive principles from the files in Style/Samples of a shoulder-md synced folder.
---

# Draft principles for a style guide from samples

A shoulder-md folder keeps style guides in `Style/Guides/` (each a `.md` with a `.shoulder.json`
beside it) and examples of the author's own writing in `Style/Samples/<Genre>/`. You read the
samples for one genre and suggest principles for that genre's guide. You never edit the guide.
You write `Style/Guides/<name>.principles.json`; the app adds each suggestion to the guide as a
tracked insertion that the author accepts or rejects.

The helper script is `guide.mjs` in this skill's folder.

## Steps

1. The argument is the path to the guide's `.md` file.
2. Run `node <skill folder>/guide.mjs samples "<guide.md>"` (add `--all` only if told to read
   everything again). It prints the guide's sections and existing principles, and `toRead`: the
   sample files that are new since the last run. If there is a `note`, or `toRead` is empty,
   stop and tell the author what it says or that there is nothing new to read. If
   `suggestionsFileExists` is true, earlier suggestions are still waiting; say so and stop.
3. Read the guide's `.md` in full, then read every file in `toRead`.
   - Markdown, plain text and PDF files: read them directly.
   - Word files: `textutil -convert txt -stdout "<file>"`.
   - If a file cannot be read, skip it and say so at the end.
4. Work out what to suggest (see "What to suggest").
5. Write the suggestions file in the format below.
6. Run `node <skill folder>/guide.mjs check "<guide.md>"` and fix what it reports until it passes.
7. Run `node <skill folder>/guide.mjs done "<guide.md>"` so these samples are not read again.
8. Tell the author how many principles you suggested, how many samples you read, anything you
   skipped, and any place where the samples disagree with a principle the guide already has.

## File format

```json
{
  "document": "<documentId from the samples command>",
  "principles": [
    {
      "section": "Openings",
      "principle": "Open with the broad problem in one plain sentence.",
      "examples": ["\"Errors are ubiquitous in human performance.\" (Grants/proposal-2012.pdf)"],
      "reason": "Seven of the nine proposals open this way."
    }
  ]
}
```

- `section` is a heading already in the guide, or a new heading if none fits.
- `principle` is one sentence in the same voice as the guide's existing principles. No list
  marker and no id: the app adds them.
- `examples` are one to three short verbatim quotations (under 30 words each), each followed by
  the sample file it came from. Copy them exactly, typos included.
- `reason` says how consistent the habit is across the samples you read.

## What to suggest

- Describe what this author actually does, consistently. A habit seen in one sample is not a
  principle. Prefer a dozen well-supported principles to forty thin ones; at most fifteen in a
  run.
- Use only the author's own prose. Leave out quoted material, form text, reference lists, code
  and its output, and anything written by someone else or by an AI system. If a sample is
  co-authored and you cannot tell which parts are the author's, leave it out and say so.
- Do not repeat a principle the guide already has, in other words either. If the samples
  strongly support an existing principle, say so in your reply; do not add it again.
- If the samples contradict an existing principle, do not write the opposite as a new
  principle. Report the conflict in your reply and let the author decide.
- Recurring slips (misspellings, dropped words) are not style. Mention them in your reply; do
  not turn them into principles.
- Write nothing except the suggestions file, and never change anything under `Style/Samples/`.
