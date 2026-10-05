import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/** The editor theme reads the app's CSS custom properties, so settings and themes apply live. */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    fontSize: 'var(--font-size)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--editor-font)',
    lineHeight: 'var(--line-height)',
    overflow: 'auto',
  },
  '.cm-content': {
    maxWidth: 'var(--measure)',
    margin: '0 auto',
    padding: '2rem 1.5rem 50vh',
    caretColor: 'var(--cursor)',
  },
  '.cm-line': {
    padding: '0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--cursor)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    {
      backgroundColor: 'var(--selection)',
    },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-panels': {
    backgroundColor: 'var(--bg-elev)',
    color: 'var(--fg)',
    borderColor: 'var(--border)',
    fontFamily: 'var(--ui-font)',
    fontSize: '13px',
  },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    fontFamily: 'var(--ui-font)',
  },
  '.cm-searchMatch': {
    backgroundColor: 'var(--selection)',
    outline: '1px solid var(--accent)',
  },
  '.cm-placeholder': {
    color: 'var(--fg-faint)',
    fontStyle: 'italic',
  },
});

/** Quiet Markdown highlighting: structure is shown by weight and tone, not a rainbow. */
export const markdownHighlight = HighlightStyle.define([
  { tag: t.heading, color: 'var(--syn-heading)', fontWeight: '700' },
  { tag: t.heading1, fontSize: '1.3em' },
  { tag: t.heading2, fontSize: '1.15em' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--syn-emphasis)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--syn-emphasis)' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--fg-muted)' },
  { tag: t.link, color: 'var(--syn-link)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--syn-link)' },
  { tag: t.monospace, color: 'var(--syn-code)' },
  { tag: t.quote, color: 'var(--syn-quote)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--fg)' },
  { tag: t.processingInstruction, color: 'var(--syn-meta)' },
  { tag: t.meta, color: 'var(--syn-meta)' },
  { tag: t.contentSeparator, color: 'var(--syn-meta)' },
  { tag: t.labelName, color: 'var(--syn-meta)' },
  { tag: t.comment, color: 'var(--fg-muted)' },
  { tag: t.keyword, color: 'var(--syn-link)' },
  { tag: t.string, color: 'var(--syn-code)' },
]);

export const editorHighlighting = syntaxHighlighting(markdownHighlight);
