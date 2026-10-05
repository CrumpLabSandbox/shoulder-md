import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
});

// Task list items: "- [ ] todo" and "- [x] done". markdown-it has no built-in; this is a tiny core rule.
md.core.ruler.after('inline', 'task-list', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    const para = tokens[i - 1];
    const item = tokens[i - 2];
    if (!inline || !para || !item) continue;
    if (
      inline.type !== 'inline' ||
      para.type !== 'paragraph_open' ||
      item.type !== 'list_item_open'
    )
      continue;
    const first = inline.children?.[0];
    if (!first || first.type !== 'text') continue;
    const m = /^\[([ xX])\]\s+/.exec(first.content);
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
    inline.children!.unshift(box);
    item.attrJoin('class', 'task-item');
  }
});

/** Renders Markdown to sanitized HTML. Safe to assign to innerHTML. */
export function renderMarkdown(source: string): string {
  const html = md.render(source);
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
  });
}

export { countWords } from '../util/text';
