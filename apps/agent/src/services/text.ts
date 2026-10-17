/**
 * Cuts `text` to at most `max` UTF-16 code units without splitting a surrogate pair,
 * so an emoji at the cut never leaves a lone surrogate (shown as "�") in a stored title or name.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
