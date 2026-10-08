/**
 * Where the margin's cards go. Each card wants to sit beside its text, but cards cannot
 * overlap, so some must move. The card that keeps its place is the one the reader is looking
 * at: the active one if it is on screen, otherwise the one nearest the upper part of the view.
 * Cards after it are pushed down and cards before it are pushed up, off the top if need be,
 * so scrolling the document always brings the cards for the text in view alongside it.
 */
export type CardSlot = {
  key: string;
  /** Top of the card's text relative to the visible editor; undefined when it is not rendered. */
  wanted: number | undefined;
  height: number;
  active?: boolean;
};

/** Cards for text that is not rendered are parked here, out of sight. */
export const OFFSCREEN = -10_000;

export function layoutCards(
  cards: readonly CardSlot[],
  viewport: number,
  gap: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const known: (CardSlot & { wanted: number })[] = [];
  for (const c of cards) {
    if (c.wanted === undefined) out[c.key] = OFFSCREEN;
    else known.push(c as CardSlot & { wanted: number });
  }
  if (known.length === 0) return out;

  const inView = (c: { wanted: number }) => c.wanted >= 0 && c.wanted <= viewport;
  const focus = viewport / 3;
  let pivot = known.findIndex((c) => c.active && inView(c));
  if (pivot < 0) {
    let best = Infinity;
    known.forEach((c, i) => {
      if (!inView(c)) return;
      const d = Math.abs(c.wanted - focus);
      if (d < best) {
        best = d;
        pivot = i;
      }
    });
  }
  // Nothing on screen: keep the first card below the view where it is, or failing that the last.
  if (pivot < 0) pivot = known.findIndex((c) => c.wanted > viewport);
  if (pivot < 0) pivot = known.length - 1;

  const p = known[pivot]!;
  // The pivot stays beside its text, nudged only enough to be fully visible.
  const top = inView(p)
    ? Math.min(Math.max(p.wanted, 0), Math.max(0, viewport - p.height))
    : p.wanted;
  out[p.key] = top;
  let floor = top + p.height + gap;
  for (let i = pivot + 1; i < known.length; i++) {
    const c = known[i]!;
    const t = Math.max(c.wanted, floor);
    out[c.key] = t;
    floor = t + c.height + gap;
  }
  let ceiling = top - gap;
  for (let i = pivot - 1; i >= 0; i--) {
    const c = known[i]!;
    const t = Math.min(c.wanted, ceiling - c.height);
    out[c.key] = t;
    ceiling = t - gap;
  }
  return out;
}
