import { describe, it, expect } from 'vitest';
import { harness, type Harness } from './helpers/model';
import { memoryDir } from './helpers/memfs';
import { FLAT, FolderSync, memoryFolderStore } from '../src/folder/sync';
import {
  alignRevision,
  parseProposals,
  parseRevision,
  placeProposals,
  proposalOps,
  ProposalError,
  type Proposal,
} from '../src/folder/proposals';
import { pendingChanges } from '../src/model/changes';
import { replay } from '../src/model/apply';
import { sequentialIds } from '../src/model/ids';

const TEXT =
  '# Plan\n\nThe project is going to be done in the summer. It is new.\n\nThe project needs funds. Results will be shared.\n';

function apply(h: Harness, proposals: Proposal[], known?: string[]) {
  const { placed, skipped } = placeProposals(h.clean(), proposals);
  const id = sequentialIds('p');
  for (const item of proposalOps(placed, { author: 'claude', ts: 't', id, known })) {
    h.applyOps([typeof item === 'function' ? item(h.state)! : item]);
  }
  return { placed, skipped };
}

describe('proposals', () => {
  it('parses a proposals file and rejects malformed ones', () => {
    const f = parseProposals(
      JSON.stringify({
        document: 'd1',
        proposals: [
          { quote: 'a', replacement: 'b', reason: ' why ', principles: ['G1', 3], extra: true },
          { quote: 'c', replacement: '' },
        ],
      }),
    );
    expect(f).toEqual({
      document: 'd1',
      proposals: [
        { quote: 'a', replacement: 'b', reason: 'why', principles: ['G1'] },
        { quote: 'c', replacement: '' },
      ],
    });
    expect(() => parseProposals('{ nope')).toThrow(ProposalError);
    expect(() => parseProposals('{"proposals": {}}')).toThrow(ProposalError);
    expect(() => parseProposals('{"proposals": [{"quote": "a"}]}')).toThrow(ProposalError);
  });

  it('places a quote that occurs once and narrows it to the words that change', () => {
    const { placed, skipped } = placeProposals(TEXT, [
      {
        quote: 'is going to be done in the summer',
        replacement: 'will be completed in the summer',
      },
    ]);
    expect(skipped).toEqual([]);
    expect(TEXT.slice(placed[0]!.from, placed[0]!.to)).toBe('is going to be done');
    expect(placed[0]!.insert).toBe('will be completed');
  });

  it('skips quotes that are missing, repeated, unchanged, or overlap an earlier proposal', () => {
    const { placed, skipped } = placeProposals(TEXT, [
      { quote: 'It is new.', replacement: 'It is novel.' },
      { quote: 'The project', replacement: 'This work' },
      { quote: 'not in the text', replacement: 'x' },
      { quote: 'needs funds', replacement: 'needs funds' },
      { quote: 'is new', replacement: 'is brand new' },
    ]);
    expect(placed).toHaveLength(1);
    expect(skipped.map((s) => s.why)).toEqual(['ambiguous', 'not-found', 'no-change', 'overlap']);
  });

  it('matches across a line wrap when the quote differs only in whitespace', () => {
    const wrapped = 'One two\nthree four. Five.';
    const { placed } = placeProposals(wrapped, [
      { quote: 'two three four', replacement: 'two three five' },
    ]);
    expect(wrapped.slice(placed[0]!.from, placed[0]!.to)).toBe('four');
    expect(placed[0]!.insert).toBe('five');
  });

  it('becomes one tracked change per proposal by Claude, with reason and known principles', () => {
    const h = harness(TEXT);
    // A pending edit of my own elsewhere must not get in the way.
    h.edit(2, 6, 'Proposal', { changeId: 'mine' });
    const { skipped } = apply(
      h,
      [
        {
          quote: 'is going to be done in the summer',
          replacement: 'will be completed in the summer',
          reason: 'Say it directly.',
          principles: ['G25', 'ZZ9'],
        },
        { quote: 'Results will be shared.', replacement: 'Results will be shared openly.' },
        { quote: ' It is new.', replacement: '' },
      ],
      ['G25', 'B1'],
    );
    expect(skipped).toEqual([]);
    expect(h.clean()).toBe(
      '# Proposal\n\nThe project will be completed in the summer.\n\nThe project needs funds. Results will be shared openly.\n',
    );
    expect(h.original()).toBe(TEXT);
    const claude = pendingChanges(h.state).filter((c) => c.author === 'claude');
    expect(claude).toHaveLength(3);
    const first = claude.find((c) => c.after === 'will be completed')!;
    expect(first.before).toBe('is going to be done');
    expect(first.record).toMatchObject({
      author: 'claude',
      tracked: true,
      status: 'pending',
      reason: 'Say it directly.',
      principles: ['G25'],
    });
    expect(claude.find((c) => c.after === ' openly')!.record.reason).toBeUndefined();
    expect(claude.find((c) => c.before === ' It is new.')!.after).toBe('');
    expect(replay(h.doc.ops)).toEqual(h.state);
    // Rejecting them all gives back what I had.
    h.reject(...claude.map((c) => c.id));
    expect(h.clean()).toBe(TEXT.replace('Plan', 'Proposal'));
  });

  it('reads a revision file: an optional reason comment, then the whole document', () => {
    expect(
      parseRevision('<!-- reason: Reorganised around\n the aims. -->\n\n# Plan\n\nText.\n'),
    ).toEqual({ reason: 'Reorganised around the aims.', text: '# Plan\n\nText.\n' });
    expect(parseRevision('# Plan\n\nText.')).toEqual({ text: '# Plan\n\nText.' });
    expect(parseRevision('<!-- reason:  -->\nText')).toEqual({ text: 'Text' });
    // The document's own leading and trailing whitespace is kept, so it is not a change.
    expect(alignRevision('\n# Plan\n\nOld.\n\n', '# Plan\n\nNew.')).toBe('\n# Plan\n\nNew.\n\n');
    expect(alignRevision('Old.', '\n\nNew.\n')).toBe('New.');
  });

  it('keeps a revision file beside its document, and removes it once handled', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore());
    const h = harness('# My Plan\n\nHello there.');
    await sync.write(h.doc);
    expect(await sync.revision('doc')).toBeUndefined();
    fs.writeOutside(
      'Documents/my-plan/my-plan.revision.md',
      '<!-- reason: x -->\n# My Plan\n\nHi.',
    );
    expect(await sync.revision('doc')).toMatchObject({ file: 'my-plan.revision.md' });
    expect(await sync.check(h.doc)).toEqual({ kind: 'none' });
    expect(await sync.scan(['doc'], [])).toEqual([]);
    await sync.clearRevision('doc');
    expect(fs.names()).toEqual([
      'Documents/my-plan/my-plan.md',
      'Documents/my-plan/my-plan.shoulder.json',
    ]);
  });

  it('is found next to the document in the folder, and cleared once handled', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), undefined, FLAT);
    const h = harness('# My Plan\n\nHello there.');
    await sync.write(h.doc);
    expect(await sync.proposals('doc')).toBeUndefined();
    fs.writeOutside('my-plan.proposals.json', '{"proposals": []}');
    const found = await sync.proposals('doc');
    expect(found).toMatchObject({ file: 'my-plan.proposals.json', text: '{"proposals": []}' });
    fs.writeOutside('my-plan.proposals.json', '{"proposals": [] }');
    expect((await sync.proposals('doc'))!.key).not.toBe(found!.key);
    // The proposals file is not mistaken for a document or an outside edit.
    expect(await sync.check(h.doc)).toEqual({ kind: 'none' });
    expect(await sync.scan(['doc'], [])).toEqual([]);
    await sync.clearProposals('doc', 'left');
    expect(fs.names()).toEqual([
      'my-plan.md',
      'my-plan.proposals.skipped.json',
      'my-plan.shoulder.json',
    ]);
    await sync.clearProposals('doc');
    expect(await sync.proposals('doc')).toBeUndefined();
  });
});
