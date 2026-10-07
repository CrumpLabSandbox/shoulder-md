/**
 * Folds a keystroke into the edit op before it, so a run of typing is one op in the log rather
 * than one per character. The longer op is applied to the state the run started from, and is
 * only offered when the result has the same text and marks as applying the keystroke on its
 * own; the caller then adopts the returned state, so the log still replays to the state.
 */
import type { Alloc, Op, State } from './types';
import { applyOp, type Applied, type ApplyContext } from './apply';
import { flatten, marksOf, textOf } from './spans';
import { commentRanges } from './views';

export type EditOp = Extract<Op, { type: 'edit' }>;

/** A keystroke at the end of the run: text typed there, or characters backspaced off it. */
export type TypingStep = { insert: string; cut: number };

/** Text and marks, without the sentence and block ids (those are re-derived). */
function runs(state: State): string {
  const out: [string, string][] = [];
  for (const s of flatten(state.blocks)) {
    const mark = JSON.stringify([s.kind, s.kind === 'text' ? {} : marksOf(s)]);
    const last = out[out.length - 1];
    if (last && last[0] === mark) last[1] += s.text;
    else out.push([mark, s.text]);
  }
  return JSON.stringify(out);
}

function records(state: State): string {
  return JSON.stringify(
    Object.values(state.changes)
      .map((c) => [c.id, c.author, c.tracked, c.status])
      .sort(),
  );
}

/**
 * `base` is the state before `run` was applied, `after` the state after the keystroke was
 * applied on its own, and `hints` the ids that application allocated (reused so sentence ids
 * do not churn while typing). Returns undefined when the keystroke cannot be folded in.
 */
export function extendEdit(
  base: State,
  run: EditOp,
  step: TypingStep,
  after: State,
  hints?: Alloc,
  ctx: ApplyContext = {},
): Applied | undefined {
  let insert: string;
  if (step.cut === 0 && step.insert) insert = run.insert + step.insert;
  else if (!step.insert && step.cut > 0 && step.cut < run.insert.length)
    insert = run.insert.slice(0, run.insert.length - step.cut);
  else return undefined;

  const { alloc, effects: _effects, ...rest } = run;
  void _effects;
  const merged: EditOp = {
    ...rest,
    insert,
    alloc: {
      sentenceIds: [...(alloc?.sentenceIds ?? []), ...(hints?.sentenceIds ?? [])],
      blockIds: [...(alloc?.blockIds ?? []), ...(hints?.blockIds ?? [])],
    },
  };
  let applied: Applied;
  try {
    applied = applyOp(base, merged, ctx);
  } catch {
    return undefined;
  }
  const s = applied.state;
  if (runs(s) !== runs(after) || records(s) !== records(after)) return undefined;
  if (JSON.stringify(commentRanges(s)) !== JSON.stringify(commentRanges(after))) return undefined;
  return applied;
}

type SpliceOp = Extract<Op, { type: 'splice' }>;

/**
 * One splice that does what `first` then `then` do, for the case undo needs: `then` replaces a
 * range that contains everything `first` put in (undoing a run of typing keystroke by keystroke
 * is that, newest first). Returns undefined for any other pair.
 */
export function composeSplices(first: Op, then: Op): Op | undefined {
  if (first.type !== 'splice' || then.type !== 'splice') return undefined;
  const put = textOf(first.spans).length;
  if (first.from < then.from || first.from + put > then.to) return undefined;
  const { alloc: _a, effects: _e, ...rest } = then;
  void _a;
  void _e;
  const out: SpliceOp = { ...rest, to: then.to - put + (first.to - first.from) };
  if (first.records || then.records) out.records = { ...first.records, ...then.records };
  return out;
}
