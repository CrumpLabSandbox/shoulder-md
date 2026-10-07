/**
 * The slice of the File System Access API the folder sync uses, as interfaces, so the engine
 * runs against real directory handles in Chrome and Edge and an in-memory folder in tests.
 */

import { appBridge } from '../app/bridge';
import { nativeDir } from './native';

export type Permission = 'granted' | 'denied' | 'prompt';

export interface FileLike {
  readonly lastModified: number;
  readonly size: number;
  text(): Promise<string>;
  /** The file's bytes, for images. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface WritableLike {
  write(data: string | Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<FileLike>;
  /** Writes go to a swap file and replace the original atomically on close(). */
  createWritable(): Promise<WritableLike>;
}

export interface DirHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  values(): AsyncIterable<FileHandleLike | DirHandleLike>;
  removeEntry(name: string): Promise<void>;
  queryPermission?(descriptor: { mode: 'readwrite' }): Promise<Permission>;
  requestPermission?(descriptor: { mode: 'readwrite' }): Promise<Permission>;
}

type PickerWindow = {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'readwrite' }) => Promise<DirHandleLike>;
};

export function folderSupported(): boolean {
  if (appBridge()) return true;
  return (
    typeof window !== 'undefined' &&
    typeof (window as PickerWindow).showDirectoryPicker === 'function'
  );
}

/** Opens the system folder picker. Rejects with an AbortError if the user cancels. */
export async function pickFolder(): Promise<DirHandleLike> {
  const bridge = appBridge();
  if (bridge) {
    const picked = await bridge.pickFolder();
    if (!picked) throw Object.assign(new Error('No folder chosen'), { name: 'AbortError' });
    return nativeDir(picked.path, picked.name, bridge.fs);
  }
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('This browser cannot save to a folder. Use Chrome or Edge.');
  return picker({ id: 'shoulder-md', mode: 'readwrite' });
}

export async function permissionOf(dir: DirHandleLike, request = false): Promise<Permission> {
  const fn = request ? dir.requestPermission : dir.queryPermission;
  if (!fn) return 'granted';
  return fn.call(dir, { mode: 'readwrite' });
}

/** Returns the handle, or undefined when the file does not exist. */
export async function fileIfExists(
  dir: DirHandleLike,
  name: string,
): Promise<FileHandleLike | undefined> {
  try {
    return await dir.getFileHandle(name);
  } catch (e) {
    if (e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError'))
      return undefined;
    throw e;
  }
}

export async function writeFile(
  dir: DirHandleLike,
  name: string,
  content: string,
): Promise<FileLike> {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(content);
  await w.close();
  return handle.getFile();
}

export async function listFileNames(dir: DirHandleLike): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of dir.values()) if (entry.kind === 'file') names.push(entry.name);
  return names;
}

export async function writeBytes(
  dir: DirHandleLike,
  name: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}
