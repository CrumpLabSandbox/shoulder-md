/** The application menu template; `send` is called with a command name (src/app/commands.ts). */
export function menuTemplate(send: (command: string) => void, appName: string): unknown[];

/** What the page reports so the menu can show it: marks on Track Changes, the view, and so on. */
export type MenuState = {
  tracking: boolean;
  margin: boolean;
  chat: boolean;
  view: 'revision' | 'clean' | 'original';
  layout: 'editor' | 'split' | 'preview';
};
export function checkedItems(state: MenuState): Record<string, boolean>;
