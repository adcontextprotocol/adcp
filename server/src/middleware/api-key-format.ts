/**
 * Check if a token looks like a WorkOS API key.
 * WorkOS has used multiple key prefixes over time: 'wos_api_key_' (legacy) and 'sk_' (current).
 */
export function isWorkOSApiKeyFormat(token: string): boolean {
  return token.startsWith('wos_api_key_') || token.startsWith('sk_');
}
