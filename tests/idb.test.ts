import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import {
  appendOps,
  createDoc,
  deleteDoc,
  listDocs,
  loadDoc,
  resetConnection,
  SNAPSHOT_EVERY_OPS,
} from '../src/persist/idb';
import { appendOp, revisionText } from '../src/model/apply';
import { absoluteToPos } from '../src/model/views';
import type { Document, Op } from '../src/model/types';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  resetConnection();
});

function edit(
  doc: Document,
  from: number,
  to: number,
  insert: string,
  n: number,
): { doc: Document; op: Op } {
  const op: Op = {
    id: `op${n}`,
    type: 'edit',
    author: 'me',
    ts: new Date(Date.now() + (n + 1) * 1000).toISOString(),
    changeId: `c${n}`,
    from: absoluteToPos(doc.state, from),
    to: absoluteToPos(doc.state, to),
    insert,
    tracked: false,
  };
  const r = appendOp(doc, op);
  return { doc: { ...r.doc, updatedAt: op.ts }, op: r.op };
}

describe('op-log store', () => {
  it('creates, appends, loads from snapshot + tail, lists, and deletes', async () => {
    const a = await createDoc({ text: 'Hello world.', author: 'me', tracking: false });
    const b = await createDoc({ text: 'Other', title: 'B', author: 'me', tracking: false });

    let doc = a;
    const ops: Op[] = [];
    for (let i = 0; i < 5; i++) {
      const r = edit(doc, 5, 5, '!', i);
      doc = r.doc;
      ops.push(r.op);
    }
    const res = await appendOps(doc, ops);
    expect(res.snapshotted).toBe(false); // under the thresholds, snapshot stays at creation

    const loaded = await loadDoc(a.id);
    expect(loaded?.recovered).toBe(false);
    expect(revisionText(loaded!.doc.state)).toBe('Hello!!!!! world.');
    expect(loaded!.doc.ops).toHaveLength(a.ops.length + 5);
    expect(loaded!.doc.state).toEqual(doc.state);

    const list = await listDocs();
    expect(list.map((d) => d.id)).toEqual([a.id, b.id]);
    expect(list[0]).toMatchObject({ title: 'Hello!!!!! world.', words: 2, pendingChanges: 0 });
    expect(list[1]!.title).toBe('B');

    await deleteDoc(b.id);
    expect(await loadDoc(b.id)).toBeUndefined();
    expect((await listDocs()).length).toBe(1);
  });

  it('snapshots when enough ops accumulate or when forced', async () => {
    let doc = await createDoc({ text: 'x', author: 'me', tracking: false });
    const ops: Op[] = [];
    for (let i = 0; i < SNAPSHOT_EVERY_OPS; i++) {
      const r = edit(doc, 1, 1, 'y', i);
      doc = r.doc;
      ops.push(r.op);
    }
    expect((await appendOps(doc, ops)).snapshotted).toBe(true);
    expect((await appendOps(doc, [])).snapshotted).toBe(false);
    expect((await appendOps(doc, [], { forceSnapshot: true })).snapshotted).toBe(true);
    const loaded = await loadDoc(doc.id);
    expect(revisionText(loaded!.doc.state)).toBe('x' + 'y'.repeat(SNAPSHOT_EVERY_OPS));
  });

  it('falls back to a full replay when the snapshot is corrupt', async () => {
    const doc = await createDoc({ text: 'Intact.', author: 'me', tracking: false });
    // Corrupt the snapshot hash behind the store's back.
    const raw = await openDB('shoulder-md', 2);
    const header = await raw.get('docs', doc.id);
    header.snapshot.hash = 'deadbeef';
    await raw.put('docs', header);
    raw.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loaded = await loadDoc(doc.id);
    expect(loaded?.recovered).toBe(true);
    expect(revisionText(loaded!.doc.state)).toBe('Intact.');
    expect(loaded!.doc.state).toEqual(doc.state);
    warn.mockRestore();
  });

  it('migrates phase 0 raw-text documents into the op log', async () => {
    const v1 = await openDB('shoulder-md', 1, {
      upgrade(db) {
        db.createObjectStore('docs', { keyPath: 'id' }).createIndex('by-updated', 'updatedAt');
      },
    });
    await v1.put('docs', {
      id: 'old1',
      title: 'Old doc',
      text: '# Old doc\n\nFrom phase zero.',
      createdAt: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-10-05T11:00:00.000Z',
    });
    v1.close();
    resetConnection();

    const loaded = await loadDoc('old1');
    expect(loaded?.recovered).toBe(false);
    expect(revisionText(loaded!.doc.state)).toBe('# Old doc\n\nFrom phase zero.');
    expect(loaded!.doc.state.trackingOn).toBe(false);
    expect(loaded!.doc.state.meta.title).toBe('Old doc');
    expect(loaded!.doc.ops.map((o) => o.type)).toEqual(['import', 'set_meta', 'set_tracking']);
    expect(loaded!.doc.createdAt).toBe('2026-10-05T10:00:00.000Z');
    expect((await listDocs())[0]).toMatchObject({ id: 'old1', title: 'Old doc', words: 5 });
  });
});
