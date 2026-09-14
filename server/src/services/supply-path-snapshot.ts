import type { AdcpStateStore } from '@adcp/sdk/server';
import type { SupplyPathManifest } from './supply-path-contract.js';
import { observeSupplyPathAuthority } from './supply-path-authority-state.js';

export interface SupplyPathSnapshot {
  manifest: SupplyPathManifest | null;
  resolvedUrl: string | null;
  discoveryMethod: string | null;
  fetchedAt: Date | null;
  expiresAt: Date | null;
}

/** Only fresh, publisher-directed cache observations can supply authoritative legs. */
export async function supplyPathSnapshotEvidence(publisher: string, snapshot: SupplyPathSnapshot, store?: AdcpStateStore) {
  const origin = `https://${publisher}`;
  const canonical = `${origin}/.well-known/adagents.json`;
  let resolved: URL | null = null;
  if (typeof snapshot.resolvedUrl === 'string' && snapshot.resolvedUrl.length > 0 && snapshot.resolvedUrl.length <= 8192) {
    try {
      resolved = new URL(snapshot.resolvedUrl);
    } catch {
      // Corrupt cache provenance cannot establish authority. Still load held denials below.
    }
  }
  const secure = resolved !== null && resolved.protocol === 'https:' && !resolved.username && !resolved.password && !resolved.hash && (!resolved.port || resolved.port === '443');
  const trustedSource = secure && (snapshot.discoveryMethod === 'authoritative_location' || (snapshot.discoveryMethod === 'direct' && resolved?.origin === origin));
  const age = snapshot.fetchedAt ? Date.now() - snapshot.fetchedAt.getTime() : Infinity;
  const fresh = age >= 0 && age <= 7 * 86400000 && (!snapshot.expiresAt || snapshot.expiresAt.getTime() > Date.now());
  const manifest = trustedSource && fresh ? snapshot.manifest : null;
  const location = manifest && resolved ? (snapshot.discoveryMethod === 'authoritative_location' ? resolved.href : canonical) : undefined;
  const held = await observeSupplyPathAuthority(publisher, manifest, location, store);
  return { manifest, held: held.revoked, explicitPublisher: resolved !== null && resolved.origin !== origin };
}
