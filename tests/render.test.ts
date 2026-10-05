import { describe, it, expect } from 'vitest';
import { renderMarkdown, countWords } from '../src/preview/render';

describe('renderMarkdown', () => {
  it('renders headings, emphasis, and lists', () => {
    const html = renderMarkdown('# Title\n\nSome *em* and **strong**.\n\n- a\n- b\n');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<li>a</li>');
  });

  it('renders GFM tables and strikethrough', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~');
    expect(html).toContain('<table>');
    expect(html).toContain('<s>gone</s>');
  });

  it('renders task lists as disabled checkboxes', () => {
    const html = renderMarkdown('- [ ] todo\n- [x] done\n');
    expect(html).toMatch(/<input type="checkbox" disabled(="")?> todo/);
    expect(html).toMatch(/<input type="checkbox" disabled(="")? checked(="")?> done/);
  });

  it('strips scripts and event handlers', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1))',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('href="javascript:');
  });

  it('linkifies bare URLs', () => {
    expect(renderMarkdown('see https://example.com now')).toContain(
      '<a href="https://example.com">',
    );
  });
});

describe('countWords', () => {
  it('counts words and ignores Markdown punctuation', () => {
    expect(countWords('# Hello, world!\n\n- **one** two\n- three')).toBe(5);
    expect(countWords("don't split contractions")).toBe(3);
    expect(countWords('')).toBe(0);
  });
});
