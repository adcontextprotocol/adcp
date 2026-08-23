import { safeFetch } from '../utils/url-security.js';

const MANIFEST_VERIFICATION_TIMEOUT_MS = 10_000;

export interface VerifiableManifestReference {
  reference_type: 'url' | 'agent';
  manifest_url?: string | null;
  agent_url?: string | null;
}

/**
 * Check a stored, member-contributed reference through the SSRF-safe
 * transport. safeFetch validates every redirect and rechecks the resolved IP
 * at connection time, closing both direct private-network and DNS-rebinding
 * paths.
 */
export async function isManifestReferenceReachable(
  reference: VerifiableManifestReference,
): Promise<boolean> {
  const target = reference.reference_type === 'url'
    ? reference.manifest_url
    : reference.agent_url;
  if (!target) return false;

  try {
    const response = await safeFetch(target, {
      method: 'HEAD',
      maxRedirects: 3,
      signal: AbortSignal.timeout(MANIFEST_VERIFICATION_TIMEOUT_MS),
    });
    response.body?.cancel().catch(() => {});
    return response.ok || (reference.reference_type === 'agent' && response.status === 405);
  } catch {
    return false;
  }
}
