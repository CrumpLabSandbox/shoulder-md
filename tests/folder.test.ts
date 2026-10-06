import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FolderSync, memoryFolderStore } from '../src/folder/sync';
import { cleanToRevision, editsToMatch, textHunks } from '../src/folder/merge';
import { memoryDir } from './helpers/memfs';
import { harness } from './helpers/model';
import { createDocument, appendOp, applyOp } from '../src/model/apply';
import { exportJson } from '../src/export/json';
import { sequentialIds } from '../src/model/ids';
import { text as viewText, markedRanges } from '../src/model/views';
import type { Document, Op } from '../src/model/types';

const fixed = () => new Date(2026, 9, 6, 9, 30, 0);

function doc(text: string, id = 'd1', title?: string): Document {
  return createDocument({
    id,
    text,
    author: 'me',
    ts: '2026-10-06T00:00:00Z',
    title,
    idGen: sequentialIds(`${id}-`),
  });
}

function withEdit(d: Document, insert: string): Document {
  const pos = { sentenceId: d.state.blocks[0]!.sentences[0]!.id, offset: 0 };
  const op: Op = {
    id: `e${d.ops.length}`,
    type: 'edit',
    author: 'me',
    ts: '2026-10-06T00:00:01Z',
    changeId: `c${d.ops.length}`,
    from: pos,
    to: pos,
    insert,
    tracked: false,
  };
  return appendOp(d, op).doc;
}

describe('FolderSync', () => {
  it('writes .md and .shoulder.json named after the title, and skips unchanged documents', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    const d = doc('# My Paper\n\nHello.');
    expect(await sync.write(d)).toEqual({ written: true, backups: [] });
    expect(fs.names()).toEqual(['my-paper.md', 'my-paper.shoulder.json']);
    expect(fs.read('my-paper.md')).toBe('# My Paper\n\nHello.');
    expect(JSON.parse(fs.read('my-paper.shoulder.json')!).id).toBe('d1');
    expect((await sync.write(d)).written).toBe(false);
    // A title change does not rename the files.
    const renamed = appendOp(d, {
      id: 'm',
      type: 'set_meta',
      author: 'me',
      ts: 't',
      patch: { title: 'Other' },
    }).doc;
    expect((await sync.write(renamed)).written).toBe(true);
    expect(fs.names()).toEqual(['my-paper.md', 'my-paper.shoulder.json']);
  });

  it('gives documents with the same title distinct names', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    await sync.write(doc('# Notes', 'a'));
    await sync.write(doc('# Notes', 'b'));
    expect(fs.names()).toEqual([
      'notes-2.md',
      'notes-2.shoulder.json',
      'notes.md',
      'notes.shoulder.json',
    ]);
  });

  it('reports a disk edit of the .md when the browser did not change, without writing', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    const d = doc('Hello world.');
    await sync.write(d);
    fs.writeOutside('hello-world.md', 'Hello there world.');
    const r = await sync.write(d);
    expect(r.written).toBe(false);
    expect(r.external).toEqual({ kind: 'md', file: 'hello-world.md', text: 'Hello there world.' });
    expect(await sync.check(d)).toMatchObject({ kind: 'md' });
    // Touching the file without changing its text is not a change.
    fs.writeOutside('hello-world.md', 'Hello world.');
    expect(await sync.check(d)).toEqual({ kind: 'none' });
  });

  it('when both changed, the browser wins and the disk version is kept as a conflict file', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    let d = doc('Hello world.');
    await sync.write(d);
    fs.writeOutside('hello-world.md', 'Edited elsewhere.');
    d = withEdit(d, 'Browser: ');
    const r = await sync.write(d);
    expect(r).toEqual({ written: true, backups: ['hello-world.conflict-20261006-093000.md'] });
    expect(fs.read('hello-world.md')).toBe('Browser: Hello world.');
    expect(fs.read('hello-world.conflict-20261006-093000.md')).toBe('Edited elsewhere.');
  });

  it('force overwrites a disk edit after backing it up', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    const d = doc('Hello world.');
    await sync.write(d);
    fs.writeOutside('hello-world.md', 'Other.');
    const r = await sync.write(d, { force: true });
    expect(r.backups).toEqual(['hello-world.conflict-20261006-093000.md']);
    expect(fs.read('hello-world.md')).toBe('Hello world.');
    expect(await sync.check(d)).toEqual({ kind: 'none' });
  });

  it('detects an op log on disk that extends ours, and one that diverges', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    const d = doc('Hello world.');
    await sync.write(d);
    const longer = withEdit(d, 'More. ');
    fs.writeOutside('hello-world.shoulder.json', exportJson(longer));
    expect(await sync.check(d)).toMatchObject({ kind: 'json', extendsLocal: true, newOps: 1 });
    const other = withEdit(doc('Hello world.'), 'Different. ');
    const diverged = { ...other, ops: [other.ops[0]!, { ...other.ops[1]!, id: 'zzz' }] };
    fs.writeOutside('hello-world.shoulder.json', exportJson(diverged as Document));
    expect(await sync.check(d)).toMatchObject({ kind: 'json', extendsLocal: true });
    fs.writeOutside('hello-world.shoulder.json', '{ not json');
    expect(await sync.check(d)).toMatchObject({ kind: 'invalid' });
  });

  it('rewrites missing files', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    const d = doc('Hello world.');
    await sync.write(d);
    fs.files.delete('hello-world.md');
    expect(await sync.check(d)).toEqual({ kind: 'missing' });
    expect((await sync.write(d)).written).toBe(true);
    expect(fs.read('hello-world.md')).toBe('Hello world.');
  });

  it('scans for documents the browser does not have, skipping known and deleted ones', async () => {
    const other = memoryDir();
    const writer = new FolderSync(other.dir, memoryFolderStore(), fixed);
    await writer.write(doc('# Shared', 'shared'));
    await writer.write(doc('# Known', 'known'));
    await writer.write(doc('# Gone', 'gone'));
    other.writeOutside(
      'notes.conflict-20260101-000000.shoulder.json',
      exportJson(doc('x', 'conf')),
    );
    // A second browser connects to the same folder.
    const store = memoryFolderStore();
    const sync = new FolderSync(other.dir, store, fixed);
    const found = await sync.scan(new Set(['known']), new Set(['gone']));
    expect(found.map((d) => d.id)).toEqual(['shared']);
    expect((await store.get('shared'))?.base).toBe('shared');
    expect(await sync.check(found[0]!)).toEqual({ kind: 'none' });
    // The known document is linked to its existing name rather than getting "-2".
    expect((await store.get('known'))?.base).toBe('known');
    expect((await sync.write(doc('# Known', 'known'))).backups).toEqual([]);
    expect(other.names().filter((n) => n.startsWith('known'))).toEqual([
      'known.md',
      'known.shoulder.json',
    ]);
  });

  it('first write keeps a differing file already at that name', async () => {
    const fs = memoryDir();
    fs.writeOutside('notes.md', 'Somebody else’s notes.');
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    await sync.write(doc('# Notes', 'n'));
    // The existing notes.md is not ours, so we pick another name instead of overwriting it.
    expect(fs.read('notes.md')).toBe('Somebody else’s notes.');
    expect(fs.read('notes-2.md')).toBe('# Notes');
  });
});

