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

  it('reads guide files side by side, as the app writes them to Style/Guides', () => {
    const grants = '# Grants\n\n- [G1] Open with the problem.\n';
    const blog = '- Write to my future self.\n';
    const guides = readSeed([
      { path: 'Guides/base-style-guide.md', text: BASE },
      { path: 'Guides/grants-2.md', text: grants },
      { path: 'Guides/blog-posts.md', text: blog },
      { path: 'Guides/README.md', text: '- not a guide\n' },
      { path: 'Guides/grants-2.chat.md', text: '- a saved conversation\n' },
      { path: 'Guides/grants-2.conflict-20261006-093000.md', text: grants },
      { path: 'Guides/notes.md', text: 'Prose with no list items.' },
    ]);
    expect(guides.map((g) => [g.role, g.name])).toEqual([
      ['base', 'Base style guide'],
      ['genre', 'Blog posts'],
      ['genre', 'Grants'],
    ]);

    // Picking the whole synced folder finds the guides and leaves documents and samples alone.
    const whole = readSeed([
      { path: 'Shoulder/Style/Guides/base-style-guide.md', text: BASE },
      { path: 'Shoulder/Style/Guides/grants.md', text: grants },
      { path: 'Shoulder/Style/Samples/README.md', text: '- one folder per genre\n' },
      { path: 'Shoulder/Style/Samples/Grants/old-proposal.md', text: '- a list in a sample\n' },
      { path: 'Shoulder/Documents/plan/plan.md', text: '# Plan\n\n- a list in a document\n' },
    ]);
    expect(whole.map((g) => g.name)).toEqual(['Base style guide', 'Grants']);

    // A base guide is recognised by its heading or its ids, whatever the file is called.
    expect(readSeed([{ path: 'x/mine.md', text: '# Base Style Guide\n\n- One.\n' }])[0]!.role).toBe(
      'base',
    );
    expect(readSeed([{ path: 'x/mine.md', text: '# Mine\n\n- [B4] One.\n' }])[0]!.role).toBe(
      'base',
    );
    // Both layouts in one folder: nothing is taken twice.
    const both = readSeed([
      { path: 'x/base.md', text: BASE },
      { path: 'x/base-style-guide.md', text: BASE },
      { path: 'x/grants/guide.md', text: grants },
      { path: 'x/grants.md', text: grants },
    ]);
    expect(both.map((g) => [g.role, g.path])).toEqual([
      ['base', 'x/base.md'],
      ['genre', 'x/grants/guide.md'],
    ]);
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
