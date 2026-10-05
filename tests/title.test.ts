import { describe, it, expect } from 'vitest';
import { deriveTitle, nextTitle } from '../src/docs/title';

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
  it('truncates long titles', () => {
    expect(deriveTitle('x'.repeat(200))).toHaveLength(78);
  });
});

describe('nextTitle', () => {
  it('follows the text while the title was derived', () => {
    expect(nextTitle('Untitled', '', '# Draft')).toBe('Draft');
    expect(nextTitle('Draft', '# Draft', '# Draft two')).toBe('Draft two');
  });
  it('keeps a title set by hand', () => {
    expect(nextTitle('Mine', '# Draft', '# Draft two')).toBe('Mine');
  });
});
