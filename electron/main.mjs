// The Mac app: a window around the same web build, with native menus and direct folder access.
// The renderer stays sandboxed; it reaches the disk only through the handlers below, and only
// inside folders the user picked.
import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { menuTemplate } from './menu.mjs';
import { askClaude, cancelClaude, claudeStatus } from './claude.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');
/** `pnpm app:dev` points the window at the Vite dev server instead of the built files. */
const DEV_URL = process.env.SHOULDER_DEV_URL;
const APP_URL = 'app://shoulder/';

// Tests use their own profile and skip the folder dialog.
if (process.env.SHOULDER_USER_DATA) app.setPath('userData', process.env.SHOULDER_USER_DATA);

// A fixed origin for the built files, so the app's stored documents do not depend on a path.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/* ---------- folders the user has picked ---------- */

const grantsFile = () => path.join(app.getPath('userData'), 'folders.json');
let granted = [];

async function loadGrants() {
  try {
    const list = JSON.parse(await fs.readFile(grantsFile(), 'utf8'));
    granted = Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  } catch {
    granted = [];
  }
}

async function grant(dir) {
  if (granted.includes(dir)) return;
  granted.push(dir);
  await fs.writeFile(grantsFile(), JSON.stringify(granted, null, 2));
}

/** The full path of a file directly inside a picked folder; anything else is refused. */
function inside(dir, name) {
  if (!granted.includes(dir)) throw new Error('That folder has not been opened in the app.');
  if (typeof name !== 'string' || !name || name !== path.basename(name) || name === '..')
    throw new Error('Not a file name.');
  return path.join(dir, name);
}

const statOf = (s) => ({ lastModified: Math.round(s.mtimeMs), size: s.size });
const missing = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

function registerFolderHandlers() {
  ipcMain.handle('folder:pick', async (event) => {
    let dir = process.env.SHOULDER_TEST_FOLDER;
    if (!dir) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const r = await dialog.showOpenDialog(win, {
        title: 'Choose a folder for your documents',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      dir = r.filePaths[0];
    }
    await grant(dir);
    return { path: dir, name: path.basename(dir) };
  });

  ipcMain.handle('fs:list', async (_e, dir) => {
    if (!granted.includes(dir)) throw new Error('That folder has not been opened in the app.');
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((d) => d.isFile() || d.isDirectory())
      .map((d) => ({ name: d.name, kind: d.isDirectory() ? 'directory' : 'file' }));
  });

  ipcMain.handle('fs:stat', async (_e, dir, name) => {
    try {
      const s = await fs.stat(inside(dir, name));
      return s.isFile() ? statOf(s) : null;
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  });

  ipcMain.handle('fs:read', async (_e, dir, name) => fs.readFile(inside(dir, name), 'utf8'));

  ipcMain.handle('fs:write', async (_e, dir, name, content) => {
    const file = inside(dir, name);
    // Write beside the file and swap it in, so a reader never sees half a file.
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, file);
    return statOf(await fs.stat(file));
  });

  ipcMain.handle('fs:remove', async (_e, dir, name) => {
    try {
      await fs.unlink(inside(dir, name));
      return true;
    } catch (e) {
      if (missing(e)) return false;
      throw e;
    }
  });
}

/* ---------- Claude Code ---------- */

/** The propose-edits skill shipped with the app; copied into the folder for each run. */
const SKILL = path.join(here, '..', '.claude', 'skills', 'propose-edits');

function registerClaudeHandlers() {
  ipcMain.handle('claude:status', () => claudeStatus());
  ipcMain.handle('claude:ask', async (event, folder, docFile, note) => {
    inside(folder, docFile); // only a document directly inside a folder the user picked
    const page = event.sender;
    await askClaude({
      folder,
      docFile,
      note,
      skillSource: SKILL,
      onEvent: (e) => !page.isDestroyed() && page.send('claude:event', e),
    });
  });
  ipcMain.handle('claude:cancel', () => cancelClaude());
}

/* ---------- window ---------- */

const isOurs = (url) => url.startsWith(APP_URL) || (!!DEV_URL && url.startsWith(DEV_URL));

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 760,
    minHeight: 480,
    title: 'shoulder-md',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Links in documents and previews open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  void win.loadURL(DEV_URL ?? APP_URL);
  return win;
}

/** Sends a menu command to the focused window, opening one if there is none. */
function send(command) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('menu', command);
  else createWindow().webContents.once('did-finish-load', () => send(command));
}

app.whenReady().then(async () => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const wanted = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(DIST, wanted);
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  await loadGrants();
  registerFolderHandlers();
  registerClaudeHandlers();
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(send, app.name)));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
