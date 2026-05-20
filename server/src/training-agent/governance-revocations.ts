/**
 * Signed `governance-revocations.json` for the training agent.
 *
 * Spec: docs/building/by-layer/L1/security.mdx §"Revocation".
 *
 * The list is served as JWS flattened-JSON serialization so a compromised
 * CDN or DNS origin cannot tamper with it without invalidating the
 * signature. Sellers poll on the cadence declared in `next_update`; the
 * training agent advertises a 15-minute window — the spec ceiling for
 * issuers that may serve execution-phase tokens.
 *
 * The training-agent list is empty by design: the sandbox does not have a
 * key-compromise workflow, and the eleven golden test vectors do not
 * exercise revocation. The signed empty list is required so the
 * conformance ramp-up tests can verify fetch-and-parse behavior end to
 * end against the reference agent.
 */

import { FlattenedSign } from 'jose';
import { getGovernanceSigningKey } from './governance-signing.js';

const REVOCATION_TYP = 'adcp-gov-revocation+jws';
const NEXT_UPDATE_SECONDS = 15 * 60;
const REGEN_INTERVAL_MS = 60 * 1000;

interface CacheEntry {
  signedAt: number;
  list: FlattenedRevocationList;
}
const cache: Map<string, CacheEntry> = new Map();

export interface RevocationListPayload {
  version: 1;
  issuer: string;
  updated: string;
  next_update: string;
  revoked_jtis: string[];
  revoked_kids: string[];
}

export interface FlattenedRevocationList {
  payload: string;
  protected: string;
  signature: string;
}

/**
 * Build and sign the current revocation list for an issuer. Memoized per
 * issuer for `REGEN_INTERVAL_MS` so an unauthenticated DoS against the
 * well-known endpoint can't pin the agent to constant Ed25519 signing.
 * `updated` advances on each regeneration; `next_update` always lands
 * 15 minutes ahead — the spec ceiling for issuers serving execution-phase
 * tokens.
 */
export async function buildSignedRevocationList(issuer: string): Promise<FlattenedRevocationList> {
  const cached = cache.get(issuer);
  if (cached && Date.now() - cached.signedAt < REGEN_INTERVAL_MS) {
    return cached.list;
  }

  const now = new Date();
  const nextUpdate = new Date(now.getTime() + NEXT_UPDATE_SECONDS * 1000);
  const payload: RevocationListPayload = {
    version: 1,
    issuer,
    updated: now.toISOString(),
    next_update: nextUpdate.toISOString(),
    revoked_jtis: [],
    revoked_kids: [],
  };

  const { kid, privateKey } = getGovernanceSigningKey();
  const encoded = new TextEncoder().encode(JSON.stringify(payload));

  const jws = await new FlattenedSign(encoded)
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: REVOCATION_TYP })
    .sign(privateKey);

  const list: FlattenedRevocationList = {
    payload: jws.payload,
    protected: jws.protected ?? '',
    signature: jws.signature,
  };
  cache.set(issuer, { signedAt: Date.now(), list });
  return list;
}

/** Reset memoized lists — tests only. */
export function resetRevocationListCache(): void {
  cache.clear();
}
