export type ClaudeEvent = {
  kind: 'text' | 'step' | 'done' | 'error';
  text: string;
  sessionId?: string;
};
export function eventsFromLine(line: string): ClaudeEvent[];
export function takeLines(buffer: string): { lines: string[]; rest: string };
export function proposalPrompt(docFile: string, note?: string): string;
export const ALLOWED_TOOLS: string[];
export const CLAUDE_MODELS: string[];
export function claudeArgs(docFile: string, note?: string, model?: string): string[];
export const CHAT_TOOLS: string[];
export function chatSystemPrompt(docFile: string): string;
export function chatArgs(
  docFile: string,
  message: string,
  sessionId?: string,
  model?: string,
): string[];