describe('text → tracked edits', () => {
  it('finds word-level hunks', () => {
    expect(textHunks('The results was significant.', 'The results were significant.')).toEqual([
      { from: 12, to: 15, insert: 'were' },
    ]);
    expect(textHunks('a b c', 'a c')).toEqual([{ from: 2, to: 4, insert: '' }]);
    expect(textHunks('same', 'same')).toEqual([]);
    expect(textHunks('', 'new')).toEqual([{ from: 0, to: 0, insert: 'new' }]);
  });

  it('maps clean offsets past pending deletions', () => {
    const h = harness('abc def');
    h.edit(0, 3, '', { changeId: 'c1' }); // "abc" pending deletion
    expect(cleanToRevision(h.state, 0)).toBe(0);
    expect(cleanToRevision(h.state, 1)).toBe(4);
  });

  it('applies hunks as tracked changes by the given author, reaching the target clean text', () => {
    const h = harness('# Title\n\nThe results was significant. We stopped.');
    h.edit(h.rev().indexOf('stopped'), h.rev().indexOf('stopped') + 7, 'halted', {
      changeId: 'mine',
    });
    const target = '# Title\n\nThe results were clearly significant. We halted!';
    let n = 0;
    let state = h.state;
    for (const build of editsToMatch(state, target, {
      author: 'disk',
      ts: 't',
      id: () => `x${n++}`,
    })) {
      state = applyOp(state, build(state)!).state;
    }
    expect(viewText(state, 'clean')).toBe(target);
    expect(viewText(state, 'original')).toBe('# Title\n\nThe results was significant. We stopped.');
    const authors = new Set(markedRanges(state).map((r) => r.author));
    expect(authors).toEqual(new Set(['alice', 'disk']));
  });

  it('property: any target clean text is reached, and the original is untouched', () => {
    const textArb = fc.oneof(
      fc.constantFrom('', 'One. Two.', '# T\n\nA b c. D e.\n\n- x\n- y\n'),
      fc.string({ maxLength: 30 }),
    );
    fc.assert(
      fc.property(
        textArb,
        fc.array(fc.record({ a: fc.nat(30), b: fc.nat(30), insert: fc.string({ maxLength: 6 }) }), {
          maxLength: 4,
        }),
        textArb,
        (initial, edits, target) => {
          const h = harness(initial);
          edits.forEach((e, i) => {
            const len = h.rev().length;
            const a = Math.min(e.a, e.b, len);
            const b = Math.min(Math.max(e.a, e.b), len);
            h.edit(a, b, e.insert, { changeId: `c${i}` });
          });
          const original = h.original();
          let state = h.state;
          let n = 0;
          for (const build of editsToMatch(state, target, {
            author: 'disk',
            ts: 't',
            id: () => `x${n++}`,
          })) {
            state = applyOp(state, build(state)!).state;
          }
          expect(viewText(state, 'clean')).toBe(target);
          // Deleting another author's pending insertion keeps the insertion, so the original holds.
          expect(viewText(state, 'original')).toBe(original);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('moving between folders', () => {
  it("removes a document's files and forgets them", async () => {
    const fs = memoryDir();
    const store = memoryFolderStore();
    const sync = new FolderSync(fs.dir, store, fixed);
    const d = doc('# Secret\n\nText.');
    await sync.write(d);
    expect(await sync.has(d.id)).toBe(true);
    expect(await sync.remove(d.id)).toEqual(['secret.md', 'secret.shoulder.json']);
    expect(fs.names()).toEqual([]);
    expect(await sync.has(d.id)).toBe(false);
    expect(await sync.remove(d.id)).toEqual([]);
    // Written again later, it gets its name back.
    await sync.write(d);
    expect(fs.names()).toEqual(['secret.md', 'secret.shoulder.json']);
  });
});
