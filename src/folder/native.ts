/**
 * A folder on disk reached through the Mac app's bridge, in the same shape as a File System
 * Access directory handle, so the sync engine does not care which one it has. Unlike a browser
 * handle it is just a path: it can be stored as plain data and needs no permission prompt.
 */
import type { NativeFs } from '../app/bridge';
import type { DirHandleLike, FileHandleLike } from './fs';

export type NativeDir = DirHandleLike & { readonly nativePath: string };

const notFound = (name: string) =>
  Object.assign(new Error(`${name} was not found`), { name: 'NotFoundError' });

export function nativeDir(path: string, name: string, fs: NativeFs): NativeDir {
  const file = (fname: string): FileHandleLike => ({
    kind: 'file',
    name: fname,
    async getFile() {
      const stat = await fs.stat(path, fname);
      if (!stat) throw notFound(fname);
      return {
        ...stat,
        text: () => fs.read(path, fname),
        arrayBuffer: async () => (await fs.readBytes(path, fname)).slice().buffer,
      };
    },
    async createWritable() {
      let text = '';
      let bytes: Uint8Array<ArrayBuffer> | undefined;
      return {
        write: async (data) => {
          if (typeof data === 'string') text += data;
          else bytes = data;
        },
        close: async () =>
          void (bytes
            ? await fs.writeBytes(path, fname, bytes)
            : await fs.write(path, fname, text)),
      };
    },
  });
  return {
    kind: 'directory',
    name,
    nativePath: path,
    async getFileHandle(fname, options) {
      // With `create`, the file appears when it is first written.
      if (!options?.create && !(await fs.stat(path, fname))) throw notFound(fname);
      return file(fname);
    },
    async getDirectoryHandle(child, options) {
      const there = (await fs.list(path)).some((e) => e.name === child && e.kind === 'directory');
      if (!there) {
        if (!options?.create) throw notFound(child);
        await fs.mkdir(path, child);
      }
      return nativeDir(`${path}/${child}`, child, fs);
    },
    async *values() {
      for (const entry of await fs.list(path)) {
        if (entry.kind === 'file') yield file(entry.name);
        else yield nativeDir(`${path}/${entry.name}`, entry.name, fs);
      }
    },
    async removeEntry(fname) {
      if (!(await fs.remove(path, fname))) throw notFound(fname);
    },
  };
}

/** What to keep in IndexedDB for a folder: a native folder is stored as its path. */
export function storableHandle(dir: DirHandleLike): unknown {
  return 'nativePath' in dir ? { nativePath: dir.nativePath, name: dir.name } : dir;
}

/** The reverse: a stored path becomes a native folder again when the bridge is there. */
export function reviveHandle(stored: unknown, fs: NativeFs | undefined): DirHandleLike {
  const s = stored as { nativePath?: unknown; name?: unknown };
  if (typeof s?.nativePath === 'string') {
    if (!fs) throw new Error('This folder was chosen in the Mac app and cannot be used here.');
    return nativeDir(s.nativePath, typeof s.name === 'string' ? s.name : s.nativePath, fs);
  }
  return stored as DirHandleLike;
}

export function sameNativeFolder(a: DirHandleLike, b: DirHandleLike): boolean {
  return 'nativePath' in a && 'nativePath' in b && a.nativePath === b.nativePath;
}
