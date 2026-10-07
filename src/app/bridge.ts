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
  /** False when there was nothing to remove. */
  remove(dir: string, name: string): Promise<boolean>;
};

export type ClaudeEvent = { kind: 'text' | 'step' | 'done' | 'error'; text: string };

/** The user's own Claude Code, started by the app. It may not be installed. */
export type ClaudeBridge = {
  status(): Promise<{ available: boolean; version?: string }>;
  /** Asks for proposals on one document; resolves when Claude Code has finished. */
  ask(folder: string, docFile: string, note?: string): Promise<void>;
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
