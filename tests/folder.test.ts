import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FLAT, FolderSync, memoryFolderStore } from '../src/folder/sync';
import { cleanToRevision, coarsen, editsToMatch, textHunks } from '../src/folder/merge';
import { memoryDir } from './helpers/memfs';
import { harness } from './helpers/model';
import { createDocument, appendOp, applyOp } from '../src/model/apply';
import { exportJson } from '../src/export/json';
import { sequentialIds } from '../src/model/ids';
import { text as viewText, markedRanges } from '../src/model/views';
import type { Document, Op } from '../src/model/types';
import { pendingChanges } from '../src/model/changes';

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
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
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
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
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
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
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
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
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
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
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
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
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

  it('writes again when a typing run grew its op without adding one', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
    const d = doc('Hello world.', 'd1', 'Hello world');
    const short = withEdit(d, 'Mo');
    await sync.write(short);
    const grown = { ...withEdit(d, 'More. '), updatedAt: '2026-10-06T00:00:02Z' };
    expect(grown.ops.map((o) => o.id)).toEqual(short.ops.map((o) => o.id));
    expect((await sync.write(grown)).written).toBe(true);
    expect(fs.read('hello-world.md')).toBe('More. Hello world.');
    expect((await sync.write(grown)).written).toBe(false);
    // An outside copy holding the shorter op is a different history, not an extension.
    fs.writeOutside('hello-world.shoulder.json', exportJson(withEdit(short, 'Z')));
    expect(await sync.check(grown)).toMatchObject({ kind: 'json', extendsLocal: false });
  });

  it('renames files that were named while the document was untitled', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
    const meta = (d: Document, title: string): Document =>
      appendOp(d, {
        id: `m${d.ops.length}`,
        type: 'set_meta',
        author: 'me',
        ts: 't',
        patch: { title },
      }).doc;
    const empty = doc('');
    await sync.write(empty);
    expect(fs.names()).toEqual(['untitled.md', 'untitled.shoulder.json']);
    fs.writeOutside('untitled.proposals.json', '{"proposals":[]}');

    // Still on its first line: the derived title is not settled, so the name stays.
    const typing = withEdit(empty, 'Project pl');
    expect((await sync.write(typing)).renamed).toBeUndefined();
    expect(fs.names()).toContain('untitled.md');

    // An explicit title settles it; the old files go and waiting proposals move along.
    const titled = meta(typing, 'Project plan');
    const r = await sync.write(titled);
    expect(r.renamed).toEqual({ from: 'untitled.md', to: 'project-plan.md' });
    expect(fs.names()).toEqual([
      'project-plan.md',
      'project-plan.proposals.json',
      'project-plan.shoulder.json',
    ]);
    expect((await sync.proposals('d1'))?.file).toBe('project-plan.proposals.json');
    expect(await sync.check(titled)).toEqual({ kind: 'none' });
    expect((await sync.write(titled)).written).toBe(false);
    // A later title change does not rename again.
    await sync.write(meta(titled, 'Something else'));
    expect(fs.names()).toContain('project-plan.md');
  });

  it('renames an untitled file once the text has moved past its first line, even if unchanged since', async () => {
    const fs = memoryDir();
    const store = memoryFolderStore();
    const sync = new FolderSync(fs.dir, store, fixed, FLAT);
    const d = doc('# Research notes\n\nBody text.', 'd2');
    // As if it had been written under a placeholder name earlier.
    await store.put({ docId: 'd2', base: 'untitled-2', opCount: -1 });
    expect((await sync.write(d)).renamed?.to).toBe('research-notes.md');
    // An outside edit under the old name is settled first, not renamed away.
    const other = doc('', 'd3');
    await sync.write(other);
    fs.writeOutside('untitled.md', 'Edited outside.\n\nMore.');
    const typed = withEdit(other, 'Title line\n\nText');
    const r = await sync.write(typed);
    expect(r.renamed).toBeUndefined();
    expect(fs.names()).toContain('untitled.md');
  });

  it('gives each document its own folder and keeps guides together', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed);
    await sync.prepare();
    expect(fs.folders()).toEqual(['Documents', 'Style', 'Style/Guides', 'Style/Samples']);
    expect(fs.names()).toEqual(['Style/Samples/README.md']);

    const d = doc('# My Paper\n\nHello.');
    const guide = appendOp(doc('# Grants\n\n- [G1] Be clear.', 'g1'), {
      id: 'm',
      type: 'set_meta',
      author: 'me',
      ts: 't',
      patch: { guide: { role: 'genre', prefix: 'G' } },
    }).doc;
    await sync.write(d);
    await sync.write(guide);
    expect(fs.names()).toEqual([
      'Documents/my-paper/my-paper.md',
      'Documents/my-paper/my-paper.shoulder.json',
      'Style/Guides/grants.md',
      'Style/Guides/grants.shoulder.json',
      'Style/Samples/README.md',
    ]);
    expect(await sync.fileName('d1')).toBe('Documents/my-paper/my-paper.md');
    expect((await sync.write(d)).written).toBe(false);

    // Proposals, conflict copies and outside edits all live in the document's own folder.
    fs.writeOutside('Documents/my-paper/my-paper.proposals.json', '{"proposals":[]}');
    expect((await sync.proposals('d1'))?.file).toBe('my-paper.proposals.json');
    fs.writeOutside('Documents/my-paper/my-paper.md', '# My Paper\n\nHello, edited.');
    expect(await sync.check(d)).toMatchObject({ kind: 'md' });
    const r = await sync.write(withEdit(d, 'Mine. '));
    expect(r.backups).toEqual(['my-paper.conflict-20261006-093000.md']);
    expect(fs.names()).toContain('Documents/my-paper/my-paper.conflict-20261006-093000.md');

    // A second document with the same title gets its own folder.
    await sync.write(doc('# My Paper\n\nAnother.', 'd2'));
    expect(fs.names()).toContain('Documents/my-paper-2/my-paper-2.md');

    // Removing a document removes its folder with it.
    await sync.remove('d2');
    expect(fs.folders()).not.toContain('Documents/my-paper-2');
  });

  it('finds documents wherever they are, and moves older flat files into place', async () => {
    const fs = memoryDir();
    // A folder written by the earlier flat layout, with waiting proposals and a conflict copy.
    const old = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
    const paper = doc('# My Paper\n\nHello.');
    const guide = appendOp(doc('# Grants\n\n- [G1] Be clear.', 'g1'), {
      id: 'm',
      type: 'set_meta',
      author: 'me',
      ts: 't',
      patch: { guide: { role: 'genre', prefix: 'G' } },
    }).doc;
    await old.write(paper);
    await old.write(guide);
    fs.writeOutside('my-paper.proposals.json', '{"proposals":[]}');
    fs.writeOutside('my-paper.conflict-20260101-000000.md', 'kept');

    // A fresh app connects: it has neither document.
    const store = memoryFolderStore();
    const sync = new FolderSync(fs.dir, store, fixed);
    await sync.prepare();
    const found = await sync.scan([], []);
    expect(found.map((d) => d.id).sort()).toEqual(['d1', 'g1']);
    const moved = await sync.write(paper);
    expect(moved.moved).toBe(true);
    await sync.write(guide);
    expect(fs.names()).toEqual([
      'Documents/my-paper/my-paper.conflict-20260101-000000.md',
      'Documents/my-paper/my-paper.md',
      'Documents/my-paper/my-paper.proposals.json',
      'Documents/my-paper/my-paper.shoulder.json',
      'Style/Guides/grants.md',
      'Style/Guides/grants.shoulder.json',
      'Style/Samples/README.md',
    ]);
    expect(await sync.check(paper)).toEqual({ kind: 'none' });
    expect((await sync.write(paper)).written).toBe(false);
    // Scanning again finds them in their new places and nothing new.
    expect(await new FolderSync(fs.dir, memoryFolderStore(), fixed).scan(['d1', 'g1'], [])).toEqual(
      [],
    );
  });

  it('moves flat files it already tracked, and renames an untitled folder with its files', async () => {
    const fs = memoryDir();
    const store = memoryFolderStore();
    const d = doc('# My Paper\n\nHello.');
    await new FolderSync(fs.dir, store, fixed, FLAT).write(d);
    // The same store, now with the structured layout: unchanged documents still move.
    const sync = new FolderSync(fs.dir, store, fixed);
    expect(await sync.write(d)).toMatchObject({ written: true, moved: true });
    expect(fs.names()).toEqual([
      'Documents/my-paper/my-paper.md',
      'Documents/my-paper/my-paper.shoulder.json',
    ]);

    const empty = doc('', 'd2');
    await sync.write(empty);
    expect(fs.names()).toContain('Documents/untitled/untitled.md');
    const titled = appendOp(empty, {
      id: 'm1',
      type: 'set_meta',
      author: 'me',
      ts: 't',
      patch: { title: 'Project plan' },
    }).doc;
    expect((await sync.write(titled)).renamed?.to).toBe('project-plan.md');
    expect(fs.names()).toContain('Documents/project-plan/project-plan.md');
    expect(fs.folders()).not.toContain('Documents/untitled');
  });

  it('rewrites missing files', async () => {
    const fs = memoryDir();
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
    const d = doc('Hello world.');
    await sync.write(d);
    fs.files.delete('hello-world.md');
    expect(await sync.check(d)).toEqual({ kind: 'missing' });
    expect((await sync.write(d)).written).toBe(true);
    expect(fs.read('hello-world.md')).toBe('Hello world.');
  });

  it('scans for documents the browser does not have, skipping known and deleted ones', async () => {
    const other = memoryDir();
    const writer = new FolderSync(other.dir, memoryFolderStore(), fixed, FLAT);
    await writer.write(doc('# Shared', 'shared'));
    await writer.write(doc('# Known', 'known'));
    await writer.write(doc('# Gone', 'gone'));
    other.writeOutside(
      'notes.conflict-20260101-000000.shoulder.json',
      exportJson(doc('x', 'conf')),
    );
    // A second browser connects to the same folder.
    const store = memoryFolderStore();
    const sync = new FolderSync(other.dir, store, fixed, FLAT);
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
    const sync = new FolderSync(fs.dir, memoryFolderStore(), fixed, FLAT);
    await sync.write(doc('# Notes', 'n'));
    // The existing notes.md is not ours, so we pick another name instead of overwriting it.
    expect(fs.read('notes.md')).toBe('Somebody else’s notes.');
    expect(fs.read('notes-2.md')).toBe('# Notes');
  });
});

