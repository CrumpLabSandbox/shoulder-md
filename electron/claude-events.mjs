// Turns Claude Code's `--output-format stream-json` lines into the few events the app shows.
// Pure functions, so they can be tested without Electron or Claude Code.

const clip = (s, n = 160) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** A short description of a tool call, for the progress list. */
function describeTool(name, input = {}) {
  const file = input.file_path ?? input.path ?? input.pattern;
  if (name === 'Read' && file) return `Reading ${String(file).split('/').pop()}`;
  if ((name === 'Write' || name === 'Edit') && file)
    return `Writing ${String(file).split('/').pop()}`;
  if (name === 'Bash' && input.command)
    return /inbox\.mjs\s+edits/.test(input.command)
      ? 'Reading your reasoned edits'
      : /inbox\.mjs\s+check/.test(input.command)
        ? 'Checking the suggestions'
        : /inbox\.mjs\s+done/.test(input.command)
          ? 'Recording the edits as analysed'
          : /guide\.mjs\s+samples/.test(input.command)
            ? 'Finding the samples to read'
            : /guide\.mjs\s+check/.test(input.command)
              ? 'Checking the suggestions'
              : /guide\.mjs\s+done/.test(input.command)
                ? 'Recording the samples as read'
                : /^textutil\b/.test(input.command)
                  ? 'Reading a Word file'
                  : /shoulder\.mjs\s+check/.test(input.command)
                    ? 'Checking the proposals'
                    : /shoulder\.mjs\s+context/.test(input.command)
                      ? 'Finding the guides that apply'
                      : `Running ${clip(input.command, 60)}`;
  if ((name === 'Glob' || name === 'Grep') && file) return `Searching for ${clip(file, 60)}`;
  return `Using ${name}`;
}

/**
 * Events for one output line: `{ kind: 'text' | 'step' | 'done' | 'error', text }`.
 * Unknown or unparseable lines give nothing.
 */
export function eventsFromLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }
  if (!msg || typeof msg !== 'object') return [];
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const out = [];
    for (const part of msg.message.content) {
      if (part.type === 'text' && part.text?.trim())
        out.push({ kind: 'text', text: part.text.trim() });
      else if (part.type === 'tool_use')
        out.push({ kind: 'step', text: describeTool(part.name, part.input) });
    }
    return out;
  }
  if (msg.type === 'result') {
    const failed = msg.is_error || (msg.subtype && msg.subtype !== 'success');
    const text = typeof msg.result === 'string' ? msg.result.trim() : '';
    const session = typeof msg.session_id === 'string' ? { sessionId: msg.session_id } : {};
    return [
      failed
        ? {
            kind: 'error',
            text: text || `Claude Code stopped early (${msg.subtype ?? 'error'}).`,
            ...session,
          }
        : { kind: 'done', text, ...session },
    ];
  }
  return [];
}

/** Splits a growing output buffer into complete lines and the unfinished remainder. */
export function takeLines(buffer) {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  return { lines: lines.filter((l) => l.trim()), rest };
}

/** The request sent to Claude Code for one document. */
export function proposalPrompt(docFile, note) {
  const extra = note?.trim() ? `\n\nThe author adds: ${note.trim()}` : '';
  return (
    `Follow the instructions in .claude/skills/propose-edits/SKILL.md to propose edits for the ` +
    `document "${docFile}" in this folder. The skill's helper script is ` +
    `.claude/skills/propose-edits/shoulder.mjs. You are running unattended inside the author's ` +
    `writing app: do not ask questions. If something is ambiguous, make the conservative choice ` +
    `and say so at the end. If node is not available for the check step, skip it; the app ` +
    `validates the file itself. Write only the proposals file. Finish with a short summary for ` +
    `the author: how many proposals, which principles they lean on, and anything you left alone.` +
    extra
  );
}

/** Tools Claude Code may use without asking; everything else is refused when unattended. */
export const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write(/**/*.proposals.json)',
  'Edit(/**/*.proposals.json)',
  'Bash(node .claude/skills/propose-edits/shoulder.mjs:*)',
];

/** Model choices passed to Claude Code as `--model`; '' leaves it to Claude Code's own default. */
export const CLAUDE_MODELS = ['', 'fable', 'opus', 'sonnet', 'haiku'];

/** The command-line arguments for one request. An unknown model name is ignored. */
export function claudeArgs(docFile, note, model) {
  const args = ['-p', proposalPrompt(docFile, note), '--output-format', 'stream-json', '--verbose'];
  if (model && CLAUDE_MODELS.includes(model)) args.push('--model', model);
  args.push('--allowedTools', ...ALLOWED_TOOLS);
  return args;
}

/* ---------- chat ---------- */

/** In a chat, Claude Code may also write one revised copy of a document for the app to diff. */
export const CHAT_TOOLS = [...ALLOWED_TOOLS, 'Write(/**/*.revision.md)', 'Edit(/**/*.revision.md)'];

