/**
 * Sandbox governance-token VERIFIER for the S6 security lab.
 *
 * The training agent is normally a governance-token *issuer* (check_governance
 * mints a signed `governance_context`). It has no verification surface, so a
 * learner could never observe a tampered or revoked token being *rejected* —
 * the whole point of the JWS profile's seller verification checklist.
 *
 * This module adds a read-only verifier the `verify_governance_token`
 * comply scenario exposes (sandbox only). It runs the security-meaningful
 * steps of the checklist against the agent's own published JWK and returns a
 * per-step pass/fail trace plus the spec's normative error code on first
 * failure (docs/building/by-layer/L1/security.mdx §"Verification error
 * taxonomy": governance_token_invalid / governance_key_unknown /
 * governance_token_expired / governance_token_not_applicable /
 * governance_token_revoked). A learner can: verify a real token (all pass),
 * tamper a claim (signature fails), present it to the wrong seller (aud fails
 * — confused deputy), or verify a token under a revoked kid (revocation fails).
 *
 * Out of scope for this sandbox subset (noted so the trace isn't read as the
 * full checklist): SSRF-validated remote JWKS fetch, nbf, media_buy_id binding,
 * stateful jti replay-dedup, and the brand.json issuer cross-check. Spec:
 * docs/building/by-layer/L1/security.mdx §"Seller verification checklist".
 */

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { compactVerify, FlattenedSign, importJWK } from 'jose';
import type { AdcpJsonWebKey } from '@adcp/sdk/signing';
import { getGovernanceSigningPublicJwk, getGovernanceSigningKey } from './governance-signing.js';
import { computeGovernedPayloadHash } from './governance-payload-hash.js';

/** Canonical seller audience a real training-agent governance token is bound to. */
export const CANONICAL_SELLER_AUD = 'https://agenticadvertising.org/sales';
/** Canonical governance issuer a real training-agent token carries. */
export const CANONICAL_GOV_ISS = 'https://agenticadvertising.org/governance';

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

/** Mint a sample token signed under the revoked demo kid, so a learner can watch the revocation step reject it. */
export async function mintRevokedDemoToken(): Promise<string> {
  const { kid, privateKey } = getRevokedDemoKey();
  const now = Math.floor(Date.now() / 1000);
  const payload = new TextEncoder().encode(JSON.stringify({
    iss: CANONICAL_GOV_ISS, sub: 'plan-revoked-demo',
    aud: CANONICAL_SELLER_AUD, iat: now, exp: now + 900, jti: `revoked-demo-${now}`, phase: 'intent',
  }));
  const jws = await new FlattenedSign(payload).setProtectedHeader({ alg: 'EdDSA', typ: 'adcp-gov+jws', kid }).sign(privateKey);
  return `${jws.protected}.${jws.payload}.${jws.signature}`;
}

/**
 * Mint a VALIDLY-signed token (real governance key) but bound to a different
 * seller's `aud`, so a learner can watch the aud byte-match step reject a
 * confused-deputy / token-redirection attempt. The verifier always checks
 * against this seller's own canonical aud — the reference value is never
 * caller-controlled — so the demo is shown by minting a wrong-aud token, not
 * by letting the caller move the goalposts.
 */
export async function mintWrongAudDemoToken(): Promise<string> {
  const { kid, privateKey } = getGovernanceSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const payload = new TextEncoder().encode(JSON.stringify({
    iss: CANONICAL_GOV_ISS, sub: 'plan-wrong-aud-demo',
    aud: 'https://other-seller.example/sales', iat: now, exp: now + 900, jti: `wrong-aud-demo-${now}`, phase: 'intent',
  }));
  const jws = await new FlattenedSign(payload).setProtectedHeader({ alg: 'EdDSA', typ: 'adcp-gov+jws', kid }).sign(privateKey);
  return `${jws.protected}.${jws.payload}.${jws.signature}`;
}

export interface ChecklistStep { step: number; name: string; pass: boolean; detail: string; }
export interface ChecklistResult { verdict: 'valid' | 'rejected'; steps: ChecklistStep[]; error_code: string | null; }

export interface GovernedServiceAuthorizationInput {
  token: string;
  expectedIssuer: string;
  expectedAudience: string;
  expectedTask: string;
  payload: Record<string, unknown>;
  actualCommitment: { amount: number; currency: string };
  authenticatedCaller?: string;
}

export interface GovernedServiceAuthorizationResult {
  ok: boolean;
  errorCode?: 'PERMISSION_DENIED';
  message?: string;
  claims?: Record<string, unknown>;
  replay?: boolean;
}

interface ConsumedGovernanceToken {
  caller: string;
  payloadHash: string;
  idempotencyKey?: string;
}

