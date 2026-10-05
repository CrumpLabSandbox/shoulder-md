import { describe, it, expect } from 'vitest';
import { segmentBlocks, segmentSentences } from '../src/model/segment';

function blockTexts(text: string) {
  return segmentBlocks(text).map((b) => text.slice(b.from, b.to));
}

function sentences(text: string, kind: Parameters<typeof segmentSentences>[1] = 'paragraph') {
  const ends = segmentSentences(text, kind);
  let start = 0;
  return ends.map((e) => {
    const s = text.slice(start, e);
    start = e;
    return s;
  });
}

describe('segmentBlocks', () => {
  it('is lossless and contiguous', () => {
    const text =
      '# Title\n\nPara one. Two.\nwrapped.\n\n- item\n- [x] done\n  1. nested\n\n> quote\n> more\n\n```js\nx\n```\n\n| a |\n|---|\n| 1 |\n\n---\n\n<div>h</div>\n\nSetext\n======\n';
    const blocks = segmentBlocks(text);
    expect(blocks[0]!.from).toBe(0);
    expect(blocks[blocks.length - 1]!.to).toBe(text.length);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.from).toBe(blocks[i - 1]!.to);
    expect(blockTexts(text).join('')).toBe(text);
  });

  it('classifies kinds and attrs', () => {
    const text =
      '# T\n\np\n\n- a\n  1. b\n\n> q\n\n```py\nx\n```\n\n---\n\n| a |\n|---|\n\n<div>h</div>\n';
    const kinds = segmentBlocks(text).map((b) => [b.kind, b.attrs]);
    expect(kinds).toEqual([
      ['heading', { level: 1 }],
      ['paragraph', {}],
      ['list_item', { depth: 1, ordered: false }],
      ['list_item', { depth: 2, ordered: true }],
      ['paragraph', { quote: 1 }],
      ['code', { lang: 'py' }],
      ['thematic_break', {}],
      ['table', {}],
      ['html', {}],
    ]);
  });

  it('glues blank lines to the previous block and markers to the next', () => {
    expect(blockTexts('a\n\n\n- b\n- c\n')).toEqual(['a\n\n\n', '- b\n', '- c\n']);
    expect(blockTexts('> q\n\np')).toEqual(['> q\n\n', 'p']);
  });

  it('handles empty, whitespace, and marker-only text', () => {
    expect(segmentBlocks('')).toEqual([{ from: 0, to: 0, kind: 'paragraph', attrs: {} }]);
    expect(blockTexts('\n\n')).toEqual(['\n\n']);
    expect(blockTexts('- ')).toEqual(['- ']);
  });

  it('marks task items', () => {
    const b = segmentBlocks('- [ ] todo\n- [x] done');
    expect(b.map((x) => x.attrs.task)).toEqual(['unchecked', 'checked']);
  });
});

describe('segmentSentences', () => {
  it('splits on terminators and keeps trailing space with the sentence', () => {
    expect(sentences('One. Two! Three?')).toEqual(['One. ', 'Two! ', 'Three?']);
  });

  it('does not split hard-wrapped lines', () => {
    expect(sentences('One two\nthree. Four\nfive.')).toEqual(['One two\nthree. ', 'Four\nfive.']);
  });

  it('keeps abbreviations together', () => {
    expect(sentences('See Fig. 2 for details. Dr. Smith agreed, e.g. twice. Done.')).toEqual([
      'See Fig. 2 for details. ',
      'Dr. Smith agreed, e.g. twice. ',
      'Done.',
    ]);
  });

  it('does not split inside inline code or links', () => {
    expect(sentences('Use `a.b. c` here. Then [x](http://e.com/a. b) too. End.')).toEqual([
      'Use `a.b. c` here. ',
      'Then [x](http://e.com/a. b) too. ',
      'End.',
    ]);
  });

  it('keeps block markers with the first sentence', () => {
    expect(sentences('1. First. Second.', 'list_item')).toEqual(['1. First. ', 'Second.']);
    expect(sentences('# A title. With two.', 'heading')).toEqual(['# A title. ', 'With two.']);
    expect(sentences('- [x] Done. Next.', 'list_item')).toEqual(['- [x] Done. ', 'Next.']);
  });

  it('treats non-prose blocks as one sentence', () => {
    expect(sentences('```\na. b. c.\n```', 'code')).toEqual(['```\na. b. c.\n```']);
  });

  it('includes trailing newlines in the last sentence', () => {
    expect(sentences('A. B.\n\n')).toEqual(['A. ', 'B.\n\n']);
  });

  it('is contiguous for arbitrary text', () => {
    for (const t of [
      '',
      'x',
      '...',
      '. . .',
      'a.b.c',
      'Hi.  There.',
      'Q? A! B.',
      '"Quoted." Next.',
    ]) {
      const ends = segmentSentences(t, 'paragraph');
      expect(ends[ends.length - 1]).toBe(t.length);
      for (let i = 1; i < ends.length; i++) expect(ends[i]!).toBeGreaterThan(ends[i - 1]!);
    }
  });
});
