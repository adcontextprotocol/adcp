import type { AdcpStateStore } from '@adcp/sdk/server';
import type { SupplyPathManifest } from './supply-path-contract.js';
import { observeSupplyPathAuthority } from './supply-path-authority-state.js';
import { record } from './supply-path-input.js';

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
  const observation = trustedSource && fresh && record(snapshot.manifest) ? snapshot.manifest : null;
  // Persist denial evidence from trusted observations even when their affirmative
  // envelope is invalid. Only a valid, single-hop manifest may establish a pin.
  const manifest = observation && Array.isArray(observation.authorized_agents) &&
    observation.authoritative_location === undefined && observation.superseded_by === undefined ? observation : null;
  const location = manifest && resolved ? (snapshot.discoveryMethod === 'authoritative_location' ? resolved.href : canonical) : undefined;
  const held = await observeSupplyPathAuthority(publisher, observation, location, store);
  return { manifest, held: held.revoked, explicitPublisher: resolved !== null && resolved.origin !== origin };
}
