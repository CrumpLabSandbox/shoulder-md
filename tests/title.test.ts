import { describe, it, expect } from 'vitest';
import { deriveTitle, displayTitle } from '../src/docs/title';

describe('deriveTitle', () => {
  it('uses the first heading', () => {
    expect(deriveTitle('\n\n## My *Paper*\n\ntext')).toBe('My Paper');
  });
  it('falls back to the first non-empty line', () => {
    expect(deriveTitle('\nJust a line.\nMore')).toBe('Just a line.');
  });
  it('returns Untitled for empty text', () => {
    expect(deriveTitle('   \n\n')).toBe('Untitled');
  });
  it('skips images and reads links as their text', () => {
    expect(deriveTitle('![red dot](assets/red-dot.png)\n\nThe real first line')).toBe(
      'The real first line',
    );
    expect(deriveTitle('![only an image](assets/a.png)\n')).toBe('Untitled');
    expect(deriveTitle('# See [the plan](https://example.com) ![x](assets/x.png)')).toBe(
      'See the plan',
    );
  });
  it('truncates long titles', () => {
    expect(deriveTitle('x'.repeat(200))).toHaveLength(78);
  });
});

describe('displayTitle', () => {
  it('prefers an explicit title and derives otherwise', () => {
    expect(displayTitle('Mine', '# Draft')).toBe('Mine');
    expect(displayTitle('  ', '# Draft')).toBe('Draft');
  });
});
