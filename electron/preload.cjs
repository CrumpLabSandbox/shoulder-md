// The only bridge between the sandboxed page and the main process (see src/app/bridge.ts).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shoulderApp', {
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  fs: {
    list: (dir) => ipcRenderer.invoke('fs:list', dir),
    stat: (dir, name) => ipcRenderer.invoke('fs:stat', dir, name),
    read: (dir, name) => ipcRenderer.invoke('fs:read', dir, name),
    write: (dir, name, content) => ipcRenderer.invoke('fs:write', dir, name, content),
    remove: (dir, name) => ipcRenderer.invoke('fs:remove', dir, name),
  },
  onMenu: (handler) => {
    const listener = (_event, command) => handler(command);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
