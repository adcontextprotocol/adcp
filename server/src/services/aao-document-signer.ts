/**
 * AAO Document Signer — JWS envelope for AAO-hosted adagents.json documents.
 *
 * When AAO hosts a publisher's adagents.json (`aao.scope3.com/publisher/
 * {domain}/.well-known/adagents.json`), the TLS chain ends at AAO rather
 * than the publisher. Strict buy-side verifiers (TTD/DV360 verification,
 * IAB compliance scans) treat that as a soft trust signal because
 * adagents.json's value proposition rests on "the publisher's own
 * DNS+TLS attests this list."
 *
 * This signer adds a second attestation channel: AAO signs the document
 * body with a published key. The signed envelope is embedded in the
 * served document as `_aao_envelope.jws`. A verifier with AAO's JWKS can
 * confirm provenance independently of the TLS chain.
 *
 * Key separation: AdCP receivers enforce key purpose at the JWK
 * `adcp_use` field (per docs/guides/SIGNING-GUIDE.md § Key separation).
 * This service publishes an `adcp_use='aao-document-signing'` key,
 * distinct from request-signing / webhook-signing / aao-verification.
 *
 * Envelope shape (verifier recipe):
 *   1. Decode envelope.jws (compact JWT). The JWT payload IS the
 *      canonical adagents.json document body.
 *   2. Verify the JWT signature against the JWKS published at
 *      `/.well-known/jwks.json` with `kid` from the protected header
 *      and `adcp_use='aao-document-signing'`.
 *   3. Validate claims: `iss=https://aao.org`, `aud=aao-hosted-adagents`,
 *      `sub` matches the publisher_domain in the URL path, `exp` not
 *      passed, `iat` not in the future.
 *   4. Trust the JWT payload as the canonical document.
 *
 * Disabled when the env keys are unset — the route falls back to
 * serving the unsigned document (existing behaviour). This keeps dev
 * boots working without the secret material.
 */

import * as jose from 'jose';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';

const logger = createLogger('aao-document-signer');

const ISSUER = 'https://aao.org';
const AUDIENCE = 'aao-hosted-adagents';
const ALG = 'EdDSA';
const KID = 'aao-document-1';
const ADCP_USE = 'aao-document-signing';
/** Documents are short-lived to bound replay risk on a stale signature. */
const ENVELOPE_LIFETIME_SECONDS = 7 * 24 * 60 * 60; // 7 days

let signingKey: jose.CryptoKey | undefined;
let verifyingKey: jose.CryptoKey | undefined;
let publicJwk: jose.JWK | undefined;
let initAttempted = false;
let initInFlight: Promise<boolean> | null = null;

export interface AaoDocumentEnvelope {
  jws: string;
  key_id: string;
  issued_at: string;
  expires_at: string;
  publisher_domain: string;
  verification: string;
}

/**
 * Initialize keys from environment. Call once at server startup.
 *
 * Expects AAO_DOCUMENT_SIGNING_PRIVATE_KEY (base64-encoded PKCS8 PEM,
 * Ed25519) and AAO_DOCUMENT_SIGNING_PUBLIC_KEY (base64-encoded SPKI PEM).
 * If unset, signing is disabled and the hosted route serves the
 * unsigned document.
 *
 * Returns true if keys initialized successfully, false otherwise.
 */
export async function initAaoDocumentSigningKey(): Promise<boolean> {
  if (initInFlight) return initInFlight;
  if (initAttempted) return !!signingKey;
  initInFlight = doInit();
  const result = await initInFlight;
  initInFlight = null;
  initAttempted = true;
  return result;
}

async function doInit(): Promise<boolean> {
  const privateKeyB64 = process.env.AAO_DOCUMENT_SIGNING_PRIVATE_KEY;
  const publicKeyB64 = process.env.AAO_DOCUMENT_SIGNING_PUBLIC_KEY;

  if (!privateKeyB64 || !publicKeyB64) {
    logger.info('AAO document signing keys not configured — hosted documents will be served unsigned');
    return false;
  }

  try {
    const privatePem = Buffer.from(privateKeyB64, 'base64').toString('utf8');
    const publicPem = Buffer.from(publicKeyB64, 'base64').toString('utf8');
    signingKey = await jose.importPKCS8(privatePem, ALG);
    verifyingKey = await jose.importSPKI(publicPem, ALG);
    publicJwk = await jose.exportJWK(verifyingKey);
    publicJwk.alg = ALG;
    publicJwk.use = 'sig';
    publicJwk.kid = KID;
    (publicJwk as jose.JWK & { adcp_use: string }).adcp_use = ADCP_USE;
    logger.info({ kid: KID, adcp_use: ADCP_USE }, 'AAO document signing key initialized');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to initialize AAO document signing key');
    return false;
  }
}

/**
 * Sign an adagents.json document body for a given publisher_domain.
 * Returns the full envelope object to embed in the served document, or
 * null when signing is disabled.
 *
 * The JWT payload is the document body itself — verifiers decode the
 * JWT and use that payload as canonical, avoiding any JSON-canonicalization
 * fragility around the outer wrapper.
 */
export async function signHostedAdagentsDocument(
  body: Record<string, unknown>,
  publisherDomain: string,
): Promise<AaoDocumentEnvelope | null> {
  // Lazy init on first call. Idempotent — concurrent first-callers share
  // a single init promise. Subsequent calls return immediately.
  if (!signingKey && !initAttempted) await initAaoDocumentSigningKey();
  if (!signingKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ENVELOPE_LIFETIME_SECONDS;

  const jws = await new jose.SignJWT(body as jose.JWTPayload)
    .setProtectedHeader({ alg: ALG, kid: KID, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setSubject(publisherDomain)
    .setAudience(AUDIENCE)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(signingKey);

  return {
    jws,
    key_id: KID,
    issued_at: new Date(now * 1000).toISOString(),
    expires_at: new Date(exp * 1000).toISOString(),
    publisher_domain: publisherDomain,
    verification:
      `Decode envelope.jws (compact JWT) — its payload is the canonical document. ` +
      `Verify the signature against /.well-known/jwks.json (kid=${KID}, adcp_use=${ADCP_USE}). ` +
      `Confirm iss=${ISSUER}, aud=${AUDIENCE}, sub matches the publisher_domain in the request URL.`,
  };
}

/**
 * Verify an envelope's JWS and return the canonical payload, or null on
 * any failure (signature, claims, expiry). Exposed for tests and for
 * future origin-verification flows that need to confirm a hosted
 * document came from us.
 */
export async function verifyHostedAdagentsDocument(
  jws: string,
  expectedPublisherDomain: string,
): Promise<Record<string, unknown> | null> {
  if (!verifyingKey) return null;
  try {
    const { payload } = await jose.jwtVerify(jws, verifyingKey, {
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: expectedPublisherDomain,
    });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Returns the public JWK for the document-signing key, or null when not
 * initialized. Consumed by the JWKS publication path so the canonical
 * `/.well-known/jwks.json` advertises the key alongside the request- and
 * webhook-signing keys.
 */
export function getDocumentSigningJwk(): jose.JWK | null {
  return publicJwk ?? null;
}

export function isAaoDocumentSigningEnabled(): boolean {
  return !!signingKey;
}

/** @internal Reset module state for testing. */
export function _resetForTesting(): void {
  signingKey = undefined;
  verifyingKey = undefined;
  publicJwk = undefined;
  initAttempted = false;
  initInFlight = null;
}