describe('text → tracked edits', () => {
  it('joins nearby hunks into one change, but never across lines', () => {
    const a =
      'The project is going to be done in the summer. It is new.\n\nSecond paragraph stays.';
    const b =
      'The project will run over the summer, and it breaks new ground.\n\nSecond paragraph stays. Added.';
    const fine = textHunks(a, b);
    expect(fine.length).toBeGreaterThan(5);
    const joined = coarsen(a, fine, 24);
    // The sentence rewrite is one change; the sentence added to another paragraph is its own.
    expect(joined).toHaveLength(2);
    // A change that adds a paragraph is not folded into the sentence before it.
    const appended = a + '\n\nNew paragraph.';
    const withPara = coarsen(a, textHunks(a, b.replace(' Added.', '') + '\n\nNew paragraph.'), 24);
    expect(withPara[withPara.length - 1]!.insert).toContain('New paragraph.');
    expect(withPara[withPara.length - 1]!.insert).not.toContain('ground');
    expect(appended.length).toBeGreaterThan(a.length);
    expect(a.slice(joined[0]!.from, joined[0]!.to)).toBe(
      'is going to be done in the summer. It is new',
    );
    expect(joined[0]!.insert).toBe('will run over the summer, and it breaks new ground');
    // Applying the joined hunks still gives the target.
    let out = a;
    for (const h of [...joined].reverse()) out = out.slice(0, h.from) + h.insert + out.slice(h.to);
    expect(out).toBe(b);
    // With no joining distance nothing changes.
    expect(coarsen(a, fine, 0)).toEqual(fine);

    const h = harness(a);
    for (const build of editsToMatch(h.state, b, {
      author: 'claude',
      ts: 't',
      id: h.idGen,
      joinWithin: 24,
    }))
      h.applyOps([build(h.state)!]);
    expect(h.clean()).toBe(b);
    expect(h.original()).toBe(a);
    expect(pendingChanges(h.state)).toHaveLength(2);
  });

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
    const sync = new FolderSync(fs.dir, store, fixed, FLAT);
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
