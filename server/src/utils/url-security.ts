import dns from 'dns/promises';
import { isIP } from 'net';

/**
 * Check if a hostname or IP address points to a private/internal network.
 * Used to prevent SSRF attacks in server-side fetch operations.
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname || hostname === 'localhost') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;

  // IPv4 private/reserved ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (hostname === '0.0.0.0') return true;

  // IPv6 loopback and private
  if (hostname === '::1' || hostname === '::') return true;
  // fe80: link-local, fc00:/fd00: ULA (unique local address) ranges
  if (hostname.startsWith('fe80:') || hostname.startsWith('fc00:') || hostname.startsWith('fd00:')) {
    return true;
  }

  return false;
}

/**
 * Resolve a hostname to an IP and verify it doesn't point to a private network.
 * Prevents DNS rebinding attacks where a hostname resolves to an internal IP.
 */
export async function validateHostResolution(hostname: string): Promise<void> {
  if (isPrivateHostname(hostname)) {
    throw new Error('URLs pointing to private or internal networks are not allowed');
  }

  // If already an IP literal, the string check above is sufficient
  if (isIP(hostname)) return;

  // Resolve DNS and check the actual IP
  const { address } = await dns.lookup(hostname);
  if (isPrivateHostname(address)) {
    throw new Error('URL resolved to a private or internal IP address');
  }
}

/**
 * Validate a URL for safe server-side fetching.
 * Checks protocol, hostname, and DNS resolution.
 */
export async function validateFetchUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are supported');
  }
  await validateHostResolution(url.hostname);
}
