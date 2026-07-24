/**
 * Convert a numeric character reference to its character, tolerating
 * out-of-range values. `String.fromCodePoint` throws a `RangeError` for code
 * points outside the valid Unicode range (0..0x10FFFF), so a malformed
 * reference such as `&#9999999999;` or `&#xFFFFFFFF;` in untrusted input
 * (RSS titles, scraped meta tags) would otherwise crash the caller. Invalid
 * references are left as their original literal text rather than throwing.
 */
function decodeCodePoint(code: number, original: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return original;
  }
  return String.fromCodePoint(code);
}

/**
 * Decode HTML entities in text.
 * Handles both named entities and numeric character references.
 *
 * @param text - The text containing HTML entities to decode
 * @returns The decoded text with entities replaced by their character equivalents
 */
export function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  return (
    text
      // Numeric character references (decimal) - must come first
      // Use fromCodePoint to handle code points beyond BMP (emoji, etc.)
      .replace(/&#(\d+);/g, (match, code) => decodeCodePoint(parseInt(code, 10), match))
      // Numeric character references (hex)
      .replace(/&#x([0-9a-fA-F]+);/g, (match, code) =>
        decodeCodePoint(parseInt(code, 16), match)
      )
      // Named entities (&amp; must be last to avoid double-decoding e.g. &amp;lt; -> &lt; -> <)
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&ndash;/g, '\u2013')
      .replace(/&mdash;/g, '\u2014')
      .replace(/&lsquo;/g, '\u2018')
      .replace(/&rsquo;/g, '\u2019')
      .replace(/&ldquo;/g, '\u201C')
      .replace(/&rdquo;/g, '\u201D')
      .replace(/&hellip;/g, '\u2026')
      .replace(/&amp;/g, '&')
  );
}
