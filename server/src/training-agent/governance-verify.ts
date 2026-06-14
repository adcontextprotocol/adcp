/**
 * Sandbox governance-token VERIFIER for the S6 security lab.
 *
 * The training agent is normally a governance-token *issuer* (check_governance
 * mints a signed `governance_context`). It has no verification surface, so a
 * learner could never observe a tampered or revoked token being *rejected* —
 * the whole point of the JWS profile's 15-step seller checklist.
 *
 * This module adds a read-only verifier the `verify_governance_token`
 * comply scenario exposes (sandbox only). It runs the security-meaningful
 * subset of the checklist against the agent's own published JWK and returns a
 * per-step pass/fail trace plus the spec error code on first failure, so a
 * learner can: verify a real token (all pass), tamper a claim (signature
 * fails), present it to the wrong seller (aud fails — confused deputy), or
 * verify a token under a revoked kid (revocation fails).
 *
 * Spec: docs/building/by-layer/L1/security.mdx §"Seller verification checklist".
 */

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { compactVerify, FlattenedSign } from 'jose';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { getGovernanceSigningPublicJwk } from './governance-signing.js';

/** Canonical seller audience a real training-agent governance token is bound to. */
export const CANONICAL_SELLER_AUD = 'https://agenticadvertising.org/sales';

const ED25519_PKCS8_PREFIX = '302e020100300506032b657004220420';
const REVOKED_DEMO_LABEL = 'adcp-training-agent:sandbox:governance-signing:revoked-demo:v1';

