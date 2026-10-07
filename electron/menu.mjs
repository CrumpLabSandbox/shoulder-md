// The application menu. Every item that acts on a document sends a command name to the window;
// src/app/commands.ts lists the names and App.svelte carries them out.

/** @param {(command: string) => void} send  @param {string} appName */
export function menuTemplate(send, appName) {
  const item = (label, command, accelerator) => ({
    id: command,
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => send(command),
  });
  const sep = { type: 'separator' };
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        sep,
        item('Settings…', 'settings', 'Cmd+,'),
        sep,
        { role: 'services' },
        sep,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        sep,
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        item('New Document', 'new', 'Cmd+N'),
        item('Import…', 'import', 'Cmd+O'),
        sep,
        item('Documents', 'documents', 'Shift+Cmd+D'),
        item('Library', 'library', 'Alt+Cmd+L'),
        sep,
        item('Save Now', 'save', 'Cmd+S'),
        item('Choose Shared Folder…', 'folder'),
        item('Choose Private Folder…', 'folder-private'),
        sep,
        {
          label: 'Export',
          submenu: [
            item('Markdown (clean)', 'export:md-clean'),
            item('Markdown (original)', 'export:md-original'),
            item('Markdown with Changes (CriticMarkup)', 'export:md-critic'),
            item('Word (.docx)', 'export:docx'),
            item('Document with History (.json)', 'export:json'),
          ],
        },
        item('Print or Save as PDF…', 'export:print-clean', 'Cmd+P'),
        item('Print with Changes…', 'export:print-markup', 'Shift+Cmd+P'),
        sep,
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', 'Cmd+Z'),
        item('Redo', 'redo', 'Shift+Cmd+Z'),
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Markup', 'view:revision'),
        item('Clean', 'view:clean'),
        item('Original', 'view:original'),
        sep,
        item('Write', 'layout:editor'),
        item('Split', 'layout:split', 'Shift+Cmd+E'),
        item('Preview', 'layout:preview', 'Cmd+E'),
        sep,
        item('Changes and Comments', 'margin', 'Alt+Cmd+M'),
        sep,
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Changes',
      submenu: [
        item('Track Changes', 'tracking', 'Alt+Cmd+T'),
        sep,
        item('Accept Change', 'accept', 'Alt+Cmd+A'),
        item('Reject Change', 'reject', 'Alt+Cmd+R'),
        item('Next Change', 'next', 'Alt+Cmd+N'),
        item('Previous Change', 'previous', 'Alt+Cmd+P'),
        sep,
        item('Accept All Changes', 'accept-all'),
        item('Reject All Changes', 'reject-all'),
        sep,
        item('Ask Claude to Suggest Edits…', 'ask-claude', 'Alt+Cmd+K'),
        item('Chat with Claude', 'chat', 'Alt+Cmd+J'),
        sep,
        item('Add a Reason', 'reason', 'Alt+Cmd+E'),
        item('Comment on Selection', 'comment', 'Alt+Cmd+C'),
      ],
    },
    { role: 'windowMenu' },
  ];
}
