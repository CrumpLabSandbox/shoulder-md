import { describe, it, expect } from 'vitest';
import { nativeDir, reviveHandle, sameNativeFolder, storableHandle } from '../src/folder/native';
import { FolderSync, memoryFolderStore } from '../src/folder/sync';
import { fileIfExists, listFileNames } from '../src/folder/fs';
import { MENU_COMMANDS, inTextField, runMenuCommand, type MenuActions } from '../src/app/commands';
import type { NativeFs } from '../src/app/bridge';
import { harness } from './helpers/model';
// The menu is plain data built by the main process; it has no Electron imports of its own.
import { menuTemplate } from '../electron/menu.mjs';

/** A stand-in for the main process's file handlers: one folder of files in memory. */
function fakeDisk() {
  const files = new Map<string, { content: string; lastModified: number }>();
  let clock = 1000;
  const key = (dir: string, name: string) => `${dir}/${name}`;
  const stat = (e: { content: string; lastModified: number }) => ({
    lastModified: e.lastModified,
    size: new TextEncoder().encode(e.content).length,
  });
  const fs: NativeFs = {
    list: async (dir) =>
      [...files.keys()]
        .filter((k) => k.startsWith(dir + '/'))
        .map((k) => ({ name: k.slice(dir.length + 1), kind: 'file' as const })),
    stat: async (dir, name) => {
      const e = files.get(key(dir, name));
      return e ? stat(e) : null;
    },
    read: async (dir, name) => files.get(key(dir, name))!.content,
    write: async (dir, name, content) => {
      const e = { content, lastModified: ++clock };
      files.set(key(dir, name), e);
      return stat(e);
    },
    remove: async (dir, name) => files.delete(key(dir, name)),
  };
  return { fs, files };
}

describe('native folders', () => {
  it('behaves like a directory handle for the sync engine', async () => {
    const disk = fakeDisk();
    const dir = nativeDir('/Users/me/Docs', 'Docs', disk.fs);
    expect(await fileIfExists(dir, 'nope.md')).toBeUndefined();
    await expect(dir.removeEntry('nope.md')).rejects.toMatchObject({ name: 'NotFoundError' });

    const sync = new FolderSync(dir, memoryFolderStore());
    const h = harness('# My Plan\n\nHello there.');
    expect((await sync.write(h.doc)).written).toBe(true);
    expect((await listFileNames(dir)).sort()).toEqual(['my-plan.md', 'my-plan.shoulder.json']);
    expect(disk.files.get('/Users/me/Docs/my-plan.md')!.content).toBe('# My Plan\n\nHello there.');
    expect(await sync.check(h.doc)).toEqual({ kind: 'none' });
    expect((await sync.write(h.doc)).written).toBe(false);

    // An edit made on disk by another program is noticed.
    await disk.fs.write('/Users/me/Docs', 'my-plan.md', '# My Plan\n\nHello there, world.');
    expect(await sync.check(h.doc)).toMatchObject({ kind: 'md' });
  });

  it('is stored as its path and revived only where the bridge exists', () => {
    const disk = fakeDisk();
    const dir = nativeDir('/a/b', 'b', disk.fs);
    const stored = storableHandle(dir);
    expect(stored).toEqual({ nativePath: '/a/b', name: 'b' });
    expect(structuredClone(stored)).toEqual(stored);
    const back = reviveHandle(stored, disk.fs);
    expect(sameNativeFolder(dir, back)).toBe(true);
    expect(sameNativeFolder(dir, nativeDir('/a/c', 'c', disk.fs))).toBe(false);
    expect(() => reviveHandle(stored, undefined)).toThrow(/Mac app/);
    // A browser handle passes through untouched either way.
    const browserHandle = { kind: 'directory', name: 'x' };
    expect(storableHandle(browserHandle as never)).toBe(browserHandle);
    expect(reviveHandle(browserHandle, undefined)).toBe(browserHandle);
  });
});

describe('menu commands', () => {
  it('every menu item sends a command the app knows, and every command is on a menu', () => {
    const sent: string[] = [];
    const ids: string[] = [];
    const walk = (items: { id?: string; click?: () => void; submenu?: unknown }[]) => {
      for (const it of items) {
        if (it.id) {
          ids.push(it.id);
          it.click?.();
        }
        if (Array.isArray(it.submenu)) walk(it.submenu as never);
      }
    };
    walk(menuTemplate((c: string) => sent.push(c), 'Shoulder') as never);
    expect(sent).toEqual(ids);
    expect([...ids].sort()).toEqual([...MENU_COMMANDS].sort());
  });

  it('runs known commands and ignores unknown ones', () => {
    const ran: string[] = [];
    const actions = Object.fromEntries(
      MENU_COMMANDS.map((c) => [c, () => ran.push(c)]),
    ) as unknown as MenuActions;
    expect(runMenuCommand(actions, 'accept-all')).toBe(true);
    expect(runMenuCommand(actions, 'rm -rf')).toBe(false);
    expect(ran).toEqual(['accept-all']);
  });

  it('leaves Undo to a text field, but not to the editor', () => {
    document.body.innerHTML =
      '<input id="t" /><div class="cm-editor"><textarea id="e"></textarea></div><button id="b"></button>';
    expect(inTextField(document.getElementById('t'))).toBe(true);
    expect(inTextField(document.getElementById('e'))).toBe(false);
    expect(inTextField(document.getElementById('b'))).toBe(false);
    expect(inTextField(null)).toBe(false);
  });
});
