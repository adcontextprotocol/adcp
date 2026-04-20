/**
 * Unit tests for the RFC 9421 AdCP webhook-signature verifier.
 *
 * We sign fresh requests at test-time using the fixture keypairs so the
 * `created`/`expires` timestamps are current.
 *
 * All vectors exercise the webhook error taxonomy from
 * docs/building/implementation/webhooks.mdx.
 */

import {
  createHash,
  createPrivateKey,
  sign as cryptoSign,
} from 'node:crypto';
import { describe, it, expect } from 'vitest';

import {
  verifyWebhookSignature,
  type JWKS,
  type WebhookRequest,
} from '../../src/adcp-security/webhook-verifier.js';
import {
  TEST_ED25519_PRIVATE_JWK,
  TEST_ES256_PRIVATE_JWK,
  TEST_JWKS,
} from '../../src/adcp-security/__fixtures__/webhook-signature-keys.js';

type SigningKey = typeof TEST_ED25519_PRIVATE_JWK | typeof TEST_ES256_PRIVATE_JWK;

/**
 * Convert a DER-encoded ECDSA signature (as produced by node:crypto) to the
 * fixed-width IEEE-P1363 r||s encoding required by RFC 9421.  Used only to
 * build test inputs for the ES256 happy path.
 */
function derToP1363(der: Buffer, halfLen: number): Buffer {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error('bad DER: not SEQUENCE');
  const seqLen = der[off++];
  if (seqLen !== der.length - 2) throw new Error('bad DER: seq length');
  const readInt = (): Buffer => {
    if (der[off++] !== 0x02) throw new Error('bad DER: not INTEGER');
    const len = der[off++];
    let buf = der.subarray(off, off + len);
    off += len;
    // Strip a leading zero used for DER sign-bit padding.
    if (buf[0] === 0x00 && buf.length > 1) buf = buf.subarray(1);
    if (buf.length > halfLen) throw new Error('bad DER: int too long');
    const out = Buffer.alloc(halfLen);
    buf.copy(out, halfLen - buf.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

interface BuildOptions {
  readonly method?: string;
  readonly url?: string;
  readonly body?: string;
  readonly withDigest?: boolean;
  readonly createdOffsetSeconds?: number;
  readonly expiresOffsetSeconds?: number;
  readonly keyid?: string;
  readonly alg?: string;
  readonly omitSignatureHeader?: boolean;
  readonly signingKey?: SigningKey;
  readonly omitTag?: boolean;
  /** Override the default `;created=...` compact separator for whitespace tests. */
  readonly paramSeparator?: string;
  /** Truncate or pad the final signature to this byte length. */
  readonly tamperSignatureToLength?: number;
}

function buildSignedRequest(options: BuildOptions): WebhookRequest {
  const method = options.method ?? 'POST';
  const url = options.url ?? 'https://buyer.example.com/webhooks/adcp/media-buy';
  const body = options.body ?? '{"status":"completed","task_id":"task_42"}';
  const withDigest = options.withDigest ?? true;
  const signingKey = options.signingKey ?? TEST_ED25519_PRIVATE_JWK;
  const keyid = options.keyid ?? signingKey.kid;
  const alg = options.alg ?? (signingKey.crv === 'Ed25519' ? 'ed25519' : 'ecdsa-p256-sha256');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const created = nowSeconds + (options.createdOffsetSeconds ?? -10);
  const expires = nowSeconds + (options.expiresOffsetSeconds ?? 120);
  const nonce = 'KXYnfEfJ0PBRZXQyVXfVQA';
  const tag = 'adcp/webhook-signing/v1';

  const authority = new URL(url).host;

  const digest = createHash('sha256').update(body, 'utf-8').digest('base64');
  const contentDigestHeader = `sha-256=:${digest}:`;

  const components = ['"@method"', '"@target-uri"', '"@authority"', '"content-type"'];
  if (withDigest) {
    components.push('"content-digest"');
  }
  const componentsList = `(${components.join(' ')})`;
  const sep = options.paramSeparator ?? ';';
  const tagPart = options.omitTag ? '' : `${sep}tag="${tag}"`;
  const paramsSerialized =
    `${sep}created=${created}${sep}expires=${expires}${sep}` +
    `nonce="${nonce}"${sep}keyid="${keyid}"${sep}alg="${alg}"${tagPart}`;
  const sigParamsValue = `${componentsList}${paramsSerialized}`;

  // Build signature base manually — matches RFC 9421 §2.3 canonical form.
  const lines: string[] = [
    `"@method": ${method}`,
    `"@target-uri": ${url}`,
    `"@authority": ${authority}`,
    `"content-type": application/json`,
  ];
  if (withDigest) {
    lines.push(`"content-digest": ${contentDigestHeader}`);
  }
  lines.push(`"@signature-params": ${sigParamsValue}`);
  const signatureBase = lines.join('\n');

  const privateKey = createPrivateKey({ key: signingKey, format: 'jwk' });
  let signature: Buffer;
  if (signingKey.crv === 'Ed25519') {
    signature = cryptoSign(null, Buffer.from(signatureBase, 'utf-8'), privateKey);
  } else {
    // node:crypto emits ECDSA as DER; RFC 9421 requires P1363 r||s.
    const der = cryptoSign('sha256', Buffer.from(signatureBase, 'utf-8'), privateKey);
    signature = derToP1363(der, 32);
  }
  if (options.tamperSignatureToLength !== undefined) {
    const target = options.tamperSignatureToLength;
    if (target <= signature.length) {
      signature = signature.subarray(0, target);
    } else {
      signature = Buffer.concat([signature, Buffer.alloc(target - signature.length)]);
    }
  }
  const signatureB64 = signature.toString('base64');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Signature-Input': `sig1=${sigParamsValue}`,
  };
  if (withDigest) {
    headers['Content-Digest'] = contentDigestHeader;
  }
  if (!options.omitSignatureHeader) {
    headers['Signature'] = `sig1=:${signatureB64}:`;
  }

  return { method, url, headers, body };
}

describe('verifyWebhookSignature', () => {
  const jwks: JWKS = TEST_JWKS;

  it('accepts a well-formed Ed25519 signature with content-digest', () => {
    const req = buildSignedRequest({ withDigest: true });
    const result = verifyWebhookSignature(req, jwks);
    expect(result).toEqual({
      valid: true,
      keyid: 'test-ed25519-2026',
      alg: 'ed25519',
      tag: 'adcp/webhook-signing/v1',
    });
  });

  it('accepts a well-formed ECDSA-P256-SHA256 signature (P1363→DER path)', () => {
    const req = buildSignedRequest({ signingKey: TEST_ES256_PRIVATE_JWK });
    const result = verifyWebhookSignature(req, jwks);
    expect(result).toEqual({
      valid: true,
      keyid: 'test-es256-2026',
      alg: 'ecdsa-p256-sha256',
      tag: 'adcp/webhook-signing/v1',
    });
  });

  it('omits `tag` from VerifyResult when signer did not include it', () => {
    const req = buildSignedRequest({ omitTag: true });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result).not.toHaveProperty('tag');
    }
  });

  it('accepts a signature with compact (no-space) parameter separators', () => {
    // Sanity: our canonical test fixture already uses `;param` (no leading
    // space), but an interop spec-abiding signer could emit either. Pin this.
    const req = buildSignedRequest({ paramSeparator: ';' });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(true);
  });

  it('accepts a well-formed signature without content-digest when not required', () => {
    const req = buildSignedRequest({ withDigest: false });
    const result = verifyWebhookSignature(req, jwks, { requireContentDigest: false });
    expect(result.valid).toBe(true);
  });

  it('rejects with webhook_signature_required when Signature header is missing', () => {
    const req = buildSignedRequest({ omitSignatureHeader: true });
    const result = verifyWebhookSignature(req, jwks);
    expect(result).toEqual({ valid: false, reason: 'webhook_signature_required' });
  });

  it('rejects with webhook_signature_required when both signature headers are absent', () => {
    const req = buildSignedRequest({});
    const stripped: WebhookRequest = {
      method: req.method,
      url: req.url,
      body: req.body,
      headers: { 'Content-Type': 'application/json' },
    };
    const result = verifyWebhookSignature(stripped, jwks);
    expect(result).toEqual({ valid: false, reason: 'webhook_signature_required' });
  });

  it('rejects with webhook_signature_key_unknown when keyid is not in the JWKS', () => {
    const req = buildSignedRequest({ keyid: 'not-a-real-kid' });
    const result = verifyWebhookSignature(req, jwks);
    expect(result).toEqual({ valid: false, reason: 'webhook_signature_key_unknown' });
  });

  it('rejects with webhook_signature_expired when expires is past skew window', () => {
    // Valid 2-minute window, but it expired 5 minutes ago — past the default
    // 60-second skew tolerance.  Distinct from the >5-minute spec violation.
    const req = buildSignedRequest({
      createdOffsetSeconds: -420,
      expiresOffsetSeconds: -300,
    });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_signature_expired');
  });

  it('rejects with webhook_signature_header_malformed when validity window > 5 minutes', () => {
    // 10-minute window — double the spec cap. This is a spec violation
    // (not a clock-skew expiry), so taxonomy routes to malformed.
    const req = buildSignedRequest({
      createdOffsetSeconds: -10,
      expiresOffsetSeconds: 600,
    });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_signature_header_malformed');
  });

  it('rejects with webhook_content_digest_mismatch when body is tampered after signing', () => {
    const original = buildSignedRequest({ withDigest: true });
    const tampered: WebhookRequest = {
      method: original.method,
      url: original.url,
      headers: original.headers,
      body: '{"status":"completed","task_id":"TAMPERED"}',
    };
    const result = verifyWebhookSignature(tampered, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_content_digest_mismatch');
  });

  it('rejects with webhook_content_digest_missing when digest required but not present', () => {
    const req = buildSignedRequest({ withDigest: false });
    const result = verifyWebhookSignature(req, jwks, { requireContentDigest: true });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_content_digest_missing');
  });

  it('rejects with webhook_signature_header_malformed on unparseable Signature-Input', () => {
    const req = buildSignedRequest({});
    const broken: WebhookRequest = {
      ...req,
      headers: { ...req.headers, 'Signature-Input': 'this is not structured-fields syntax' },
    };
    const result = verifyWebhookSignature(broken, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_signature_header_malformed');
  });

  // Algorithm-confusion defense: the Signature-Input `alg` parameter must
  // describe the same key type as the JWK in the JWKS.

  it('rejects alg-confusion: JWK is EC/P-256 but Signature-Input alg is ed25519', () => {
    // Point keyid at the ES256 JWK, but claim ed25519 in Signature-Input.
    const req = buildSignedRequest({
      keyid: 'test-es256-2026',
      alg: 'ed25519',
      signingKey: TEST_ED25519_PRIVATE_JWK, // sign with the wrong key on purpose
    });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_signature_invalid');
  });

  it('rejects alg-confusion: JWK is OKP/Ed25519 but Signature-Input alg is ecdsa-p256-sha256', () => {
    const req = buildSignedRequest({
      keyid: 'test-ed25519-2026',
      alg: 'ecdsa-p256-sha256',
      signingKey: TEST_ES256_PRIVATE_JWK, // would-be valid ES256 sig, wrong key
    });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_signature_invalid');
  });

  it('rejects JOSE algorithm names (EdDSA/ES256) in Signature-Input alg', () => {
    // Spec-wise, only the RFC 9421 IANA names are valid in Signature-Input.
    const req = buildSignedRequest({ alg: 'EdDSA' });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_signature_invalid');
  });

  it('rejects ECDSA signatures with non-64-byte P1363 payload as malformed', () => {
    // Truncate the 64-byte r||s to 32 bytes — impossible from a conforming
    // ES256 signer, so taxonomy should be header_malformed, not invalid.
    const req = buildSignedRequest({
      signingKey: TEST_ES256_PRIVATE_JWK,
      tamperSignatureToLength: 32,
    });
    const result = verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('webhook_signature_header_malformed');
  });
});
