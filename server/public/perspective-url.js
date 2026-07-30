/**
 * Returns a normalized, credential-free HTTPS URL for public perspective
 * navigation, or null for unsafe/legacy values.
 */
function getSafePerspectiveExternalUrl(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 2048
    || /[\u0000-\u001F\u007F<>\\]/.test(value)
  ) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.href.length <= 2048 ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Allows either a safe external perspective URL or the local perspective
 * detail fallback returned by the Latest API.
 */
function getSafePerspectiveNavigationUrl(value) {
  const externalUrl = getSafePerspectiveExternalUrl(value);
  if (externalUrl) return externalUrl;
  if (
    typeof value !== 'string'
    || value.length > 2048
    || /[\u0000-\u001F\u007F<>\\]/.test(value)
    || !value.startsWith('/perspectives/')
  ) {
    return null;
  }

  try {
    const base = new URL('https://agenticadvertising.org');
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin || !parsed.pathname.startsWith('/perspectives/')) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