/** What Claude Code is told, on every turn, about where it is and what it may do. */
export function chatSystemPrompt(docFile) {
  const stem = docFile.replace(/\.md$/, '');
  return [
    `You are helping an author inside Shoulder, their writing app, in a chat panel beside the document "${docFile}" (a path in the current folder). Read that file whenever you need its current text; the author may have edited it since your last turn.`,
    `The author's style guides are Markdown files in Style/Guides/, and examples of their past writing are in Style/Samples/. Run "node .claude/skills/propose-edits/shoulder.mjs context ${JSON.stringify(docFile)}" to find the guides that apply to this document, and follow them when you edit or advise.`,
    'You can do three things:',
    '1. Answer questions and give advice about the document. Just reply; write no files.',
    `2. Suggest small, separately justified edits. Follow .claude/skills/propose-edits/SKILL.md, which has you write "${stem}.proposals.json". If the context command says a proposals file already exists, tell the author to deal with it first instead of replacing it.`,
    `3. Make a larger revision (restructuring, rewriting sections, wholesale edits). Write the complete revised document to "${stem}.revision.md". Its first line must be an HTML comment giving the reason in one or two plain sentences, like "<!-- reason: Reorganised the plan around the three aims. -->", followed by the full text of the document as it should read, including the parts you did not change.`,
    "Never edit the document's own .md or .shoulder.json, and write nothing else. The app turns your proposals or revision into tracked changes that the author accepts or rejects, so say that this is what will happen; do not paste the full rewrite into the chat.",
    'Choose 2 for local wording and correctness, 3 when the author asks for bigger changes, and 1 when they ask a question. You are running unattended: do not ask for permission to use tools.',
    'Replies appear in a narrow panel. Keep them short and plain: a few sentences or a short list, no headings or tables.',
  ].join('\n\n');
}

/** The command-line arguments for one chat turn; `sessionId` continues an earlier turn. */
export function chatArgs(docFile, message, sessionId, model) {
  const args = ['-p', message, '--output-format', 'stream-json', '--verbose'];
  if (sessionId && /^[0-9a-f-]{8,}$/i.test(sessionId)) args.push('--resume', sessionId);
  args.push('--append-system-prompt', chatSystemPrompt(docFile));
  if (model && CLAUDE_MODELS.includes(model)) args.push('--model', model);
  args.push('--allowedTools', ...CHAT_TOOLS);
  return args;
}

/* ---------- drafting a guide from samples ---------- */

/** Reading samples (Word files through macOS's own converter) and writing one suggestions file. */
export const GUIDE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write(/Style/Guides/*.principles.json)',
  'Edit(/Style/Guides/*.principles.json)',
  'Bash(node .claude/skills/draft-principles/guide.mjs:*)',
  'Bash(textutil -convert txt -stdout:*)',
];

export function guidePrompt(guideFile, all) {
  return (
    `Follow the instructions in .claude/skills/draft-principles/SKILL.md for the style guide ` +
    `"${guideFile}" in this folder. The skill's helper script is ` +
    `.claude/skills/draft-principles/guide.mjs. ` +
    (all ? 'Read every sample again (pass --all to the samples command). ' : '') +
    `You are running unattended inside the author's writing app: do not ask questions. If ` +
    `something is ambiguous, make the conservative choice and say so at the end. Write only ` +
    `the suggestions file (the helper writes its own record). Finish with a short summary for ` +
    `the author.`
  );
}

export function guideArgs(guideFile, all, model) {
  const args = ['-p', guidePrompt(guideFile, all), '--output-format', 'stream-json', '--verbose'];
  if (model && CLAUDE_MODELS.includes(model)) args.push('--model', model);
  args.push('--allowedTools', ...GUIDE_TOOLS);
  return args;
}

/* ---------- the principle inbox ---------- */

export const INBOX_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write(/Style/Inbox/suggestions.json)',
  'Edit(/Style/Inbox/suggestions.json)',
  'Bash(node .claude/skills/suggest-principles/inbox.mjs:*)',
];

export function inboxPrompt(all) {
  return (
    `Follow the instructions in .claude/skills/suggest-principles/SKILL.md for this folder. The ` +
    `skill's helper script is .claude/skills/suggest-principles/inbox.mjs; run it from here. ` +
    (all ? 'Look at every edit again (pass --all to the edits command). ' : '') +
    `You are running unattended inside the author's writing app: do not ask questions. If ` +
    `something is ambiguous, make the conservative choice and say so at the end. Write only ` +
    `Style/Inbox/suggestions.json (the helper writes its own record). Finish with a short ` +
    `summary for the author.`
  );
}

export function inboxArgs(all, model) {
  const args = ['-p', inboxPrompt(all), '--output-format', 'stream-json', '--verbose'];
  if (model && CLAUDE_MODELS.includes(model)) args.push('--model', model);
  args.push('--allowedTools', ...INBOX_TOOLS);
  return args;
}
