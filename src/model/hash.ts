import type { State } from './types';

/** FNV-1a over a canonical serialization. Cheap integrity check for snapshots. */
export function hashState(state: State): string {
  const s = JSON.stringify([
    state.blocks,
    state.changes,
    state.comments,
    state.trackingOn,
    state.meta,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
