import { describe, it, expect } from 'vitest';
import {
  evidence,
  inboxEdits,
  parseDecisions,
  parseInbox,
  placeReword,
  serializeInbox,
  InboxError,
  type InboxEdit,
} from '../src/guides/inbox';
import { proposalOps } from '../src/folder/proposals';
import { sequentialIds } from '../src/model/ids';
import { harness } from './helpers/model';

describe('the digest of reasoned edits', () => {
  it('keeps the person’s edits that have a reason, pending or decided, and nobody else’s', () => {
    const h = harness('We ran it. The results was significant. Then we stopped. The end.');
    const at = (s: string) => h.rev().indexOf(s);
    h.edit(at('was'), at('was') + 3, 'were', { changeId: 'c1', author: 'me' });
    h.op({ type: 'set_reason', changeId: 'c1', reason: 'agreement' });
    h.edit(at('Then'), at('Then') + 4, 'Finally', { changeId: 'c2', author: 'me' }); // no reason
    h.edit(at('stopped'), at('stopped') + 7, 'halted', { changeId: 'c3', author: 'claude' });
    h.op({ type: 'set_reason', changeId: 'c3', reason: 'by Claude' });
    h.edit(at('The end'), at('The end') + 7, 'Done', { changeId: 'c4', author: 'me' });
    h.op({ type: 'set_group_reason', groupId: 'g', changeIds: ['c4'], reason: 'tighter ending' });
    h.op({ type: 'set_principles', changeId: 'c1', principles: ['B2'] });
    h.accept('c1');
    const edits = inboxEdits(h.doc, { title: 'Results', genre: 'Papers' });
    expect(edits.map((e) => e.id)).toEqual(['doc:c1', 'doc:c4']);
    expect(edits[0]).toMatchObject({
      document: 'Results',
      genre: 'Papers',
      before: 'was',
      after: 'were',
      sentenceBefore: 'The results was significant.',
      sentenceAfter: 'The results were significant.',
      reason: 'agreement',
      principles: ['B2'],
      outcome: 'accepted',
    });
    expect(edits[1]).toMatchObject({ setReason: 'tighter ending', outcome: 'pending' });
    expect(edits[1]!.reason).toBeUndefined();
    expect(inboxEdits(h.doc, { title: 'x' })[0]!.genre).toBeUndefined();
  });
});

describe('inbox files', () => {
  it('parses suggestions and links, tidying what Claude may add', () => {
    const inbox = parseInbox(
      JSON.stringify({
        suggestions: [
          {
            kind: 'new',
            guide: 'base',
            section: '## Words',
            principle: '- [B9] Cut wind-ups.',
            edits: ['d:1', 'd:2', 4],
            reason: ' why ',
          },
          {
            kind: 'reword',
            guide: 'Grants',
            id: 'G3',
            principle: 'Say the aims early.',
            edits: ['d:3'],
          },
          { principle: 'No guide given.' },
        ],
        links: [
          { edit: 'd:4', principles: ['B2'], reason: 'r' },
          { edit: '', principles: ['B1'] },
          { edit: 'd:5' },
        ],
      }),
    );
    expect(inbox.suggestions).toEqual([
      {
        kind: 'new',
        guide: 'base',
        section: 'Words',
        principle: 'Cut wind-ups.',
        edits: ['d:1', 'd:2'],
        reason: 'why',
      },
      {
        kind: 'reword',
        guide: 'Grants',
        id: 'G3',
        principle: 'Say the aims early.',
        edits: ['d:3'],
      },
      { kind: 'new', guide: 'base', principle: 'No guide given.', edits: [] },
    ]);
    expect(inbox.links).toEqual([{ edit: 'd:4', principles: ['B2'], reason: 'r' }]);
    expect(parseInbox(serializeInbox(inbox))).toEqual(inbox);
    expect(parseInbox('{}')).toEqual({ suggestions: [], links: [] });
    expect(() => parseInbox('nope')).toThrow(InboxError);
    expect(() => parseInbox('{"suggestions":[{"kind":"reword","principle":"x"}]}')).toThrow(
      InboxError,
    );
    expect(parseDecisions(undefined)).toEqual([]);
    expect(parseDecisions('broken')).toEqual([]);
    expect(
      parseDecisions('{"decisions":[{"at":"t","action":"dismissed","principle":"p"}]}'),
    ).toHaveLength(1);
  });

  it('describes the edits behind a suggestion in a line each', () => {
    const edits: InboxEdit[] = [
      {
        id: 'd:1',
        document: 'Plan',
        before: 'is going to',
        after: 'will',
        sentenceBefore: '',
        sentenceAfter: '',
        reason: 'direct',
        principles: [],
        outcome: 'accepted',
      },
      {
        id: 'd:2',
        document: 'Plan',
        before: '',
        after: 'new words',
        sentenceBefore: '',
        sentenceAfter: '',
        setReason: 'set why',
        principles: [],
        outcome: 'pending',
      },
      {
        id: 'd:3',
        document: 'Letter',
        before: 'gone',
        after: '',
        sentenceBefore: '',
        sentenceAfter: '',
        principles: [],
        outcome: 'accepted',
      },
    ];
    const s = {
      kind: 'new' as const,
      guide: 'base',
      principle: 'p',
      edits: ['d:1', 'nope', 'd:2', 'd:3'],
    };
    expect(evidence(s, edits)).toEqual([
      '"is going to" → "will" (Plan: direct)',
      'added "new words" (Plan: set why)',
    ]);
    expect(evidence(s, edits, 3)[2]).toBe('cut "gone" (Letter)');
  });

  it('rewords a principle in place, keeping its id', () => {
    const guide =
      '# Grants\n\n- [G1] Open with the problem.\n  - example\n- [G2 replaces B3] Write formal sentences.\n';
    const h = harness(guide);
    const placed = placeReword(h.clean(), 'G2', 'Write formal, declarative sentences.')!;
    expect(h.clean().slice(placed.from, placed.to)).toBe('');
    expect(placed.insert).toContain('declarative');
    const id = sequentialIds('p');
    for (const item of proposalOps([placed], { author: 'claude', ts: 't', id }))
      h.applyOps([typeof item === 'function' ? item(h.state)! : item]);
    expect(h.clean()).toContain('- [G2 replaces B3] Write formal, declarative sentences.');
    expect(h.original()).toBe(guide);
    expect(placeReword(guide, 'G9', 'x')).toBeUndefined();
    expect(placeReword(guide, 'G1', 'Open with the problem.')).toBeUndefined();
  });
});
