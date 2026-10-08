import { describe, it, expect } from 'vitest';
import { layoutCards, OFFSCREEN, type CardSlot } from '../src/ui/marginLayout';

const card = (
  key: string,
  wanted: number | undefined,
  extra: Partial<CardSlot> = {},
): CardSlot => ({
  key,
  wanted,
  height: 100,
  ...extra,
});
const overlaps = (tops: Record<string, number>, cards: CardSlot[], gap: number) => {
  const placed = cards
    .filter((c) => c.wanted !== undefined)
    .map((c) => ({ top: tops[c.key]!, bottom: tops[c.key]! + c.height }))
    .sort((a, b) => a.top - b.top);
  return placed.some((p, i) => i > 0 && p.top < placed[i - 1]!.bottom + gap);
};

describe('margin card layout', () => {
  it('leaves cards beside their text when there is room', () => {
    const cards = [card('a', 20), card('b', 300), card('c', 600)];
    expect(layoutCards(cards, 800, 6)).toEqual({ a: 20, b: 300, c: 600 });
  });

  it('keeps the cards for text in view on screen when many changes sit above it', () => {
    // Thirty changes scrolled past (rendered just above the view), then two in view.
    const above = Array.from({ length: 30 }, (_, i) => card(`up${i}`, -900 + i * 30));
    const cards = [...above, card('here', 250), card('next', 420)];
    const tops = layoutCards(cards, 800, 6);
    expect(tops.here).toBe(250);
    expect(tops.next).toBe(420);
    // The ones above are stacked upward, out of the way, in order and without overlapping.
    expect(tops.up29).toBeLessThanOrEqual(250 - 6 - 100);
    expect(tops.up0!).toBeLessThan(tops.up29!);
    expect(overlaps(tops, cards, 6)).toBe(false);
  });

  it('gives the active change its place, and fits the others around it', () => {
    // Five changes on neighbouring lines: their cards cannot all sit beside them.
    const cards = [0, 1, 2, 3, 4].map((i) => card(`c${i}`, 300 + i * 24, { active: i === 3 }));
    const tops = layoutCards(cards, 800, 6);
    expect(tops.c3).toBe(372);
    expect(tops.c4).toBe(372 + 106);
    expect(tops.c2).toBe(372 - 106);
    expect(tops.c0).toBe(372 - 3 * 106);
    expect(overlaps(tops, cards, 6)).toBe(false);
    // Without an active one, the card nearest the upper third of the view keeps its place.
    const calm = layoutCards(
      cards.map((c) => ({ ...c, active: false })),
      800,
      6,
    );
    expect(calm.c0).toBe(300);
  });

  it('nudges the card in focus fully into view, and parks cards for unrendered text', () => {
    const tops = layoutCards([card('far', undefined), card('low', 780, { height: 120 })], 800, 6);
    expect(tops.far).toBe(OFFSCREEN);
    expect(tops.low).toBe(680);
    // An active change that is off screen does not drag the layout to it.
    const off = layoutCards([card('gone', -400, { active: true }), card('seen', 100)], 800, 6);
    expect(off.seen).toBe(100);
    expect(off.gone).toBeLessThan(0);
  });

  it('with nothing in view, lets cards sit where their text is', () => {
    const tops = layoutCards([card('a', -500), card('b', -300), card('c', 1200)], 800, 6);
    expect(tops).toEqual({ a: -500, b: -300, c: 1200 });
    expect(layoutCards([], 800, 6)).toEqual({});
  });
});
