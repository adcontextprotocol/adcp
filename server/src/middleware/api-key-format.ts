/**
 * Check if a token looks like a WorkOS API key.
 * WorkOS has used multiple key prefixes over time: 'wos_api_key_' (legacy) and 'sk_' (current).
 */
export function isWorkOSApiKeyFormat(token: string): boolean {
  return token.startsWith('wos_api_key_') || token.startsWith('sk_');
}

/**
 * Recognize an explicitly selected bearer credential before considering cookies.
 * HTTP authentication schemes are case-insensitive; accept separator spaces
 * and tabs so alternate header formatting cannot cause credential fallback.
 * An empty string is a presented, invalid bearer; null means no bearer scheme.
 */
export function getBearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  let separator = 0;
  while (separator < authorization.length && authorization[separator] !== ' ' && authorization[separator] !== '\t') separator++;
  if (authorization.slice(0, separator).toLowerCase() !== 'bearer') return null;
  while (authorization[separator] === ' ' || authorization[separator] === '\t') separator++;
  return authorization.slice(separator);
}

export function getWorkOSApiKeyToken(authorization: string | undefined): string | null {
  const token = getBearerToken(authorization);
  return token !== null && isWorkOSApiKeyFormat(token) ? token : null;
}
