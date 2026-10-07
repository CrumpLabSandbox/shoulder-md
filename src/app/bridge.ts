/**
 * What the Mac app (electron/preload.cjs) adds to the page. In a browser there is no bridge and
 * the app falls back to the File System Access API and its own keyboard handling.
 */
import type { Stat } from '../folder/sync';

export type NativeFs = {
  list(dir: string): Promise<{ name: string; kind: 'file' | 'directory' }[]>;
  /** Null when there is no such file. */
  stat(dir: string, name: string): Promise<Stat | null>;
  read(dir: string, name: string): Promise<string>;
  write(dir: string, name: string, content: string): Promise<Stat>;
  mkdir(dir: string, name: string): Promise<void>;
  /** Removes a file or an empty folder. False when there was nothing to remove. */
  remove(dir: string, name: string): Promise<boolean>;
};

/** Models Claude Code can be asked to use; '' means its own default. */
export const CLAUDE_MODELS = [
  { id: '', label: 'Claude Code’s default' },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];

export type ClaudeEvent = {
  kind: 'text' | 'step' | 'done' | 'error';
  text: string;
  /** On the final event of a run: the conversation to continue with. */
  sessionId?: string;
};

/** The user's own Claude Code, started by the app. It may not be installed. */
export type ClaudeBridge = {
  status(): Promise<{ available: boolean; version?: string }>;
  /**
   * Asks for proposals on one document (its path inside `folder`). Progress arrives through
   * `onEvent`; the promise resolves with the outcome, a 'done' or 'error' event.
   */
  ask(folder: string, docFile: string, note?: string, model?: string): Promise<ClaudeEvent>;
  /** One turn of a conversation about a document; pass the last `sessionId` to continue it. */
  chat(
    folder: string,
    docFile: string,
    message: string,
    sessionId?: string,
    model?: string,
  ): Promise<ClaudeEvent>;
  cancel(): Promise<void>;
  onEvent(handler: (event: ClaudeEvent) => void): () => void;
};

export type AppBridge = {
  /** Opens the system folder dialog; null if cancelled. */
  pickFolder(): Promise<{ path: string; name: string } | null>;
  fs: NativeFs;
  claude: ClaudeBridge;
  /** Calls `handler` with each menu command; returns a function that stops listening. */
  onMenu(handler: (command: string) => void): () => void;
};

export function appBridge(): AppBridge | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as { shoulderApp?: AppBridge }).shoulderApp;
}
