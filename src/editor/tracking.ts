/**
 * Track-changes support for the CodeMirror buffer.
 *
 * The buffer holds the revision text (pending deletions included). This extension:
 *  - decorates insertions and deletions from the model's marked ranges, coloured by author;
 *  - makes pending deletions atomic, so the cursor skips them and typing cannot land inside;
 *  - rewrites user transactions while tracking is on so that deleted text stays in the buffer
 *    (what the model keeps as `del` spans), recording the user's original intent as an
 *    annotation for the adapter to turn into model ops;
 *  - turns a deletion that would only cover pending deletions into a cursor move.
 */
import {
  Annotation,
  EditorState,
  Facet,
  RangeSet,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { CommentRange, MarkedRange } from '../model/views';

/** One replaced range, in the coordinates of the document before the transaction. */
export type TextChange = { from: number; to: number; insert: string };

/** Marks a transaction that mirrors a model change; the adapter must not feed it back. */
export const fromModel = Annotation.define<boolean>();

/** The user's original changes, before the tracking rewrite kept deleted text in place. */
export const userIntent = Annotation.define<TextChange[]>();

export type TrackingConfig = {
  isTracking(): boolean;
  /** What a tracked deletion of [from, to) keeps in the buffer (see model keptText). */
  keptText(from: number, to: number): string;
  /** Whether [from, to) is already entirely pending deletions (see model onlyPendingDeletions). */
  onlyPendingDeletions(from: number, to: number): boolean;
};

export const trackingConfig = Facet.define<TrackingConfig, TrackingConfig | undefined>({
  combine: (values) => values[0],
});

export type MarkInfo = {
  ranges: MarkedRange[];
  colors: Record<string, string>;
  activeChangeId?: string;
  comments?: CommentRange[];
  activeThreadId?: string;
  /** A comment being composed: highlighted like a thread until it is posted or cancelled. */
  draft?: { from: number; to: number };
};

export const setMarks = StateEffect.define<MarkInfo>();

type MarksValue = { decorations: DecorationSet; atomic: RangeSet<Decoration> };

const atomicMark = Decoration.mark({ class: 'cm-del-atomic' });

function build(info: MarkInfo): MarksValue {
  const decos = [];
  const atoms = [];
  for (const r of info.ranges) {
    if (r.to <= r.from) continue;
    const color = info.colors[r.author] ?? 'var(--accent)';
    const active = r.changeId === info.activeChangeId;
    decos.push(
      Decoration.mark({
        class: `cm-${r.kind}${active ? ' cm-change-active' : ''}`,
        attributes: { style: `--author-color:${color}`, 'data-change': r.changeId },
      }).range(r.from, r.to),
    );
    if (r.kind === 'del') atoms.push(atomicMark.range(r.from, r.to));
  }
  for (const c of info.comments ?? []) {
    if (c.to <= c.from || c.resolved) continue;
    const active = c.threadId === info.activeThreadId;
    decos.push(
      Decoration.mark({
        class: `cm-comment${active ? ' cm-comment-active' : ''}`,
        attributes: { 'data-thread': c.threadId },
      }).range(c.from, c.to),
    );
  }
  if (info.draft && info.draft.to > info.draft.from) {
    decos.push(
      Decoration.mark({ class: 'cm-comment cm-comment-active' }).range(
        info.draft.from,
        info.draft.to,
      ),
    );
  }
  decos.sort((a, b) => a.from - b.from || a.to - b.to);
  atoms.sort((a, b) => a.from - b.from);
  return { decorations: Decoration.set(decos, true), atomic: RangeSet.of(atoms, true) };
}

export const marksField = StateField.define<MarksValue>({
  create: () => ({ decorations: Decoration.none, atomic: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return build(e.value);
    if (tr.docChanged) {
      return {
        decorations: value.decorations.map(tr.changes),
        atomic: value.atomic.map(tr.changes),
      };
    }
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

/** Keeps deleted text in the buffer while tracking is on. */
export const trackingFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(fromModel)) return tr;
  const cfg = tr.startState.facet(trackingConfig);
  if (!cfg || !cfg.isTracking()) return tr;

  const intent: TextChange[] = [];
  const specs: TextChange[] = [];
  let rewritten = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insert = inserted.toString();
    const kept = toA > fromA ? cfg.keptText(fromA, toA) : '';
    intent.push({ from: fromA, to: toA, insert });
    specs.push({ from: fromA, to: toA, insert: insert + kept });
    if (kept.length > 0) rewritten = true;
  });
  if (!rewritten) return tr;

  const userEvent = tr.annotation(Transaction.userEvent) ?? 'input';
  const skip = intent.every((c) => c.insert === '' && cfg.onlyPendingDeletions(c.from, c.to));
  if (skip) {
    // Only pending deletions would be deleted: skip over them instead.
    const forward = userEvent.startsWith('delete.forward');
    const first = intent[0]!;
    const last = intent[intent.length - 1]!;
    const anchor = forward ? last.to : first.from;
    return {
      selection: { anchor },
      scrollIntoView: true,
      annotations: Transaction.userEvent.of(userEvent),
    };
  }

  const single = intent.length === 1 ? intent[0] : undefined;
  return {
    changes: specs,
    selection: single ? { anchor: single.from + single.insert.length } : undefined,
    scrollIntoView: tr.scrollIntoView,
    annotations: [userIntent.of(intent), Transaction.userEvent.of(userEvent)],
  };
});

export const trackingTheme = EditorView.baseTheme({
  '.cm-ins': {
    color: 'var(--author-color)',
    textDecoration: 'underline',
    textDecorationColor: 'var(--author-color)',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '2px',
  },
  '.cm-del': {
    color: 'var(--author-color)',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--author-color)',
    opacity: '0.72',
  },
  '.cm-comment': {
    backgroundColor: 'color-mix(in srgb, #eab308 28%, transparent)',
    borderBottom: '2px solid color-mix(in srgb, #eab308 70%, transparent)',
  },
  '.cm-comment-active': {
    backgroundColor: 'color-mix(in srgb, #eab308 45%, transparent)',
  },
  '.cm-change-active': {
    backgroundColor: 'color-mix(in srgb, var(--author-color) 14%, transparent)',
    borderRadius: '2px',
  },
});

export function trackingExtension(config: TrackingConfig) {
  return [trackingConfig.of(config), marksField, trackingFilter, trackingTheme];
}

/** The user's changes for a transaction: the recorded intent, else the transaction's own changes. */
export function intentOf(tr: Transaction): TextChange[] {
  const recorded = tr.annotation(userIntent);
  if (recorded) return recorded;
  const out: TextChange[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return out;
}
