/**
 * Shortens long command output to its start and its end, joined by a line that
 * says how much was left out. A command reports why it failed or warned near
 * the end of its output, so the end gets most of the room. The result is never
 * longer than `limit`.
 */
export function clipOutput(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = (omitted: number) => `[… ${omitted} characters omitted …]\n`;
  // Fewer characters are left out than the text holds, so this is the longest the
  // marker can get. One more is kept for a line break after a head cut mid-line.
  const room = limit - marker(text.length).length - 1;
  if (room <= 0) return text.slice(-limit);

  let headEnd = Math.floor(room / 4);
  let tailStart = text.length - (room - headEnd);
  // Cut at line breaks when that keeps most of the text, so no line is shown in part.
  const headBreak = text.lastIndexOf("\n", headEnd - 1);
  if (headBreak >= headEnd / 2) headEnd = headBreak + 1;
  const tailBreak = text.indexOf("\n", tailStart);
  if (tailBreak >= 0 && tailBreak - tailStart < (text.length - tailStart) / 2) tailStart = tailBreak + 1;

  const head = text.slice(0, headEnd);
  const separator = head && !head.endsWith("\n") ? "\n" : "";
  return `${head}${separator}${marker(tailStart - headEnd)}${text.slice(tailStart)}`;
}
