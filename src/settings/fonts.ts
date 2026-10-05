/** The bundled font catalog. Ids are stable and stored in settings; stacks are the CSS values. */

export type FontRole = 'serif' | 'sans' | 'mono' | 'duospace';

export type FontChoice = {
  id: string;
  label: string;
  role: FontRole;
  stack: string;
};

export const FONTS: readonly FontChoice[] = [
  {
    id: 'source-serif',
    label: 'Source Serif 4',
    role: 'serif',
    stack: "'Source Serif 4 Variable', Georgia, serif",
  },
  {
    id: 'literata',
    label: 'Literata',
    role: 'serif',
    stack: "'Literata Variable', Georgia, serif",
  },
  {
    id: 'source-sans',
    label: 'Source Sans 3',
    role: 'sans',
    stack: "'Source Sans 3 Variable', system-ui, sans-serif",
  },
  { id: 'inter', label: 'Inter', role: 'sans', stack: "'Inter Variable', system-ui, sans-serif" },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    role: 'mono',
    stack: "'JetBrains Mono Variable', ui-monospace, monospace",
  },
  {
    id: 'ia-mono',
    label: 'iA Writer Mono',
    role: 'mono',
    stack: "'iA Writer Mono', ui-monospace, monospace",
  },
  {
    id: 'ia-duo',
    label: 'iA Writer Duo',
    role: 'duospace',
    stack: "'iA Writer Duo', ui-monospace, monospace",
  },
  {
    id: 'ia-quattro',
    label: 'iA Writer Quattro',
    role: 'duospace',
    stack: "'iA Writer Quattro', system-ui, sans-serif",
  },
] as const;

export const ROLE_LABELS: Record<FontRole, string> = {
  serif: 'Serif',
  sans: 'Sans',
  mono: 'Monospace',
  duospace: 'Duospace',
};

export function fontById(id: string): FontChoice {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]!;
}
