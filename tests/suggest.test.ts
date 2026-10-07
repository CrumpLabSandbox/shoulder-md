import { describe, it, expect } from 'vitest';
import {
  parseSuggestions,
  placeSuggestions,
  suggestionOps,
  SuggestionError,
  type Suggestion,
} from '../src/guides/suggest';
import { parsePrinciples } from '../src/guides/principles';
import { pendingChanges } from '../src/model/changes';
import { sequentialIds } from '../src/model/ids';
import { replay } from '../src/model/apply';
import { harness } from './helpers/model';

const GUIDE = `# Grants

Intro text.

## Opening

- [G1] Open with the problem.
  - "An example." (a.pdf)

## Sentences

- [G2] Write formally.
`;

const s = (section: string, principle: string, extra: Partial<Suggestion> = {}): Suggestion => ({
  section,
  principle,
  examples: [],
  ...extra,
});

describe('suggested principles', () => {
  it('parses a suggestions file, tidying what Claude may add', () => {
    const f = parseSuggestions(
      JSON.stringify({
        document: 'g1',
        principles: [
          {
            section: '## Opening',
            principle: '- [G9] Name the gap.',
            examples: [' "x" (a) ', 3],
            reason: ' Seen in 4. ',
          },
          { principle: 'No section.' },
        ],
      }),
    );
    expect(f).toEqual({
      document: 'g1',
      principles: [
        {
          section: 'Opening',
          principle: 'Name the gap.',
          examples: ['"x" (a)'],
          reason: 'Seen in 4.',
        },
        { section: '', principle: 'No section.', examples: [] },
      ],
    });
    expect(() => parseSuggestions('nope')).toThrow(SuggestionError);
    expect(() => parseSuggestions('{"principles":[{"section":"x"}]}')).toThrow(SuggestionError);
  });

  it('adds each principle at the end of its section, as separate tracked insertions', () => {
    const h = harness(GUIDE);
    const { placed, skipped } = placeSuggestions(h.clean(), [
      s('opening', 'Name the gap in one sentence.', {
        examples: ['"Unclear." (b.pdf)'],
        reason: 'In 6 of 9.',
      }),
      s('Opening', 'State the aims early.'),
      s('Sentences', 'write formally.'), // already there, whatever the case
      s('Payoff', 'Say what the funder gets.'),
      s('Payoff', 'Give a timeline.'),
      s('', 'A loose one.'),
    ]);
    expect(skipped.map((x) => x.principle)).toEqual(['write formally.']);
    const id = sequentialIds('p');
    for (const item of suggestionOps(placed, { author: 'claude', ts: 't', id }))
      h.applyOps([typeof item === 'function' ? item(h.state)! : item]);
    expect(h.clean()).toBe(`# Grants

Intro text.

## Opening

- [G1] Open with the problem.
  - "An example." (a.pdf)
- Name the gap in one sentence.
  - "Unclear." (b.pdf)
- State the aims early.

## Sentences

- [G2] Write formally.

## Payoff

- Say what the funder gets.
- Give a timeline.

- A loose one.
`);
    expect(h.original()).toBe(GUIDE);
    const changes = pendingChanges(h.state);
    expect(changes).toHaveLength(5);
    expect(changes.every((c) => c.author === 'claude')).toBe(true);
    expect(changes.find((c) => c.after.includes('Name the gap'))!.record.reason).toBe('In 6 of 9.');
    // The new items are principles waiting for ids; the old ids are untouched.
    const parsed = parsePrinciples(h.clean());
    expect(parsed.principles.map((p) => p.id)).toEqual(['G1', 'G2']);
    expect(parsed.unnumbered).toHaveLength(5);
    expect(replay(h.doc.ops)).toEqual(h.state);
    // Rejecting one leaves the others.
    h.reject(changes.find((c) => c.after.includes('State the aims'))!.id);
    expect(h.clean()).toContain('Name the gap');
    expect(h.clean()).not.toContain('State the aims');
  });
});
