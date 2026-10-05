import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { harness } from './helpers/model';
import {
  exportCriticMarkup,
  exportMarkdown,
  parseCriticMarkup,
  documentFromCriticMarkup,
} from '../src/export/markdown';
import { exportJson, importJson } from '../src/export/json';
import { text as viewText, markedRanges, commentRanges } from '../src/model/views';
import { flatten, textOf } from '../src/model/spans';
import { sequentialIds } from '../src/model/ids';
import { createDocument, appendOp } from '../src/model/apply';
import schema from '../src/export/schema.json';
import Ajv from 'ajv';

describe('Markdown exports', () => {
  it('clean and original', () => {
    const h = harness('Keep this and remove that.');
    h.edit(14, 25, 'add this', { changeId: 'c1' });
    expect(exportMarkdown(h.state, 'clean')).toBe('Keep this and add this.');
    expect(exportMarkdown(h.state, 'original')).toBe('Keep this and remove that.');
  });

  it('CriticMarkup with substitutions, insertions, deletions, and comments', () => {
    const h = harness('Keep this and remove that. Second one.');
    const [s1] = h.ids();
    h.edit(14, 25, 'add this', { changeId: 'c1' });
    h.edit(h.rev().length, h.rev().length, ' Third.', { changeId: 'c2' });
    h.edit(0, 4, '', { changeId: 'c3' });
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'why?',
      anchor: { sentenceIds: [s1!], from: 5, to: 9 },
    }); // "this"
    h.op({
      type: 'comment_reply',
      threadId: 't1',
      commentId: 'k2',
      body: 'because',
      author: 'bob',
    });
    const md = exportCriticMarkup(h.state, { authors: [{ id: 'alice', name: 'Alice' }] });
    expect(md).toBe(
      '{--Keep--} {==this==}{>>Alice: why? // bob: because<<} and {~~remove that~>add this~~}. Second one.{++ Third.++}',
    );
    expect(exportCriticMarkup(h.state, { comments: false })).toBe(
      '{--Keep--} this and {~~remove that~>add this~~}. Second one.{++ Third.++}',
    );
  });

  it('places a comment after marked text without a highlight', () => {
    const h = harness('abc def');
    const [s1] = h.ids();
    h.edit(0, 3, 'XYZ', { changeId: 'c1' });
    h.op({
      type: 'comment_add',
      threadId: 't1',
      commentId: 'k1',
      body: 'n',
      anchor: { sentenceIds: [s1!], from: 0, to: 6 },
    });
    expect(exportCriticMarkup(h.state)).toBe('{~~abc~>XYZ~~}{>>alice: n<<} def');
  });
});

