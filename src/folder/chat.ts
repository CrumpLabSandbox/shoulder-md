/**
 * The saved conversation with Claude about one document: `<name>.chat.md` in the document's
 * folder. It is plain Markdown a person can read, and each entry is led by an HTML comment the
 * app reads back:
 *
 *   <!-- you 2026-10-07T13:12:00.000Z -->
 *   **You** · Oct 7, 2026, 9:12 AM
 *
 *   What is weak about the opening?
 *
 * `<!-- new … -->` starts a fresh conversation and `<!-- session id -->` records the Claude Code
 * session to continue. The file is never named claude.md: Claude Code would load that as
 * instructions.
 */

export const CHAT_EXT = '.chat.md';

export type ChatRole = 'you' | 'claude' | 'error';
export type ChatMessage = { role: ChatRole; text: string };

const LABEL: Record<ChatRole, string> = { you: 'You', claude: 'Claude', error: 'Note' };
const MARK = /^<!-- (you|claude|error|new|session)(?: ([^>]*?))? -->$/;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function chatHeader(title: string): string {
  return `# Conversation with Claude: ${title}\n\nSaved by Shoulder as part of this document's history.\n`;
}

/** One entry, ready to append. A line of the text that looks like a marker is defused. */
export function chatEntry(m: ChatMessage, iso: string, model?: string): string {
  const who = m.role === 'claude' && model ? `Claude (${model})` : LABEL[m.role];
  const body = m.text
    .trim()
    .split('\n')
    .map((line) => (MARK.test(line.trim()) ? line.replace('<!--', '<!-- ·') : line))
    .join('\n');
  return `\n<!-- ${m.role} ${iso} -->\n**${who}** · ${when(iso)}\n\n${body}\n`;
}

export function chatSession(sessionId: string): string {
  return `\n<!-- session ${sessionId} -->\n`;
}

export function chatDivider(iso: string): string {
  return `\n<!-- new ${iso} -->\n---\n`;
}

/** The latest conversation in a saved file, and the session to continue it with. */
export function parseChat(file: string): { messages: ChatMessage[]; sessionId?: string } {
  let messages: ChatMessage[] = [];
  let sessionId: string | undefined;
  let open: { role: ChatRole; lines: string[]; started: boolean } | undefined;
  const close = () => {
    if (open) messages.push({ role: open.role, text: open.lines.join('\n').trim() });
    open = undefined;
  };
  for (const line of file.split('\n')) {
    const m = MARK.exec(line.trim());
    if (!m) {
      if (!open) continue;
      // The first line after a marker is the visible "**You** · time" label, not the message.
      if (!open.started) open.started = true;
      else open.lines.push(line);
      continue;
    }
    close();
    if (m[1] === 'new') {
      messages = [];
      sessionId = undefined;
    } else if (m[1] === 'session') {
      sessionId = m[2]?.trim() || undefined;
    } else {
      open = { role: m[1] as ChatRole, lines: [], started: false };
    }
  }
  close();
  // A divider line written before the next marker belongs to no message.
  messages = messages.map((x) => ({ ...x, text: x.text.replace(/\n*---\s*$/, '').trim() }));
  return { messages: messages.filter((x) => x.text), ...(sessionId ? { sessionId } : {}) };
}
