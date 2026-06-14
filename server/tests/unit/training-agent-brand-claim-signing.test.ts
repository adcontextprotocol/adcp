/**
 * verify_brand_claim / verify_brand_claims signed-response tests.
 *
 * The brand response-signing key must be published on the aggregated JWKS
 * under a distinct `adcp_use: response-signing` and kid (no cross-purpose
 * reuse), and each verify_brand_claim* answer must carry a payload-envelope
 * JWS that verifies against that key per
 * static/schemas/source/core/response-payload-jws-envelope.json.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  getBrandResponseSigningPublicJwk,
  resetBrandResponseSigning,
} from '../../src/training-agent/brand-response-signing.js';
import {
  getAggregatedPublicJwks,
  getTenantSigningMaterial,
  resetTenantSigning,
} from '../../src/training-agent/tenants/signing.js';
import {
  verifyBrandClaimHandler,
  verifyBrandClaimsHandler,
} from '../../src/training-agent/brand-claim-handlers.js';
import type { TrainingContext, ToolArgs } from '../../src/training-agent/types.js';

const AGENT_URL = 'https://test-agent.adcontextprotocol.org/brand/mcp';
const CTX: TrainingContext = { mode: 'open' };

interface SignedResponse {
  protected: string;
  payload: Record<string, unknown>;
  signature: string;
}

/** Verify the payload-envelope JWS the way a spec-conformant consumer would. */
function verifyEnvelope(signed: SignedResponse, expect_: { task: string; brand_domain: string }): { ok: boolean; reason?: string } {
  const header = JSON.parse(Buffer.from(signed.protected, 'base64url').toString('utf8'));
  if (header.typ !== 'adcp-response-payload+jws') return { ok: false, reason: 'header.typ' };
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'header.alg' };
  if ('b64' in header) return { ok: false, reason: 'header has forbidden b64' };

  // Resolve kid → JWK on the published JWKS and enforce key purpose.
  const jwks = getAggregatedPublicJwks();
  const jwk = jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'kid not in JWKS' };
  if (jwk.adcp_use !== 'response-signing') return { ok: false, reason: 'wrong adcp_use' };

  const p = signed.payload;
  if (p.typ !== 'adcp-response-payload+jws') return { ok: false, reason: 'payload.typ' };
  if (p.task !== expect_.task) return { ok: false, reason: 'payload.task' };
  if (p.brand_domain !== expect_.brand_domain) return { ok: false, reason: 'payload.brand_domain' };
  if (typeof p.request_hash !== 'string' || !/^sha256:[A-Za-z0-9_-]{43}$/.test(p.request_hash)) return { ok: false, reason: 'request_hash' };
  if (typeof p.iat !== 'number' || typeof p.exp !== 'number' || p.exp <= p.iat) return { ok: false, reason: 'iat/exp' };

  const payloadB64 = Buffer.from(canonicalize(p) ?? 'null').toString('base64url');
  const signingInput = `${signed.protected}.${payloadB64}`;
  const pub = createPublicKey({ key: jwk as object, format: 'jwk' });
  const ok = cryptoVerify(null, Buffer.from(signingInput, 'utf8'), pub, Buffer.from(signed.signature, 'base64url'));
  return ok ? { ok: true } : { ok: false, reason: 'signature' };
}

const verifyClaim = verifyBrandClaimHandler(AGENT_URL);
const verifyClaims = verifyBrandClaimsHandler(AGENT_URL);
function call(args: Record<string, unknown>): Record<string, unknown> {
  return verifyClaim(args as ToolArgs, CTX) as Record<string, unknown>;
}

describe('brand response-signing JWK publication', () => {
  beforeEach(() => {
    resetBrandResponseSigning();
    resetTenantSigning();
  });

  it('publishes a response-signing JWK with the required wire-shape', () => {
    const jwk = getBrandResponseSigningPublicJwk();
    expect(jwk.kty).toBe('OKP');
    expect(jwk.crv).toBe('Ed25519');
    expect(jwk.alg).toBe('EdDSA');
    expect(jwk.adcp_use).toBe('response-signing');
    expect(jwk.use).toBe('sig');
    expect(jwk.key_ops).toEqual(['verify']);
    expect(jwk.kid).toMatch(/^training-brand-resp-/);
    expect(jwk).not.toHaveProperty('d');
  });

  it('aggregated JWKS includes the response-signing key with a distinct kid', () => {
    getTenantSigningMaterial('brand');
    getTenantSigningMaterial('governance');
    const aggregated = getAggregatedPublicJwks();
    const respKeys = aggregated.keys.filter(k => k.adcp_use === 'response-signing');
    expect(respKeys).toHaveLength(1);
    expect(respKeys[0].kid).toBe(getBrandResponseSigningPublicJwk().kid);

    const otherKids = aggregated.keys.filter(k => k.adcp_use !== 'response-signing').map(k => k.kid);
    expect(otherKids).not.toContain(getBrandResponseSigningPublicJwk().kid);
  });
});

