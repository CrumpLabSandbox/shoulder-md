export type ClaudeEvent = { kind: 'text' | 'step' | 'done' | 'error'; text: string };
export function eventsFromLine(line: string): ClaudeEvent[];
export function takeLines(buffer: string): { lines: string[]; rest: string };
export function proposalPrompt(docFile: string, note?: string): string;
export const ALLOWED_TOOLS: string[];
