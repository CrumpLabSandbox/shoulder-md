/** Menu commands the Mac app sends (electron/menu.mjs). App.svelte supplies what each one does. */
export const MENU_COMMANDS = [
  'settings',
  'new',
  'import',
  'documents',
  'library',
  'save',
  'folder',
  'export:md-clean',
  'export:md-original',
  'export:md-critic',
  'export:docx',
  'export:json',
  'export:print-clean',
  'export:print-markup',
  'undo',
  'redo',
  'view:revision',
  'view:clean',
  'view:original',
  'layout:editor',
  'layout:split',
  'layout:preview',
  'margin',
  'tracking',
  'accept',
  'reject',
  'next',
  'previous',
  'accept-all',
  'reject-all',
  'reason',
  'comment',
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

export type MenuActions = Record<MenuCommand, () => void>;

/** Runs a command by name; unknown names are ignored. */
export function runMenuCommand(actions: MenuActions, command: string): boolean {
  if (!(MENU_COMMANDS as readonly string[]).includes(command)) return false;
  actions[command as MenuCommand]();
  return true;
}

/** Whether the focus is in an ordinary text field, where Undo should be the field's own. */
export function inTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el.closest('.cm-editor')) return false;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
