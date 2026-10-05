/** Derives a title from Markdown: the first heading, else the first non-empty line, else 'Untitled'. */
export function deriveTitle(text: string): string {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const candidate = (heading ? heading[1]! : line).replace(/[*_`~]/g, '').trim();
    if (candidate) return candidate.length > 80 ? candidate.slice(0, 77) + '…' : candidate;
  }
  return 'Untitled';
}

/** The title to show: an explicit one if set, else derived from the text. */
export function displayTitle(explicit: string, text: string): string {
  return explicit.trim() || deriveTitle(text);
}
