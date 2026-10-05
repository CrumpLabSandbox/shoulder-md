/**
 * PDF by way of the browser's print dialog. The document is rendered into a print-only
 * container in the page (so the app's fonts and theme tokens apply), printed, then removed.
 */
import type { Author, State } from '../model/types';
import { commentRanges, text as viewText } from '../model/views';
import { flatten, sameMark } from '../model/spans';
import { renderMarkdown } from '../preview/render';

export type PrintMode = 'clean' | 'markup';

/** HTML for the document: clean, or with insertions, deletions and comment footnotes. */
export function printHtml(state: State, mode: PrintMode, authors: readonly Author[] = []): string {
  if (mode === 'clean') return renderMarkdown(viewText(state, 'clean'));
  const name = (id: string) => authors.find((a) => a.id === id)?.name ?? id;

  // Footnote markers at comment anchor ends, in revision coordinates.
  const notes: { n: number; text: string }[] = [];
  const markers = new Map<number, number[]>();
  for (const r of commentRanges(state)) {
    const t = state.comments.find((x) => x.id === r.threadId)!;
    if (t.resolved) continue;
    const n = notes.length + 1;
    notes.push({
      n,
      text: t.comments
        .map((c) => `<b>${escapeHtml(name(c.author))}:</b> ${escapeHtml(c.body)}`)
        .join(' — '),
    });
    const at = r.orphaned ? r.from : r.to;
    markers.set(at, [...(markers.get(at) ?? []), n]);
  }

  // Revision text with inline HTML for marks. markdown-it keeps inline HTML as-is.
  let src = '';
  let pos = 0;
  const marksAt = (p: number) =>
    (markers.get(p) ?? []).map((n) => `<sup class="fn">${n}</sup>`).join('');
  const spans = flatten(state.blocks);
  const merged: typeof spans = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && sameMark(last, s)) last.text += s.text;
    else merged.push({ ...s });
  }
  for (const s of merged) {
    const tag = s.kind === 'ins' ? 'ins' : s.kind === 'del' ? 'del' : undefined;
    const title = s.author ? ` title="${escapeHtml(name(s.author))}"` : '';
    if (tag) {
      src += `<${tag}${title}>${s.text}</${tag}>`;
      pos += s.text.length;
      src += marksAt(pos);
    } else {
      let i = 0;
      const cuts = [...markers.keys()]
        .filter((k) => k > pos && k < pos + s.text.length)
        .sort((a, b) => a - b);
      for (const k of cuts) {
        src += s.text.slice(i, k - pos) + marksAt(k);
        i = k - pos;
      }
      src += s.text.slice(i);
      pos += s.text.length;
      src += marksAt(pos);
    }
  }
  let html = renderMarkdown(src);
  if (notes.length) {
    html += `<section class="footnotes"><h2>Comments</h2><ol>${notes.map((n) => `<li id="fn-${n.n}">${n.text}</li>`).join('')}</ol></section>`;
  }
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders `html` into a print-only root, prints, and cleans up. */
export function printDocument(html: string, title: string): void {
  const root = document.createElement('div');
  root.id = 'print-root';
  root.innerHTML = `<article class="md-preview print">${html}</article>`;
  const prevTitle = document.title;
  document.title = title;
  document.body.appendChild(root);
  document.body.classList.add('printing');
  const cleanup = () => {
    document.body.classList.remove('printing');
    root.remove();
    document.title = prevTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Browsers without afterprint (or a cancelled dialog) still get cleaned up.
  setTimeout(cleanup, 1000);
}
