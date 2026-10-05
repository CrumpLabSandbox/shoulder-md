import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  placeholder as placeholderExt,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { editorTheme, editorHighlighting } from './theme';

export type EditorHandle = {
  view: EditorView;
  getText(): string;
  /** Replace the whole document. Used when switching documents; resets undo history. */
  setText(text: string): void;
  focus(): void;
  destroy(): void;
};

export type EditorOptions = {
  parent: HTMLElement;
  doc: string;
  onChange: (text: string) => void;
  placeholder?: string;
  extraExtensions?: Extension[];
};

function baseExtensions(opts: EditorOptions): Extension[] {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      ...markdownKeymap,
      indentWithTab,
    ]),
    markdown({ codeLanguages: languages }),
    editorTheme,
    editorHighlighting,
    placeholderExt(opts.placeholder ?? 'Start writing…'),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString());
    }),
    ...(opts.extraExtensions ?? []),
  ];
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const view = new EditorView({
    state: EditorState.create({ doc: opts.doc, extensions: baseExtensions(opts) }),
    parent: opts.parent,
  });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      view.setState(EditorState.create({ doc: text, extensions: baseExtensions(opts) }));
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