describe('CriticMarkup import', () => {
  it('parses every marker kind', () => {
    const p = parseCriticMarkup('a{++b++}c{--d--}e{~~f~>g~~}h{==i==}{>>note<<}j{>>standalone<<}');
    expect(p.spans.map((s) => [s.kind, s.text])).toEqual([
      ['text', 'a'],
      ['ins', 'b'],
      ['text', 'c'],
      ['del', 'd'],
      ['text', 'e'],
      ['ins', 'g'],
      ['del', 'f'],
      ['text', 'h'],
      ['text', 'i'],
      ['text', 'j'],
    ]);
    expect(p.comments).toEqual([
      { from: 8, to: 9, body: 'note' },
      { from: 0, to: 10, body: 'standalone' }, // the whole letter run is one word
    ]);
    expect(p.changeIds).toHaveLength(3);
  });

  it('builds a document with pending changes and threads', () => {
    const doc = documentFromCriticMarkup('One {~~two~>TWO~~} three. {==Four==}{>>hm<<} five.', {
      author: 'imp',
      ts: '2026-01-01T00:00:00Z',
    });
    expect(viewText(doc.state, 'revision')).toBe('One TWOtwo three. Four five.');
    expect(viewText(doc.state, 'clean')).toBe('One TWO three. Four five.');
    expect(viewText(doc.state, 'original')).toBe('One two three. Four five.');
    expect(markedRanges(doc.state).map((r) => r.kind)).toEqual(['ins', 'del']);
    expect(Object.values(doc.state.changes)[0]).toMatchObject({
      author: 'imp',
      status: 'pending',
      tracked: true,
    });
    expect(commentRanges(doc.state)).toMatchObject([{ from: 18, to: 22, orphaned: false }]);
    expect(doc.ops.map((o) => o.type)).toEqual(['import', 'splice', 'comment_add']);
  });

  it('round-trips: export then import gives the same spans and clean/original texts', () => {
    const insertArb = fc.oneof(
      fc.constant(''),
      fc.constantFrom(' ', '. ', '\n\n', 'Hello world. ', 'x'),
      fc.string({ maxLength: 8 }).filter((s) => !/[{}~<>=+-]/.test(s)),
    );
    fc.assert(
      fc.property(
        fc.constantFrom('One. Two.', 'Plain text here.\n\n- a\n- b\n', ''),
        fc.array(
          fc.record({ a: fc.nat(40), b: fc.nat(40), insert: insertArb, tracked: fc.boolean() }),
          { maxLength: 8 },
        ),
        (initial, edits) => {
          const h = harness(initial);
          edits.forEach((e, i) => {
            const len = h.rev().length;
            const a = Math.min(e.a, e.b, len);
            const b = Math.min(Math.max(e.a, e.b), len);
            h.edit(a, b, e.insert, { tracked: e.tracked, changeId: `c${i}` });
          });
          const md = exportCriticMarkup(h.state, { comments: false });
          const back = documentFromCriticMarkup(md, { author: 'imp' });
          expect(viewText(back.state, 'clean')).toBe(h.clean());
          expect(viewText(back.state, 'original')).toBe(h.original());
          expect(viewText(back.state, 'revision')).toBe(h.rev());
          expect(flatten(back.state.blocks).map((s) => [s.kind, s.text])).toEqual(
            flatten(h.state.blocks).map((s) => [s.kind, s.text]),
          );
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('JSON export and import', () => {
  it('validates against the schema and round-trips', () => {
    const idGen = sequentialIds('j');
    let doc = createDocument({
      text: '# T\n\nOne two. Three.',
      author: 'alice',
      ts: '2026-01-01T00:00:00Z',
      idGen,
    });
    doc = appendOp(
      doc,
      {
        id: 'e1',
        type: 'edit',
        author: 'alice',
        ts: '2026-01-01T00:00:01Z',
        changeId: 'c1',
        from: { sentenceId: doc.state.blocks[1]!.sentences[0]!.id, offset: 0 },
        to: { sentenceId: doc.state.blocks[1]!.sentences[0]!.id, offset: 3 },
        insert: 'Uno',
        tracked: true,
      },
      { idGen },
    ).doc;
    doc = appendOp(doc, {
      id: 'r1',
      type: 'set_reason',
      author: 'alice',
      ts: '2026-01-01T00:00:02Z',
      changeId: 'c1',
      reason: 'es',
      reasonTags: ['style'],
    }).doc;
    const json = exportJson(doc);
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(schema);
    const ok = validate(JSON.parse(json));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    const { doc: back, repaired } = importJson(json);
    expect(repaired).toBe(false);
    expect(back).toEqual(doc);
  });

  it('rejects malformed input and repairs a corrupt state', () => {
    expect(() => importJson('nope')).toThrow(/valid JSON/);
    expect(() => importJson('{"schemaVersion":2}')).toThrow(/schema version/);
    const doc = createDocument({
      text: 'abc',
      author: 'a',
      ts: '2026-01-01T00:00:00Z',
      idGen: sequentialIds('k'),
    });
    const tampered = { ...doc, state: { ...doc.state, blocks: [] } };
    const { doc: back, repaired } = importJson(JSON.stringify(tampered));
    expect(repaired).toBe(true);
    expect(textOf(flatten(back.state.blocks))).toBe('abc');
  });
});
