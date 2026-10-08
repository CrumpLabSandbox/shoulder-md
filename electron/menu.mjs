// The application menu. Every item that acts on a document sends a command name to the window;
// src/app/commands.ts lists the names and App.svelte carries them out.

/** @param {(command: string) => void} send  @param {string} appName */
export function menuTemplate(send, appName) {
  const item = (label, command, accelerator, type) => ({
    id: command,
    label,
    ...(accelerator ? { accelerator } : {}),
    ...(type ? { type } : {}),
    click: () => send(command),
  });
  // Items that show the app's current state; main.mjs keeps their marks in step with the page.
  const check = (label, command, accelerator) => item(label, command, accelerator, 'checkbox');
  const radio = (label, command, accelerator) => item(label, command, accelerator, 'radio');
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
        item('Insert Image…', 'insert-image', 'Shift+Cmd+I'),
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
        radio('Markup', 'view:revision'),
        radio('Clean', 'view:clean'),
        radio('Original', 'view:original'),
        sep,
        radio('Write', 'layout:editor'),
        radio('Split', 'layout:split', 'Shift+Cmd+E'),
        radio('Preview', 'layout:preview', 'Cmd+E'),
        sep,
        check('Changes and Comments', 'margin', 'Alt+Cmd+M'),
        sep,
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Changes',
      submenu: [
        check('Track Changes', 'tracking', 'Alt+Cmd+T'),
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
        check('Chat with Claude', 'chat', 'Alt+Cmd+J'),
        item('Draft Principles from Samples…', 'draft-principles'),
        item('Principle Inbox', 'inbox'),
        sep,
        item('Add a Reason', 'reason', 'Alt+Cmd+E'),
        item('Comment on Selection', 'comment', 'Alt+Cmd+C'),
      ],
    },
    { role: 'windowMenu' },
  ];
}

/** The ids of items that carry a mark, given the page's state. */
export function checkedItems(state) {
  return {
    tracking: !!state.tracking,
    margin: !!state.margin,
    chat: !!state.chat,
    'view:revision': state.view === 'revision',
    'view:clean': state.view === 'clean',
    'view:original': state.view === 'original',
    'layout:editor': state.layout === 'editor',
    'layout:split': state.layout === 'split',
    'layout:preview': state.layout === 'preview',
  };
}
