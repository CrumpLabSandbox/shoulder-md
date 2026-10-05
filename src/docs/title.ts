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

/**
 * Decides the title after a text change. The title follows the text while it was never set by hand:
 * that is, while it still equals what the previous text would have produced.
 */
export function nextTitle(currentTitle: string, previousText: string, newText: string): string {
  const wasDerived = currentTitle === deriveTitle(previousText) || currentTitle === 'Untitled';
  return wasDerived ? deriveTitle(newText) : currentTitle;
}
