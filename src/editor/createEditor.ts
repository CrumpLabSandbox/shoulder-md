import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
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
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { editorTheme, editorHighlighting } from './theme';
import {
  fromModel,
  intentOf,
  setMarks,
  trackingExtension,
  type MarkInfo,
  type TextChange,
  type TrackingConfig,
} from './tracking';

export type { TextChange } from './tracking';

export type Transaction = {
  /** The user's changes, non-overlapping, ascending, in pre-transaction coordinates. */
  changes: TextChange[];
  /** The full text after the transaction. */
  text: string;
};

export type Selection = { anchor: number; head: number };

/** Imperative surface the workspace drives: buffer sync, marks, measurement, selection. */
export type EditorBridge = {
  /** Applies model-originated changes (not fed back to the model). */
  applyChanges(changes: TextChange[], selection?: Selection): void;
  setMarks(info: MarkInfo): void;
  /** Replaces the whole buffer (document switch or view switch). */
  setText(text: string, opts?: { readOnly?: boolean }): void;
  getText(): string;
  getSelection(): Selection;
  /** Types `text` at the cursor (replacing the selection) as the user would. */
  insert(text: string): void;
  setSelection(sel: Selection, scroll?: boolean): void;
  /** Top of the line containing `pos`, relative to the visible editor viewport; undefined if not rendered. */
  measureTop(pos: number): number | undefined;
  viewportHeight(): number;
  /** Scrolls the document by `dy` pixels. */
  scrollBy(dy: number): void;
  onScroll(cb: () => void): () => void;
  focus(): void;
  destroy(): void;
};

export type EditorOptions = {
  parent: HTMLElement;
  doc: string;
  onTransaction: (tr: Transaction) => void;
  onSelection?: (sel: Selection) => void;
  onUndo?: () => boolean;
  onRedo?: () => boolean;
  tracking: TrackingConfig;
  placeholder?: string;
  extraExtensions?: Extension[];
};

export function createEditor(opts: EditorOptions): EditorBridge {
  const readOnly = new Compartment();

  const extensions: Extension[] = [
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    // Undo and redo go through the model, not CodeMirror's history. Handled on keydown rather
    // than via the keymap so Shift variants cannot fall through to the plain binding.
    EditorView.domEventHandlers({
      keydown(e) {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || e.altKey) return false;
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          return e.shiftKey ? (opts.onRedo?.() ?? false) : (opts.onUndo?.() ?? false);
        }
        if (key === 'y' && !e.shiftKey) {
          e.preventDefault();
          return opts.onRedo?.() ?? false;
        }
        return false;
      },
    }),
    keymap.of([...defaultKeymap, ...searchKeymap, ...markdownKeymap, indentWithTab]),
    markdown({ codeLanguages: languages }),
    editorTheme,
    editorHighlighting,
    placeholderExt(opts.placeholder ?? 'Start writing…'),
    trackingExtension(opts.tracking),
    readOnly.of([]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const tr = update.transactions.find((t) => t.docChanged && !t.annotation(fromModel));
        // Several user transactions in one update are rare; take their combined effect.
        if (tr && update.transactions.filter((t) => t.docChanged).length === 1) {
          opts.onTransaction({ changes: intentOf(tr), text: update.state.doc.toString() });
        } else if (update.transactions.some((t) => t.docChanged && !t.annotation(fromModel))) {
          const changes: TextChange[] = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
            changes.push({ from: fromA, to: toA, insert: inserted.toString() }),
          );
          opts.onTransaction({ changes, text: update.state.doc.toString() });
        }
      }
      if (update.selectionSet || update.docChanged) {
        const m = update.state.selection.main;
        opts.onSelection?.({ anchor: m.anchor, head: m.head });
      }
    }),
    ...(opts.extraExtensions ?? []),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: opts.doc, extensions }),
    parent: opts.parent,
  });

  const clamp = (n: number) => Math.max(0, Math.min(n, view.state.doc.length));

  return {
    applyChanges(changes, selection) {
      if (changes.length === 0 && !selection) return;
      view.dispatch({
        changes,
        selection: selection ? EditorSelection.single(selection.anchor, selection.head) : undefined,
        annotations: fromModel.of(true),
        scrollIntoView: !!selection,
      });
    },
    setMarks(info) {
      view.dispatch({ effects: setMarks.of(info) });
    },
    setText(text, o = {}) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        annotations: fromModel.of(true),
        effects: readOnly.reconfigure(
          o.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
        ),
      });
      view.scrollDOM.scrollTop = 0;
    },
    getText: () => view.state.doc.toString(),
    getSelection() {
      const m = view.state.selection.main;
      return { anchor: m.anchor, head: m.head };
    },
    insert(text) {
      // An ordinary user edit: tracking and the model see it like typing.
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: 'input',
        scrollIntoView: true,
      });
      view.focus();
    },
    setSelection(sel, scroll = true) {
      view.dispatch({
        selection: EditorSelection.single(clamp(sel.anchor), clamp(sel.head)),
        scrollIntoView: scroll,
      });
    },
    scrollBy(dy) {
      view.scrollDOM.scrollTop += dy;
    },
    measureTop(pos) {
      const coords = view.coordsAtPos(clamp(pos));
      if (!coords) return undefined;
      return coords.top - view.scrollDOM.getBoundingClientRect().top;
    },
    viewportHeight: () => view.scrollDOM.clientHeight,
    onScroll(cb) {
      view.scrollDOM.addEventListener('scroll', cb, { passive: true });
      return () => view.scrollDOM.removeEventListener('scroll', cb);
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