// A second, deterministic governance key whose kid is treated as REVOKED. Used
// only to mint the revoked-token teaching fixture — never to sign real tokens.
let revokedDemo: { kid: string; privateKey: KeyObject; publicJwk: AdcpJsonWebKey } | null = null;
function getRevokedDemoKey() {
  if (revokedDemo) return revokedDemo;
  const seed = createHash('sha256').update(REVOKED_DEMO_LABEL).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from(ED25519_PKCS8_PREFIX, 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const { kty, crv, x } = createPublicKey(privateKey).export({ format: 'jwk' }) as { kty: 'OKP'; crv: 'Ed25519'; x: string };
  const kid = `training-gov-revoked-${createHash('sha256').update(x).digest('hex').slice(0, 12)}`;
  revokedDemo = { kid, privateKey, publicJwk: { kty, crv, x, kid, alg: 'EdDSA', adcp_use: 'governance-signing', key_ops: ['verify'], use: 'sig' } };
  return revokedDemo;
}

/** Kids the verifier treats as revoked (sandbox teaching fixture — NOT in the served revocation list, which stays empty for conformance). */
export function revokedGovernanceKids(): string[] {
  return [getRevokedDemoKey().kid];
}

/** Mint a sample token signed under the revoked demo kid, so a learner can watch step 14 reject it. */
export async function mintRevokedDemoToken(): Promise<string> {
  const { kid, privateKey } = getRevokedDemoKey();
  const now = Math.floor(Date.now() / 1000);
  const payload = new TextEncoder().encode(JSON.stringify({
    iss: 'https://agenticadvertising.org/governance', sub: 'plan-revoked-demo',
    aud: CANONICAL_SELLER_AUD, iat: now, exp: now + 900, jti: `revoked-demo-${now}`, phase: 'intent',
  }));
  const jws = await new FlattenedSign(payload).setProtectedHeader({ alg: 'EdDSA', typ: 'adcp-gov+jws', kid }).sign(privateKey);
  return `${jws.protected}.${jws.payload}.${jws.signature}`;
}

export interface ChecklistStep { step: number; name: string; pass: boolean; detail: string; }
export interface ChecklistResult { verdict: 'valid' | 'rejected'; steps: ChecklistStep[]; error_code: string | null; }

function resolveJwk(kid: string): AdcpJsonWebKey | null {
  const gov = getGovernanceSigningPublicJwk();
  if (kid === gov.kid) return gov;
  const revoked = getRevokedDemoKey().publicJwk;
  if (kid === revoked.kid) return revoked;
  return null;
}

/**
 * Run the security-meaningful subset of the 15-step seller verification checklist.
 * Stops at the first failure (returns rejected + its spec error code).
 */
export async function verifyGovernanceToken(
  token: string,
  opts: { expectedAud?: string; expectedSub?: string } = {},
): Promise<ChecklistResult> {
  const expectedAud = opts.expectedAud ?? CANONICAL_SELLER_AUD;
  const steps: ChecklistStep[] = [];
  const reject = (errorCode: string): ChecklistResult => ({ verdict: 'rejected', steps, error_code: errorCode });
  const pass = (step: number, name: string, detail: string) => { steps.push({ step, name, pass: true, detail }); };
  const fail = (step: number, name: string, detail: string) => { steps.push({ step, name, pass: false, detail }); };

  // 1. Parse compact JWS.
  const parts = token.split('.');
  if (parts.length !== 3) { fail(1, 'parse', 'not a 3-part compact JWS'); return reject('malformed_token'); }
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { fail(1, 'parse', 'header/payload not valid base64url JSON'); return reject('malformed_token'); }
  pass(1, 'parse', 'compact JWS decoded');

  // 2. alg allowlist (no none/downgrade).
  if (header.alg !== 'EdDSA') { fail(2, 'alg_allowlist', `alg=${String(header.alg)} not in {EdDSA}`); return reject('invalid_alg'); }
  pass(2, 'alg_allowlist', 'alg=EdDSA');

  // 3. typ match (exact, no normalization).
  if (header.typ !== 'adcp-gov+jws') { fail(3, 'typ_match', `typ=${String(header.typ)} != adcp-gov+jws`); return reject('invalid_typ'); }
  pass(3, 'typ_match', 'typ=adcp-gov+jws');

  // 5. Resolve iss -> JWKS -> kid.
  const kid = typeof header.kid === 'string' ? header.kid : '';
  const jwk = resolveJwk(kid);
  if (!jwk) { fail(5, 'jwks_resolve', `kid ${kid || '(none)'} not found in published JWKS`); return reject('unknown_kid'); }
  pass(5, 'jwks_resolve', `kid ${kid} resolved in published JWKS`);

  // 7. Cryptographic signature verification.
  try {
    const { importJWK } = await import('jose');
    const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, 'EdDSA');
    await compactVerify(token, key);
    pass(7, 'signature', 'signature valid for resolved key');
  } catch {
    fail(7, 'signature', 'signature verification failed (tampered token or wrong key)');
    return reject('invalid_signature');
  }

  // 8. aud byte-match against the seller's own canonical URL (confused-deputy defense).
  if (claims.aud !== expectedAud) { fail(8, 'aud_binding', `aud=${String(claims.aud)} != this seller's ${expectedAud}`); return reject('aud_mismatch'); }
  pass(8, 'aud_binding', `aud byte-matches ${expectedAud}`);

  // 9. exp / iat freshness (±60s skew).
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp < now - 60) { fail(9, 'expiry', `exp ${claims.exp} is in the past`); return reject('token_expired'); }
  pass(9, 'expiry', 'within validity window');

  // 10. sub binding (plan), when the caller asserts an expected plan.
  if (opts.expectedSub !== undefined && claims.sub !== opts.expectedSub) { fail(10, 'sub_binding', `sub=${String(claims.sub)} != expected plan ${opts.expectedSub}`); return reject('sub_mismatch'); }
  pass(10, 'sub_binding', opts.expectedSub ? `sub matches plan ${opts.expectedSub}` : `sub=${String(claims.sub)} (no plan asserted)`);

  // 11. phase present.
  if (typeof claims.phase !== 'string' || !claims.phase) { fail(11, 'phase_binding', 'phase claim missing'); return reject('invalid_phase'); }
  pass(11, 'phase_binding', `phase=${claims.phase}`);

  // 15. jti present (replay dedup is stateful in production; here we confirm the dedup key exists).
  if (typeof claims.jti !== 'string' || !claims.jti) { fail(15, 'jti_present', 'jti claim missing (no replay-dedup key)'); return reject('missing_jti'); }
  pass(15, 'jti_present', `jti=${claims.jti}`);

  // 14. Revocation — runs on every verification, independent of exp. A valid
  // signature on a revoked kid is still rejected.
  if (revokedGovernanceKids().includes(kid)) { fail(14, 'revocation', `kid ${kid} is in the revocation list`); return reject('governance_token_revoked'); }
  pass(14, 'revocation', `kid ${kid} not revoked`);

  return { verdict: 'valid', steps, error_code: null };
}
