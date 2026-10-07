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
    return /shoulder\.mjs\s+check/.test(input.command)
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
    return [
      failed
        ? { kind: 'error', text: text || `Claude Code stopped early (${msg.subtype ?? 'error'}).` }
        : { kind: 'done', text },
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
  'Write(/*.proposals.json)',
  'Edit(/*.proposals.json)',
  'Bash(node .claude/skills/propose-edits/shoulder.mjs:*)',
];