describe('verify_brand_claim signed responses', () => {
  beforeEach(() => {
    resetBrandResponseSigning();
    resetTenantSigning();
  });

  it('subsidiary → owned, envelope verifies, unsigned body matches payload.response', () => {
    const r = call({ claim_type: 'subsidiary', claim: { subsidiary_domain: 'streamhaus.example' } });
    expect(r.verification_status).toBe('owned');
    expect((r.details as Record<string, unknown>).brand_id).toBe('streamhaus');
    const v = verifyEnvelope(r.signed_response as SignedResponse, { task: 'verify_brand_claim', brand_domain: 'sportshaus-holdings.example' });
    expect(v).toEqual({ ok: true });
    // Spec: unsigned task body (excluding signed_response) must equal
    // signed_response.payload.response — including the sandbox marker.
    const { signed_response, ...body } = r;
    void signed_response;
    expect((r.signed_response as SignedResponse).payload.response).toEqual(body);
    expect(((r.signed_response as SignedResponse).payload.response as Record<string, unknown>).sandbox).toBe(true);
  });

  it('parent → owned (mutual assertion completes), envelope verifies', () => {
    const r = call({ claim_type: 'parent', claim: { parent_domain: 'sportshaus-holdings.example' } });
    expect(r.verification_status).toBe('owned');
    expect(verifyEnvelope(r.signed_response as SignedResponse, { task: 'verify_brand_claim', brand_domain: 'streamhaus.example' }).ok).toBe(true);
  });

  it('authorized property → owned with use_case_authorization (authorized-tier field)', () => {
    const pub = call({ claim_type: 'property', claim: { property: { type: 'ctv_app', identifier: 'streamhaus.example' } } });
    expect((pub.details as Record<string, unknown>).use_case_authorization).toBeUndefined();
    const authd = call({ claim_type: 'property', claim: { property: { type: 'ctv_app', identifier: 'streamhaus.example' } }, authorized: true });
    expect((authd.details as Record<string, unknown>).use_case_authorization).toBeDefined();
  });

  it('rejection (not_ours / disputed) is authoritative and still signed', () => {
    const notOurs = call({ claim_type: 'property', claim: { property: { type: 'website', identifier: 'fake-streamhaus.example' } } });
    expect(notOurs.verification_status).toBe('not_ours');
    expect(verifyEnvelope(notOurs.signed_response as SignedResponse, { task: 'verify_brand_claim', brand_domain: 'streamhaus.example' }).ok).toBe(true);
    const disputed = call({ claim_type: 'parent', claim: { parent_domain: 'nikeinc.example' } });
    expect(disputed.verification_status).toBe('disputed');
  });

  it('trademark disambiguates across registries and Nice classes', () => {
    const us = call({ claim_type: 'trademark', claim: { mark: 'STREAMHAUS', registry: 'USPTO' } });
    expect(us.verification_status).toBe('owned');
    expect((us.details as Record<string, unknown>).nice_classes).toEqual([38, 41]);
    const eu = call({ claim_type: 'trademark', claim: { mark: 'STREAMHAUS', registry: 'EUIPO' } });
    expect(eu.verification_status).toBe('licensed_in');
    expect((eu.details as Record<string, unknown>).licensor_domain).toBe('streamhaus-eu-licensor.example');
  });

  it('ambiguous trademark (no registry, multiple matches) → AMBIGUOUS_MATCH', () => {
    const amb = call({ claim_type: 'trademark', claim: { mark: 'STREAMHAUS' } }) as { errors?: Array<{ code: string }> };
    expect(amb.errors?.[0]?.code).toBe('AMBIGUOUS_MATCH');
  });

  it('missing required claim field → INVALID_INPUT; unknown type → UNSUPPORTED_CLAIM_TYPE', () => {
    const bad = call({ claim_type: 'subsidiary', claim: {} }) as { errors?: Array<{ code: string }> };
    expect(bad.errors?.[0]?.code).toBe('INVALID_INPUT');
    const unknown = call({ claim_type: 'merger', claim: {} }) as { errors?: Array<{ code: string }> };
    expect(unknown.errors?.[0]?.code).toBe('UNSUPPORTED_CLAIM_TYPE');
  });

  it('a tampered envelope payload fails verification', () => {
    const r = call({ claim_type: 'subsidiary', claim: { subsidiary_domain: 'streamhaus.example' } });
    const tampered = JSON.parse(JSON.stringify(r.signed_response)) as SignedResponse;
    (tampered.payload.response as Record<string, unknown>).verification_status = 'tampered';
    expect(verifyEnvelope(tampered, { task: 'verify_brand_claim', brand_domain: 'sportshaus-holdings.example' }).ok).toBe(false);
  });

  it('verify_brand_claims returns one signed batch over results[]', () => {
    const r = verifyClaims({
      claims: [
        { claim_type: 'subsidiary', claim: { subsidiary_domain: 'streamhaus.example' } },
        { claim_type: 'subsidiary', claim: { subsidiary_domain: 'unaffiliated.example' } },
      ],
    } as ToolArgs, CTX) as { results: unknown[]; signed_response: SignedResponse };
    expect(r.results).toHaveLength(2);
    expect(verifyEnvelope(r.signed_response, { task: 'verify_brand_claims', brand_domain: 'sportshaus-holdings.example' }).ok).toBe(true);
  });

  // The bulk result_entry shape differs from the single-target response:
  // verify-brand-claims-response.json's success arm requires `status` (not
  // verification_status) and its error arm forbids `status`/`claim_type`.
  it('verify_brand_claims per-result entries match the bulk schema arms', () => {
    const r = verifyClaims({
      claims: [
        { claim_type: 'subsidiary', claim: { subsidiary_domain: 'streamhaus.example' } }, // success
        { claim_type: 'subsidiary', claim: {} },                                          // INVALID_INPUT → error arm
      ],
    } as ToolArgs, CTX) as { results: Array<Record<string, unknown>> };

    const success = r.results[0];
    expect(success.status).toBe('owned');                  // success arm requires `status`
    expect(success).not.toHaveProperty('verification_status'); // single-target-only field
    expect(success.claim_type).toBe('subsidiary');         // success arm requires `claim_type`

    const failure = r.results[1];
    expect(failure).toHaveProperty('error');               // error arm requires `error`
    expect(failure).not.toHaveProperty('claim_type');      // error arm forbids `claim_type`
    expect(failure).not.toHaveProperty('status');          // error arm forbids `status`
  });
});
