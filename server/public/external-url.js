/**
 * Return a normalized external navigation URL, or an empty string when the
 * value is not an absolute HTTP(S) URL. Stored URLs are untrusted even when
 * current write paths validate them because legacy rows may predate that gate.
 */
(function exposeExternalUrlGuard(global) {
  global.safeExternalHttpUrl = function safeExternalHttpUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 2048) return '';

    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        !parsed.hostname
      ) {
        return '';
      }
      return parsed.href;
    } catch {
      return '';
    }
  };
})(typeof window === 'undefined' ? globalThis : window);
