const MAX_PERSPECTIVE_EXTERNAL_URL_LENGTH = 2048;
const AMBIGUOUS_PERSPECTIVE_URL_CHARACTERS = /[\u0000-\u001F\u007F<>\\]/;

/**
 * External perspective links are rendered on public pages, so only
 * canonical, credential-free HTTPS URLs may be persisted.
 *
 * URL accepts and silently removes ASCII tab/newline characters. It also
 * reinterprets backslashes as path separators and percent-encodes angle
 * brackets. Reject those raw boundary characters before parsing so callers
 * never validate one string and persist or render a meaningfully different
 * one.
 */
export function normalizePerspectiveExternalUrl(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_PERSPECTIVE_EXTERNAL_URL_LENGTH
    || AMBIGUOUS_PERSPECTIVE_URL_CHARACTERS.test(value)
  ) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return null;
    }

    const canonicalUrl = parsed.href;
    return canonicalUrl.length <= MAX_PERSPECTIVE_EXTERNAL_URL_LENGTH
      ? canonicalUrl
      : null;
  } catch {
    return null;
  }
}

/**
 * Compatibility predicate for read-only checks. Writers must use
 * normalizePerspectiveExternalUrl and persist its return value.
 */
export function isSafePerspectiveExternalUrl(value: unknown): value is string {
  return normalizePerspectiveExternalUrl(value) !== null;
}

/**
 * CommonMark's angle-bracket form keeps valid URL punctuation such as
 * parentheses from being interpreted as link-destination delimiters.
 */
export function formatPerspectiveUrlAsMarkdownDestination(value: unknown): string | null {
  const canonicalUrl = normalizePerspectiveExternalUrl(value);
  return canonicalUrl ? `<${canonicalUrl}>` : null;
}
