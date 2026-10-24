/**
 * Cuts `text` to at most `max` UTF-16 code units on a grapheme boundary,
 * so a family emoji or flag at the cut never leaves a joiner or a lone surrogate in a stored title or name.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let end = 0;
    for (const { segment } of segmenter.segment(text)) {
      if (end + segment.length > max) break;
      end += segment.length;
    }
    return text.slice(0, end);
  }
  const last = text.charCodeAt(Math.max(0, max - 1));
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
