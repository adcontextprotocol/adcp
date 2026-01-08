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
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
      // Numeric character references (hex)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
        String.fromCodePoint(parseInt(code, 16))
      )
      // Named entities
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
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
  );
}
