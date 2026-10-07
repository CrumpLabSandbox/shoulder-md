import { describe, it, expect } from 'vitest';
import { numbered, readSeed, seedAdditions, seedPrefix } from '../src/guides/seed';
import { parsePrinciples, principleItems } from '../src/guides/principles';

const BASE = `# Base style guide

Intro text.

- [B1] Every paragraph has one topic.
  - Example: a nested note.
- [B2] Say why each sentence is there.
`;

describe('seed folders', () => {
  it('finds base.md and each genre guide, wherever the picked folder starts', () => {
    const guides = readSeed([
      { path: 'TrainingContent/seed/blog/guide.md', text: '# Blog posts\n\n- [BL1] Be direct.\n' },
      { path: 'TrainingContent/seed/base.md', text: BASE },
      { path: 'TrainingContent/seed/papers/guide.md', text: '- No heading here.\n' },
      { path: 'TrainingContent/seed/blog/sample.md', text: 'ignored' },
      { path: 'TrainingContent/seed/.hidden/guide.md', text: 'ignored' },
      { path: 'guide.md', text: 'no folder, ignored' },
    ]);
    expect(guides.map((g) => [g.role, g.name])).toEqual([
      ['base', 'Base style guide'],
      ['genre', 'Blog posts'],
      ['genre', 'papers'],
    ]);
    expect(seedPrefix(guides[1]!.text)).toBe('BL');
    expect(seedPrefix(guides[2]!.text)).toBeUndefined();
  });

  it('lists items with their nested lines, and numbers a new guide', () => {
    const items = principleItems(BASE);
    expect(items.map((i) => i.id)).toEqual(['B1', 'B2']);
    expect(items[0]!.raw).toBe(
      '- [B1] Every paragraph has one topic.\n  - Example: a nested note.',
    );
    const text = numbered('# G\n\n- First.\n- [P4] Kept.\n- Second.\n', 'P');
    expect(parsePrinciples(text).principles.map((p) => p.id)).toEqual(['P5', 'P4', 'P6']);
  });

  it('appends only what an existing guide lacks, and is idempotent', () => {
    const mine = `# Base style guide

- [B1] Every paragraph has one topic, reworded by me.
- [B7] Say why each sentence is there.
- Unnumbered thing of my own.
`;
    const seed = BASE + '- [B3] A new one.\n  - With an example.\n- Another without an id.\n';
    const { append, added } = seedAdditions(mine, seed, 'B');
    // B1 is there by id (reworded), B2 by wording (as B7); two are new.
    expect(added).toBe(2);
    const merged = mine + append;
    expect(merged.startsWith(mine)).toBe(true);
    const ps = parsePrinciples(merged);
    // B8 is held back for my own unnumbered item, which comes first in the guide.
    expect(ps.principles.map((p) => p.id)).toEqual(['B1', 'B7', 'B3', 'B9']);
    expect(ps.unnumbered).toHaveLength(1); // my own unnumbered item is left alone
    expect(merged).toContain('- [B3] A new one.\n  - With an example.');
    expect(seedAdditions(merged, seed, 'B')).toEqual({ append: '', added: 0 });
  });

  it('renumbers ids that belong to another prefix', () => {
    const { append } = seedAdditions('# Blog\n\n- [BL1] One.\n', '- [X9] Two.\n', 'BL');
    expect(append).toBe('\n- [BL2] Two.\n');
  });
});
