import type { DirHandleLike, FileHandleLike, FileLike } from '../../src/folder/fs';

type Entry = { content: string; lastModified: number };

/** An in-memory directory with the File System Access API shape the folder sync uses. */
export function memoryDir(name = 'repo') {
  const files = new Map<string, Entry>();
  let clock = 1_000;
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });

  const fileLike = (e: Entry): FileLike => ({
    lastModified: e.lastModified,
    size: new TextEncoder().encode(e.content).length,
    text: async () => e.content,
  });

  const handle = (fname: string): FileHandleLike => ({
    kind: 'file',
    name: fname,
    async getFile() {
      const e = files.get(fname);
      if (!e) throw notFound();
      return fileLike(e);
    },
    async createWritable() {
      let buf = '';
      return {
        write: async (d: string) => void (buf += d),
        close: async () => void files.set(fname, { content: buf, lastModified: ++clock }),
      };
    },
  });

  const dir: DirHandleLike = {
    kind: 'directory',
    name,
    async getFileHandle(fname, opts) {
      if (!files.has(fname)) {
        if (!opts?.create) throw notFound();
        files.set(fname, { content: '', lastModified: ++clock });
      }
      return handle(fname);
    },
    async *values() {
      for (const k of [...files.keys()].sort()) yield handle(k);
    },
    async removeEntry(fname) {
      if (!files.delete(fname)) throw notFound();
    },
  };

  return {
    dir,
    files,
    read: (fname: string) => files.get(fname)?.content,
    /** An edit made by another program. */
    writeOutside: (fname: string, content: string) =>
      files.set(fname, { content, lastModified: ++clock }),
    names: () => [...files.keys()].sort(),
  };
}
