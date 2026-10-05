/**
 * Buffer changes that mirror a model op, in the revision coordinates before the op.
 * Used to keep the CodeMirror buffer in step when the model changes outside of typing
 * (accept, reject, undo, redo, and later Claude's proposals).
 */
import type { Op, State } from '../model/types';
import { flatten, keptText, textOf } from '../model/spans';
import { markedRanges, posToAbsolute } from '../model/views';
import type { TextChange } from './tracking';

export function bufferChangesFor(before: State, op: Op): TextChange[] {
  switch (op.type) {
    case 'import': {
      const len = textOf(flatten(before.blocks)).length;
      return [{ from: 0, to: len, insert: op.text }];
    }
    case 'edit': {
      const flat = flatten(before.blocks);
      const from = posToAbsolute(before, op.from);
      const to = posToAbsolute(before, op.to);
      const kept = op.tracked ? keptText(flat, from, to, op.author) : '';
      return [{ from, to, insert: op.insert + kept }];
    }
    case 'accept':
    case 'reject': {
      const ids = new Set(op.changeIds);
      const vanish = op.type === 'accept' ? 'del' : 'ins';
      return markedRanges(before)
        .filter((r) => r.kind === vanish && ids.has(r.changeId))
        .map((r) => ({ from: r.from, to: r.to, insert: '' }));
    }
    case 'splice':
      return [{ from: op.from, to: op.to, insert: op.spans.map((s) => s.text).join('') }];
    default:
      return [];
  }
}

/** A single minimal replacement turning `a` into `b` (common prefix and suffix trimmed). */
export function diffChange(a: string, b: string): TextChange | undefined {
  if (a === b) return undefined;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}
