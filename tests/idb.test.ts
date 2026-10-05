import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createDoc,
  deleteDoc,
  getDoc,
  listDocs,
  putDoc,
  resetConnection,
} from '../src/persist/idb';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  resetConnection();
});

describe('idb document store', () => {
  it('creates, reads, updates, lists, and deletes', async () => {
    const a = await createDoc({ title: 'A', text: 'one two' });
    const b = await createDoc({ title: 'B', text: 'three' });
    expect((await getDoc(a.id))?.text).toBe('one two');

    await putDoc({
      ...a,
      text: 'one two three four',
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const list = await listDocs();
    expect(list.map((d) => d.id)).toEqual([a.id, b.id]); // newest first
    expect(list[0]?.words).toBe(4);
    expect('text' in list[0]!).toBe(false);

    await deleteDoc(b.id);
    expect(await getDoc(b.id)).toBeUndefined();
    expect((await listDocs()).length).toBe(1);
  });
});
