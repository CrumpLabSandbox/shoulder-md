import { describe, it, expect } from 'vitest';
import {
  genrePrefix,
  nextIds,
  numberingEdits,
  parsePrinciples,
  resolvePrinciples,
  baseGuideTemplate,
  genreGuideTemplate,
} from '../src/guides/principles';
import { harness } from './helpers/model';
import { docStats } from '../src/library/stats';
import { changeRecords } from '../src/library/records';
import { replay } from '../src/model/apply';

const GUIDE = `# Base style guide

Intro paragraph.

> - [X1] A quoted list is not a principle.

- [B1] Prefer the active voice
  unless the actor is unknown.
  - An explanation, not a principle.
- [B3] Cut "very".
- A new principle without an id.
-   

1. [B2] Numbered lists work too.
`;

describe('parsePrinciples', () => {
  it('reads top-level list items with ids and finds new ones', () => {
    const p = parsePrinciples(GUIDE);
    expect(p.principles).toEqual([
      { id: 'B1', text: 'Prefer the active voice unless the actor is unknown.' },
      { id: 'B3', text: 'Cut "very".' },
      { id: 'B2', text: 'Numbered lists work too.' },
    ]);
    expect(p.unnumbered.map((at) => GUIDE.slice(at, at + 5))).toEqual(['A new']);
  });

  it('reads replacements in genre guides', () => {
    expect(parsePrinciples('- [P1 replaces B3] Keep "very" in quotes.\n').principles).toEqual([
      { id: 'P1', text: 'Keep "very" in quotes.', replaces: 'B3' },
    ]);
  });

  it('templates parse to no principles', () => {
    expect(parsePrinciples(baseGuideTemplate())).toEqual({ principles: [], unnumbered: [] });
    expect(parsePrinciples(genreGuideTemplate('Papers', 'P'))).toEqual({
      principles: [],
      unnumbered: [],
    });
  });
});

describe('ids', () => {
  it('numbers after the highest id and inserts last first', () => {
    expect(nextIds('B', ['B1', 'B3', 'P9'], 2)).toEqual(['B4', 'B5']);
    const text = '- [B2] One\n- Two\n- Three\n';
    const edits = numberingEdits(text, 'B');
    let out = text;
    for (const e of edits) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
    expect(out).toBe('- [B2] One\n- [B3] Two\n- [B4] Three\n');
  });

  it('picks short unique genre prefixes', () => {
    expect(genrePrefix('Papers', ['B'])).toBe('P');
    expect(genrePrefix('Proposals', ['B', 'P'])).toBe('PR');
    expect(genrePrefix('Bio', ['B', 'BI', 'BIO'])).toBe('B2');
    expect(genrePrefix('123', ['B'])).toBe('G');
  });
});

describe('resolvePrinciples', () => {
  it('adds genre principles and lets them replace base ones', () => {
    const base = [
      { id: 'B1', text: 'one' },
      { id: 'B3', text: 'three' },
    ];
    const genre = [{ id: 'P1', text: 'p-one', replaces: 'B3' }];
    expect(resolvePrinciples(base, genre)).toEqual([
      { id: 'B1', text: 'one', source: 'base' },
      { id: 'P1', text: 'p-one', replaces: 'B3', source: 'genre' },
    ]);
    expect(resolvePrinciples(base)).toHaveLength(2);
  });
});

describe('guides in the model and the dataset', () => {
  it("stats carry a guide's principles; set_principles links them to a change and replays", () => {
    const g = harness(GUIDE, { tracking: false });
    g.op({ type: 'set_meta', patch: { guide: { role: 'base', prefix: 'B' } } });
    expect(docStats(g.state).guide).toMatchObject({ role: 'base', prefix: 'B', unnumbered: 1 });
    expect(docStats(g.state).guide!.principles.map((p) => p.id)).toEqual(['B1', 'B3', 'B2']);

    const h = harness('The results was very significant.');
    h.op({ type: 'set_meta', patch: { genre: 'papers-doc', claude: false } });
    h.edit(12, 15, 'were', { changeId: 'c1' });
    h.op({ type: 'set_principles', changeId: 'c1', principles: ['B9', 'P1'] });
    expect(h.state.changes['c1']!.principles).toEqual(['B9', 'P1']);
    expect(docStats(h.state)).toMatchObject({ genre: 'papers-doc', claude: false });
    h.accept('c1');
    const [row] = changeRecords(h.doc, {
      principleTexts: { P1: 'Report results in the past tense.' },
      genreName: 'Papers',
    });
    expect(row).toMatchObject({
      genre: 'Papers',
      principles: [{ id: 'B9' }, { id: 'P1', text: 'Report results in the past tense.' }],
    });
    h.op({ type: 'set_meta', patch: { genre: null, claude: null } });
    expect(h.state.meta.genre).toBeUndefined();
    expect('claude' in h.state.meta).toBe(false);
    h.op({ type: 'set_principles', changeId: 'c1', principles: [] });
    expect(h.state.changes['c1']!.principles).toBeUndefined();
    expect(replay(h.doc.ops)).toEqual(h.state);
  });
});
