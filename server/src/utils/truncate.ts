/**
 * Shorten prose for display.
 *
 * Cuts at the last whitespace before `maxLen` and appends a single "…", so a
 * reader never sees a word cut in half ("infrastr"). Trailing punctuation
 * left at the cut ("growth, …") is dropped first. When the only whitespace
 * falls in the first half of the window — one very long token such as a
 * URL — the cut lands mid-token rather than throwing most of the text away.
 *
 * The result is at most `maxLen + 1` characters (the ellipsis is extra).
 * Text that already fits is returned unchanged, so shortening an already
 * shortened string is a no-op and never stacks a second ellipsis.
 */
export function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  // Whitespace at index maxLen still counts: the word before it fits whole.
  let cut = -1;
  for (let i = maxLen; i >= 0; i--) {
    if (/\s/.test(text[i])) {
      cut = i;
      break;
    }
  }
  const head = cut > maxLen * 0.5 ? text.slice(0, cut) : text.slice(0, maxLen);
  return `${trimTrailing(head, TRAILING_JUNK)}…`;
}

/** Whitespace and punctuation that should not sit right before an ellipsis. */
const TRAILING_JUNK = ',;:.-–—…';

/**
 * Remove trailing whitespace and the given characters. A loop rather than an
 * anchored regex, which backtracks quadratically on long runs.
 */
export function trimTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && (/\s/.test(text[end - 1]) || chars.includes(text[end - 1]))) end--;
  return text.slice(0, end);
}

/**
 * Collapse whitespace runs (including newlines) to single spaces. Use before
 * truncating text that came from HTML or markdown so the length budget is
 * spent on words, not layout.
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
