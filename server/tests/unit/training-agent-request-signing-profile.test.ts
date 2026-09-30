/**
 * Route-pinned request-signing profiles on the training agent's strict routes.
 *
 * The AdCP 3.2 request-signing profile parses `Signature` / `Content-Digest`
 * strictly as RFC 8941 Base64; the 3.0/3.1 legacy profile uses unpadded
 * Base64URL. The verifier's profile comes from the trusted route, never from
 * the request, so `/mcp-strict-required` (the only strict route that
 * advertises 3.2) pins 3.2 and legacy signers use `/mcp-strict-required-legacy`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { signRequest } from '@adcp/sdk/signing';
import type { AdcpJsonWebKey, SfBinaryEncoding } from '@adcp/sdk/signing';
import type { Authenticator } from '@adcp/sdk/server';
import { getComplianceCacheDir } from '@adcp/sdk/testing';
import {
  buildStrictRequestSigningAuthenticator,
  buildStrictRequiredRequestSigningAuthenticator,
  buildStrictRequiredLegacyRequestSigningAuthenticator,
  buildStrictForbiddenRequestSigningAuthenticator,
  requestSigningProfileVersion,
} from '../../src/training-agent/request-signing.js';

const VECTORS_DIR = join(getComplianceCacheDir(), 'test-vectors', 'request-signing');

interface Vector {
  request: { method: string; url: string; headers: Record<string, string>; body: string };
}

function loadVector(relativePath: string): Vector {
  return JSON.parse(readFileSync(join(VECTORS_DIR, relativePath), 'utf-8')) as Vector;
}

function signerKey(kid: string) {
  const { keys } = JSON.parse(readFileSync(join(VECTORS_DIR, 'keys.json'), 'utf-8')) as {
    keys: Array<AdcpJsonWebKey & { _private_d_for_test_only?: string }>;
  };
  const key = keys.find(k => k.kid === kid);
  if (!key?._private_d_for_test_only) throw new Error(`test key ${kid} missing`);
  const { _private_d_for_test_only: d, ...publicJwk } = key;
  return { keyid: kid, alg: 'ed25519' as const, privateKey: { ...publicJwk, d } as AdcpJsonWebKey };
}

/** Shape an IncomingMessage-like request the way the Express router hands it
 *  to the authenticator (`rawBody` buffered, `originalUrl` carrying the path). */
function toAuthRequest(url: string, method: string, headers: Record<string, string>, body: string) {
  const parsed = new URL(url);
  const lowered: Record<string, string> = {
    host: parsed.host,
    'x-forwarded-proto': parsed.protocol.replace(/:$/, ''),
  };
  for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value;
  return {
    method,
    url: parsed.pathname,
    originalUrl: parsed.pathname,
    headers: lowered,
    rawBody: body,
  } as unknown as Parameters<Authenticator>[0];
}

function signedCreateMediaBuy(path: string, binaryEncoding: SfBinaryEncoding) {
  const url = `https://training.example.com/api/training-agent/sales${path}`;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'tools/call',
    params: { name: 'create_media_buy', arguments: { plan_id: 'plan_001' } },
  });
  const headers = { 'Content-Type': 'application/json' };
  const signed = signRequest(
    { method: 'POST', url, headers, body },
    signerKey('test-ed25519-2026'),
    { binaryEncoding, coverContentDigest: true },
  );
  return toAuthRequest(url, 'POST', { ...headers, ...signed.headers }, body);
}

async function rejectionCode(auth: Authenticator, req: Parameters<Authenticator>[0]): Promise<string | undefined> {
  try {
    await auth(req);
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string } }).cause?.code;
  }
}

describe('requestSigningProfileVersion', () => {
  it('pins only the 3.2-advertising required-digest route to the 3.2 profile', () => {
    expect(requestSigningProfileVersion({})).toBeUndefined();
    expect(requestSigningProfileVersion({ strict: true })).toBe('3.1');
    expect(requestSigningProfileVersion({ strict: true, digestMode: 'either' })).toBe('3.1');
    expect(requestSigningProfileVersion({ strict: true, digestMode: 'forbidden' })).toBe('3.1');
    expect(requestSigningProfileVersion({ strict: true, digestMode: 'required' })).toBe('3.2');
    expect(requestSigningProfileVersion({ strict: true, digestMode: 'required', legacySigningProfile: true })).toBe('3.1');
  });
});

describe('strict-route request-signing profiles', () => {
  it('/mcp-strict-required rejects Base64URL sf-binary at step 1 (profile-3.2/negative/001)', async () => {
    const vector = loadVector('profile-3.2/negative/001-base64url-sf-binary.json');
    const { method, url, headers, body } = vector.request;
    const req = toAuthRequest(url, method, headers, body);

    // The vector's `created` is in the past, so a verifier that parsed the
    // legacy token would fail later at the window check instead.
    expect(await rejectionCode(buildStrictRequiredRequestSigningAuthenticator(), req))
      .toBe('request_signature_header_malformed');
    expect(await rejectionCode(buildStrictRequiredLegacyRequestSigningAuthenticator(), req))
      .toBe('request_signature_window_invalid');
  });

  it('/mcp-strict-required accepts a live RFC 8941 Base64 signature and rejects a legacy one', async () => {
    const auth = buildStrictRequiredRequestSigningAuthenticator();
    await expect(auth(signedCreateMediaBuy('/mcp-strict-required', 'rfc8941-base64')))
      .resolves.toMatchObject({ principal: expect.stringContaining('test-ed25519-2026') });
    expect(await rejectionCode(auth, signedCreateMediaBuy('/mcp-strict-required', 'legacy-base64url')))
      .toBe('request_signature_header_malformed');
  });

  it('/mcp-strict-required-legacy verifies 3.0/3.1 Base64URL signatures under the required-digest policy', async () => {
    const auth = buildStrictRequiredLegacyRequestSigningAuthenticator();
    await expect(auth(signedCreateMediaBuy('/mcp-strict-required-legacy', 'legacy-base64url')))
      .resolves.toMatchObject({ principal: expect.stringContaining('test-ed25519-2026') });
    expect(await rejectionCode(auth, signedCreateMediaBuy('/mcp-strict-required-legacy', 'rfc8941-base64')))
      .toBe('request_signature_header_malformed');
  });

  it('keeps the either and forbidden routes on the legacy profile', async () => {
    const either = buildStrictRequestSigningAuthenticator();
    await expect(either(signedCreateMediaBuy('/mcp-strict', 'legacy-base64url')))
      .resolves.toMatchObject({ principal: expect.stringContaining('test-ed25519-2026') });

    const forbidden = buildStrictForbiddenRequestSigningAuthenticator();
    const url = 'https://training.example.com/api/training-agent/sales/mcp-strict-forbidden';
    const body = JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'create_media_buy', arguments: {} } });
    const headers = { 'Content-Type': 'application/json' };
    const signed = signRequest(
      { method: 'POST', url, headers, body },
      signerKey('test-ed25519-2026'),
      { binaryEncoding: 'legacy-base64url', coverContentDigest: false },
    );
    await expect(forbidden(toAuthRequest(url, 'POST', { ...headers, ...signed.headers }, body)))
      .resolves.toMatchObject({ principal: expect.stringContaining('test-ed25519-2026') });
  });
});
