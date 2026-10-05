export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
