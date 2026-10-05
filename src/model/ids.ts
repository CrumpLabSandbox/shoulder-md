/** ULID-style ids: 10 chars of time, 16 of randomness, Crockford base32. Sortable by creation. */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdGen = () => string;

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return time + rand;
}

/** Deterministic ids for tests and replays: s1, s2, ... with an optional prefix. */
export function sequentialIds(prefix = 'id'): IdGen {
  let n = 0;
  return () => `${prefix}${++n}`;
}
