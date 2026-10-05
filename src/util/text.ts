/** Word count that ignores Markdown punctuation-only tokens such as "#", "-", "**". */
export function countWords(source: string): number {
  const words = source.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return words ? words.length : 0;
}
