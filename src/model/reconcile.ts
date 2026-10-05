/**
 * Re-derives blocks and sentences from a flat span sequence, keeping ids stable.
 *
 * Rule: a new sentence keeps the id of the old sentence that contributed the most of its
 * characters, as long as no other new sentence has a stronger claim on that id. Blocks
 * follow the same rule. Everything else gets a fresh id from the allocator. The old→new
 * mapping is summarised as effects (split, merge, added, removed) for log readers.
 */
import type { Block, Effect, Alloc } from './types';
import { segmentBlocks, segmentSentences } from './segment';
import { regroup, textOf, toSentence, type Tagged } from './spans';
import type { IdGen } from './ids';

export type Allocator = {
  sentence(): string;
  block(): string;
  /** What was handed out, in order. */
  readonly used: Alloc;
};

/** Replays recorded ids when present, otherwise generates (and records) new ones. */
export function makeAllocator(idGen: IdGen, recorded?: Alloc): Allocator {
  const used: Alloc = { sentenceIds: [], blockIds: [] };
  let si = 0;
  let bi = 0;
  return {
    sentence() {
      const id = recorded?.sentenceIds[si++] ?? idGen();
      used.sentenceIds.push(id);
      return id;
    },
    block() {
      const id = recorded?.blockIds[bi++] ?? idGen();
      used.blockIds.push(id);
      return id;
    },
    used,
  };
}

type Claim = { newIndex: number; oldId: string; weight: number };

/** Greedy unique assignment by overlap weight; ties go to earlier new items and document order. */
function assign(weights: Map<string, number>[], fresh: () => string): string[] {
  const claims: Claim[] = [];
  weights.forEach((m, newIndex) => {
    for (const [oldId, weight] of m) claims.push({ newIndex, oldId, weight });
  });
  claims.sort((a, b) => b.weight - a.weight || a.newIndex - b.newIndex);
  const result: (string | undefined)[] = new Array(weights.length).fill(undefined);
  const taken = new Set<string>();
  for (const c of claims) {
    if (result[c.newIndex] !== undefined || taken.has(c.oldId)) continue;
    result[c.newIndex] = c.oldId;
    taken.add(c.oldId);
  }
  return result.map((id) => id ?? fresh());
}

function weightsOf(groups: Tagged[][], key: 'sentenceId' | 'blockId'): Map<string, number>[] {
  return groups.map((spans) => {
    const m = new Map<string, number>();
    for (const s of spans) {
      const id = s[key];
      if (!id) continue;
      m.set(id, (m.get(id) ?? 0) + s.text.length);
    }
    return m;
  });
}

export type ReconcileResult = { blocks: Block[]; effects: Effect[] };

export function reconcile(flat: Tagged[], alloc: Allocator): ReconcileResult {
  const text = textOf(flat);
  const blockRanges = segmentBlocks(text);
  const blockEnds = blockRanges.map((b) => b.to);
  const sentenceEnds = blockRanges.map((b) =>
    segmentSentences(text.slice(b.from, b.to), b.kind).map((e) => b.from + e),
  );
  const { blockSpans } = regroup(flat, blockEnds, sentenceEnds);

  const blockIds = assign(
    weightsOf(
      blockSpans.map((sentences) => sentences.flat()),
      'blockId',
    ),
    () => alloc.block(),
  );
  const allSentences = blockSpans.flat();
  const sentenceIds = assign(weightsOf(allSentences, 'sentenceId'), () => alloc.sentence());

  const blocks: Block[] = [];
  let si = 0;
  blockRanges.forEach((range, bi) => {
    const sentences = blockSpans[bi]!.map((spans) => toSentence(sentenceIds[si++]!, spans));
    blocks.push({ id: blockIds[bi]!, kind: range.kind, attrs: range.attrs, sentences });
  });

  return { blocks, effects: effectsOf(flat, allSentences, sentenceIds, blockSpans, blockIds) };
}

function effectsOf(
  flat: Tagged[],
  newSentences: Tagged[][],
  sentenceIds: string[],
  blockSpans: Tagged[][][],
  blockIds: string[],
): Effect[] {
  const effects: Effect[] = [];
  const oldSentenceIds = new Set(flat.map((s) => s.sentenceId).filter(Boolean));
  const oldBlockIds = new Set(flat.map((s) => s.blockId).filter(Boolean));
  const newSentenceIds = new Set(sentenceIds);
  const newBlockIds = new Set(blockIds);

  // Which new sentences drew text from each old sentence.
  const drewFrom = new Map<string, string[]>();
  newSentences.forEach((spans, i) => {
    const sources = new Set(spans.map((s) => s.sentenceId).filter(Boolean));
    for (const src of sources) {
      const list = drewFrom.get(src) ?? [];
      list.push(sentenceIds[i]!);
      drewFrom.set(src, list);
    }
  });
  for (const [oldId, into] of drewFrom) {
    if (into.length > 1) effects.push({ kind: 'split', sentenceId: oldId, into });
  }
  newSentences.forEach((spans, i) => {
    const sources = [...new Set(spans.map((s) => s.sentenceId).filter(Boolean))];
    if (sources.length > 1)
      effects.push({ kind: 'merge', sentenceIds: sources, into: sentenceIds[i]! });
  });
  for (const id of newSentenceIds)
    if (!oldSentenceIds.has(id)) effects.push({ kind: 'sentence_added', sentenceId: id });
  for (const id of oldSentenceIds)
    if (!newSentenceIds.has(id)) effects.push({ kind: 'sentence_removed', sentenceId: id });
  for (const id of newBlockIds)
    if (!oldBlockIds.has(id)) effects.push({ kind: 'block_added', blockId: id });
  for (const id of oldBlockIds)
    if (!newBlockIds.has(id)) effects.push({ kind: 'block_removed', blockId: id });
  return effects;
}
