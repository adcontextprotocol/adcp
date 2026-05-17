/**
 * Signed governance-revocations.json — issuance & round-trip.
 *
 * Verifies the training agent produces a JWS flattened-JSON revocation list
 * signed under the same kid published on the aggregated brand.json JWKS,
 * with a 15-minute `next_update` window per the spec ceiling for issuers
 * serving execution-phase tokens.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { flattenedVerify, importJWK, type JWK } from 'jose';
import {
  buildSignedRevocationList,
  resetRevocationListCache,
} from '../../src/training-agent/governance-revocations.js';
import {
  getGovernanceSigningPublicJwk,
  resetGovernanceSigning,
} from '../../src/training-agent/governance-signing.js';

const ISSUER = 'https://test-agent.adcontextprotocol.org/governance';

describe('signed governance revocation list', () => {
  beforeEach(() => {
    resetGovernanceSigning();
    resetRevocationListCache();
  });

  it('verifies under the published JWKS', async () => {
    const list = await buildSignedRevocationList(ISSUER);
    const publicJwk = getGovernanceSigningPublicJwk() as unknown as JWK;
    const key = await importJWK(publicJwk, 'EdDSA');

    const { payload, protectedHeader } = await flattenedVerify(list, key);

    expect(protectedHeader.alg).toBe('EdDSA');
    expect(protectedHeader.typ).toBe('adcp-gov-revocation+jws');
    expect(protectedHeader.kid).toBe(getGovernanceSigningPublicJwk().kid);

    const body = JSON.parse(new TextDecoder().decode(payload));
    expect(body.version).toBe(1);
    expect(body.issuer).toBe(ISSUER);
    expect(body.revoked_jtis).toEqual([]);
    expect(body.revoked_kids).toEqual([]);
  });

  it('declares a next_update 15 minutes after updated', async () => {
    const list = await buildSignedRevocationList(ISSUER);
    const key = await importJWK(getGovernanceSigningPublicJwk() as unknown as JWK, 'EdDSA');
    const { payload } = await flattenedVerify(list, key);
    const body = JSON.parse(new TextDecoder().decode(payload));

    const updated = new Date(body.updated).getTime();
    const nextUpdate = new Date(body.next_update).getTime();
    expect(nextUpdate - updated).toBe(15 * 60 * 1000);
  });

  it('memoizes per issuer — repeat calls within 60s return the same signature', async () => {
    const a = await buildSignedRevocationList(ISSUER);
    const b = await buildSignedRevocationList(ISSUER);
    expect(b.signature).toBe(a.signature);
    expect(b.payload).toBe(a.payload);
  });

  it('issuer prevents cache substitution across origins', async () => {
    const a = await buildSignedRevocationList('https://a.example/governance');
    const b = await buildSignedRevocationList('https://b.example/governance');

    const key = await importJWK(getGovernanceSigningPublicJwk() as unknown as JWK, 'EdDSA');
    const aBody = JSON.parse(new TextDecoder().decode((await flattenedVerify(a, key)).payload));
    const bBody = JSON.parse(new TextDecoder().decode((await flattenedVerify(b, key)).payload));

    expect(aBody.issuer).toBe('https://a.example/governance');
    expect(bBody.issuer).toBe('https://b.example/governance');
    expect(a.signature).not.toBe(b.signature);
  });
});
