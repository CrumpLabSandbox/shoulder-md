import type { DirHandleLike, FileHandleLike, FileLike } from '../../src/folder/fs';

type Entry = { content: string | Uint8Array<ArrayBuffer>; lastModified: number };
const encode = (c: Entry['content']) => (typeof c === 'string' ? new TextEncoder().encode(c) : c);

/**
 * An in-memory directory tree with the File System Access API shape the folder sync uses.
 * Files are keyed by their path from the top ('Documents/a/a.md').
 */
export function memoryDir(name = 'repo') {
  const files = new Map<string, Entry>();
  const dirs = new Set<string>();
  let clock = 1_000;
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });

  const fileLike = (e: Entry): FileLike => ({
    lastModified: e.lastModified,
    size: encode(e.content).length,
    text: async () =>
      typeof e.content === 'string' ? e.content : new TextDecoder().decode(e.content),
    arrayBuffer: async () => encode(e.content).slice().buffer,
  });

  const handle = (path: string, fname: string): FileHandleLike => ({
    kind: 'file',
    name: fname,
    async getFile() {
      const e = files.get(path);
      if (!e) throw notFound();
      return fileLike(e);
    },
    async createWritable() {
      let buf: Entry['content'] = '';
      return {
        write: async (d) =>
          void (buf = typeof d === 'string' && typeof buf === 'string' ? buf + d : d),
        close: async () => void files.set(path, { content: buf, lastModified: ++clock }),
      };
    },
  });

  const directory = (prefix: string, dname: string): DirHandleLike => {
    const at = (child: string) => prefix + child;
    return {
      kind: 'directory',
      name: dname,
      async getFileHandle(fname, opts) {
        if (!files.has(at(fname))) {
          if (!opts?.create) throw notFound();
          files.set(at(fname), { content: '', lastModified: ++clock });
        }
        return handle(at(fname), fname);
      },
      async getDirectoryHandle(child, opts) {
        if (!dirs.has(at(child))) {
          if (!opts?.create) throw notFound();
          dirs.add(at(child));
        }
        return directory(at(child) + '/', child);
      },
      async *values() {
        const direct = (k: string) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/');
        for (const k of [...dirs].filter(direct).sort())
          yield directory(k + '/', k.slice(prefix.length));
        for (const k of [...files.keys()].filter(direct).sort())
          yield handle(k, k.slice(prefix.length));
      },
      async removeEntry(child) {
        if (files.delete(at(child))) return;
        if (!dirs.has(at(child))) throw notFound();
        const inside = at(child) + '/';
        if ([...files.keys(), ...dirs].some((k) => k.startsWith(inside)))
          throw Object.assign(new Error('not empty'), { name: 'InvalidModificationError' });
        dirs.delete(at(child));
      },
    };
  };

  return {
    dir: directory('', name),
    files,
    read: (path: string) => {
      const c = files.get(path)?.content;
      return c === undefined || typeof c === 'string' ? c : new TextDecoder().decode(c);
    },
    /** An edit made by another program. Parent folders are created as needed. */
    writeOutside: (path: string, content: string) => {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      files.set(path, { content, lastModified: ++clock });
    },
    names: () => [...files.keys()].sort(),
    folders: () => [...dirs].sort(),
  };
}