const consumedGovernanceTokens = new Map<string, ConsumedGovernanceToken>();

/** Tests clear process-local replay teaching state between isolated scenarios. */
export function clearGovernanceTokenReplayRegistry(): void {
  consumedGovernanceTokens.clear();
}

function resolveJwk(kid: string): AdcpJsonWebKey | null {
  const gov = getGovernanceSigningPublicJwk();
  if (kid === gov.kid) return gov;
  const revoked = getRevokedDemoKey().publicJwk;
  if (kid === revoked.kid) return revoked;
  return null;
}

/**
 * Verify an authorization at a governed service boundary. Unlike the S6
 * trace helper below, this is the enforcement path used by the training
 * sales, signal, brand, and creative services.
 */
export async function verifyGovernedServiceAuthorization(
  input: GovernedServiceAuthorizationInput,
): Promise<GovernedServiceAuthorizationResult> {
  const reject = (message: string): GovernedServiceAuthorizationResult => ({
    ok: false,
    errorCode: 'PERMISSION_DENIED',
    message,
  });
  if (!input.authenticatedCaller) {
    return reject('A governed service request requires an authenticated buyer agent.');
  }
  if (!Number.isFinite(input.actualCommitment.amount) || input.actualCommitment.amount < 0) {
    return reject('The actual governed commitment must be finite and non-negative.');
  }

  const parts = input.token.split('.');
  if (parts.length !== 3) return reject('governance_context is not a compact JWS.');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as Record<string, unknown>;
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return reject('governance_context contains invalid protected-header or claim JSON.');
  }

  if (header.alg !== 'EdDSA' || header.typ !== 'adcp-gov+jws') {
    return reject('governance_context uses an unsupported alg or typ.');
  }
  const criticalNames = Array.isArray(header.crit)
    ? header.crit.filter((name): name is string => typeof name === 'string')
    : [];
  const recognizedCritical = ['authorized_commitment', 'authorized_task', 'authorized_payload_hash'];
  if (criticalNames.some(name => !recognizedCritical.includes(name))) {
    return reject('governance_context contains an unrecognized critical extension.');
  }
  for (const name of recognizedCritical) {
    const hasClaim = claims[name] !== undefined;
    const hasMarker = criticalNames.includes(name) && header[name] === true;
    if (hasClaim !== hasMarker) {
      return reject(`${name} must appear with its matching critical protected-header marker.`);
    }
  }
  if ((claims.authorized_task === undefined) !== (claims.authorized_payload_hash === undefined)) {
    return reject('authorized_task and authorized_payload_hash must appear together.');
  }

  if (claims.iss !== input.expectedIssuer) {
    return reject('governance_context issuer does not resolve to the training governance agent.');
  }
  const kid = typeof header.kid === 'string' ? header.kid : '';
  const jwk = resolveJwk(kid);
  if (!jwk || jwk.adcp_use !== 'governance-signing' || !jwk.key_ops?.includes('verify')) {
    return reject('governance_context signing key is unknown or not authorized for governance verification.');
  }
  try {
    const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, 'EdDSA');
    await compactVerify(input.token, key, {
      crit: {
        authorized_commitment: true,
        authorized_task: true,
        authorized_payload_hash: true,
      },
    });
  } catch {
    return reject('governance_context signature verification failed.');
  }
  if (revokedGovernanceKids().includes(kid)) {
    return reject('governance_context signing key is revoked.');
  }

  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (claims.aud !== input.expectedAudience) return reject('governance_context audience does not match this service.');
  if (claims.caller !== input.authenticatedCaller) return reject('Authenticated buyer does not match the authorized caller.');
  if (claims.phase !== 'intent' || claims.media_buy_id !== undefined) {
    return reject('The downstream service requires an intent-phase context without media_buy_id.');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return reject('governance_context has no opaque action binding.');
  if (typeof claims.plan_hash !== 'string' || !claims.plan_hash) return reject('governance_context has no plan_hash.');
  if (typeof claims.iat !== 'number' || claims.iat > now + skew) return reject('governance_context iat is invalid.');
  if (typeof claims.nbf === 'number' && claims.nbf > now + skew) return reject('governance_context is not active yet.');
  if (typeof claims.exp !== 'number' || claims.exp < now - skew) return reject('governance_context is expired.');
  if (typeof claims.jti !== 'string' || !claims.jti) return reject('governance_context has no replay identifier.');
  if (claims.authorized_task !== input.expectedTask) {
    return reject(`governance_context does not authorize ${input.expectedTask}.`);
  }

  let expectedPayloadHash: string;
  try {
    expectedPayloadHash = computeGovernedPayloadHash(input.payload);
  } catch {
    return reject('The governed task payload is not finite canonical JSON.');
  }
  if (claims.authorized_payload_hash !== expectedPayloadHash) {
    return reject('The governed task payload does not match the signed authorization.');
  }
  const commitment = claims.authorized_commitment;
  if (!commitment || typeof commitment !== 'object' || Array.isArray(commitment)) {
    return reject('governance_context has no signed monetary authorization.');
  }
  const amount = (commitment as Record<string, unknown>).amount;
  const currency = (commitment as Record<string, unknown>).currency;
  if (
    typeof amount !== 'number'
    || !Number.isFinite(amount)
    || amount < 0
    || currency !== input.actualCommitment.currency
    || input.actualCommitment.amount > amount
  ) {
    return reject('The actual commitment exceeds or mismatches the signed monetary ceiling.');
  }

  const replayKey = `${claims.iss}\u001f${claims.aud}\u001f${claims.jti}`;
  const idempotencyKey = typeof input.payload.idempotency_key === 'string'
    ? input.payload.idempotency_key
    : undefined;
  const consumed = consumedGovernanceTokens.get(replayKey);
  if (consumed) {
    const exactRetry = consumed.caller === input.authenticatedCaller
      && consumed.payloadHash === expectedPayloadHash
      && consumed.idempotencyKey === idempotencyKey;
    if (!exactRetry) return reject('governance_context replay was attempted for a different mutation.');
    return { ok: true, claims, replay: true };
  }
  consumedGovernanceTokens.set(replayKey, {
    caller: input.authenticatedCaller,
    payloadHash: expectedPayloadHash,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  return { ok: true, claims, replay: false };
}

/**
 * Run the security-meaningful steps of the JWS-profile seller verification
 * checklist. Short-circuits on first failure with the spec's normative error
 * code. Revocation is evaluated immediately after signature verification —
 * BEFORE freshness — so a revoked kid is rejected even if the token has also
 * expired (revocation is a stronger signal than freshness; exp must never
 * pre-empt it).
 */
export async function verifyGovernanceToken(token: string): Promise<ChecklistResult> {
  // The aud reference is ALWAYS this seller's own canonical URL — never a
  // caller-supplied value. Letting a caller pass the expected aud would make
  // the security check caller-controlled (the attacker moving the goalposts);
  // confused-deputy is demonstrated by minting a wrong-aud token instead.
  const now = Math.floor(Date.now() / 1000);
  const SKEW = 60;
  const steps: ChecklistStep[] = [];
  const reject = (code: string): ChecklistResult => ({ verdict: 'rejected', steps, error_code: code });
  const pass = (step: number, name: string, detail: string) => { steps.push({ step, name, pass: true, detail }); };
  const fail = (step: number, name: string, detail: string) => { steps.push({ step, name, pass: false, detail }); };

  // 1. Parse compact JWS.
  const parts = token.split('.');
  if (parts.length !== 3) { fail(1, 'parse', 'not a 3-part compact JWS'); return reject('governance_token_invalid'); }
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { fail(1, 'parse', 'header/payload not valid base64url JSON'); return reject('governance_token_invalid'); }
  pass(1, 'parse', 'compact JWS decoded');

  // 2. alg allowlist (no none/downgrade). Spec allows {EdDSA, ES256}.
  if (header.alg !== 'EdDSA' && header.alg !== 'ES256') { fail(2, 'alg_allowlist', `alg=${String(header.alg)} not in {EdDSA, ES256}`); return reject('governance_token_invalid'); }
  pass(2, 'alg_allowlist', `alg=${header.alg}`);

  // 3. typ exact match (no normalization).
  if (header.typ !== 'adcp-gov+jws') { fail(3, 'typ_match', `typ=${String(header.typ)} != adcp-gov+jws`); return reject('governance_token_invalid'); }
  pass(3, 'typ_match', 'typ=adcp-gov+jws');

  // 4. crit — authorization-changing claims require matching protected
  // markers so an older verifier fails closed.
  const criticalNames = Array.isArray(header.crit) ? header.crit : [];
  const recognizedCritical = ['authorized_commitment', 'authorized_task', 'authorized_payload_hash'];
  const unknownCritical = criticalNames.filter(name => !recognizedCritical.includes(String(name)));
  if (unknownCritical.length > 0) { fail(4, 'crit', `unrecognized crit header(s): ${unknownCritical.join(', ')}`); return reject('governance_token_invalid'); }
  for (const name of recognizedCritical) {
    const hasClaim = claims[name] !== undefined;
    const isProtected = criticalNames.includes(name) && header[name] === true;
    if (hasClaim !== isProtected) {
      fail(4, 'crit', `${name} claim and critical protected-header marker must appear together`);
      return reject('governance_token_invalid');
    }
  }
  if ((claims.authorized_task === undefined) !== (claims.authorized_payload_hash === undefined)) {
    fail(4, 'crit', 'authorized_task and authorized_payload_hash must appear together');
    return reject('governance_token_invalid');
  }
  pass(4, 'crit', criticalNames.length > 0
    ? `authorization extensions recognized and critical: ${criticalNames.join(', ')}`
    : 'no unrecognized critical headers');

  // 5. Resolve iss -> JWKS -> kid. iss must be the canonical governance issuer; kid must be published.
  if (claims.iss !== CANONICAL_GOV_ISS) { fail(5, 'iss_resolve', `iss=${String(claims.iss)} is not the expected governance issuer`); return reject('governance_token_invalid'); }
  const kid = typeof header.kid === 'string' ? header.kid : '';
  const jwk = resolveJwk(kid);
  if (!jwk) { fail(5, 'iss_resolve', `kid ${kid || '(none)'} not found in the issuer JWKS`); return reject('governance_key_unknown'); }
  pass(5, 'iss_resolve', `iss ${CANONICAL_GOV_ISS} resolved; kid ${kid} present in JWKS`);

  // 6. JWK use — the resolved key must be a governance signing/verify key.
  if (jwk.adcp_use !== 'governance-signing' || (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes('verify'))) {
    fail(6, 'key_use', 'resolved JWK is not a governance verify key'); return reject('governance_key_unknown');
  }
  pass(6, 'key_use', 'JWK adcp_use=governance-signing, key_ops includes verify');

  // 7. Cryptographic signature verification against the resolved key.
  try {
    const key = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, 'EdDSA');
    await compactVerify(token, key, {
      crit: {
        authorized_commitment: true,
        authorized_task: true,
        authorized_payload_hash: true,
      },
    });
    pass(7, 'signature', 'signature valid for resolved key');
  } catch {
    fail(7, 'signature', 'signature verification failed (tampered token or wrong key)');
    return reject('governance_token_invalid');
  }

  // 14. Revocation — runs here (after signature, before freshness) so a revoked
  // kid is rejected regardless of exp. A valid signature on a revoked kid is
  // still rejected.
  if (revokedGovernanceKids().includes(kid)) { fail(14, 'revocation', `kid ${kid} is in the revocation list`); return reject('governance_token_revoked'); }
  pass(14, 'revocation', `kid ${kid} not revoked`);

  // 8. aud byte-match against the seller's OWN canonical URL (confused-deputy defense).
  if (claims.aud !== CANONICAL_SELLER_AUD) { fail(8, 'aud_binding', `aud=${String(claims.aud)} != this seller's ${CANONICAL_SELLER_AUD}`); return reject('governance_token_not_applicable'); }
  pass(8, 'aud_binding', `aud byte-matches ${CANONICAL_SELLER_AUD}`);

  // 10. sub binding — an issuer-generated opaque governed-action identifier.
  // Services retain it for lifecycle continuity but never compare it to plan_id.
  if (typeof claims.sub !== 'string' || !claims.sub) { fail(10, 'sub_binding', 'opaque action binding is missing'); return reject('governance_token_not_applicable'); }
  pass(10, 'sub_binding', `opaque action binding present (${claims.sub})`);

  // 11. phase present.
  if (typeof claims.phase !== 'string' || !claims.phase) { fail(11, 'phase_binding', 'phase claim missing'); return reject('governance_token_not_applicable'); }
  pass(11, 'phase_binding', `phase=${claims.phase}`);

  // 9. Freshness (±60s skew): a governance token MUST carry exp; iat must not be ahead of now.
  if (typeof claims.exp !== 'number') { fail(9, 'freshness', 'no exp claim — governance tokens must expire'); return reject('governance_token_invalid'); }
  if (claims.exp < now - SKEW) { fail(9, 'freshness', `exp ${claims.exp} is in the past`); return reject('governance_token_expired'); }
  if (typeof claims.iat === 'number' && claims.iat > now + SKEW) { fail(9, 'freshness', `iat ${claims.iat} is in the future`); return reject('governance_token_invalid'); }
  pass(9, 'freshness', 'exp in the future and iat not ahead (±60s skew)');

  // 15. jti present — the replay-dedup key (stateful dedup itself is out of scope here).
  if (typeof claims.jti !== 'string' || !claims.jti) { fail(15, 'jti_present', 'jti claim missing (no replay-dedup key)'); return reject('governance_token_invalid'); }
  pass(15, 'jti_present', `jti=${claims.jti}`);

  return { verdict: 'valid', steps, error_code: null };
}
