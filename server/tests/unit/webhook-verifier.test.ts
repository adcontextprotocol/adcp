/**
 * Unit tests for the RFC 9421 AdCP webhook-signature verifier.
 *
 * We sign fresh requests at test-time using a known Ed25519 keypair from
 * static/compliance/source/test-vectors/request-signing/keys.json, so the
 * `created`/`expires` timestamps are current (the compliance vectors are
 * frozen to 2026-and-change, which is past-relative to the skew window
 * once it arrives).
 *
 * All vectors exercise the webhook error taxonomy from
 * docs/building/implementation/webhooks.mdx.
 */

import { createHash, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { describe, it, expect } from 'vitest';

import {
  verifyWebhookSignature,
  type JWKS,
  type WebhookRequest,
} from '../../src/adcp-security/webhook-verifier.js';
import {
  TEST_ED25519_PRIVATE_JWK,
  TEST_JWKS,
} from '../../src/adcp-security/__fixtures__/webhook-signature-keys.js';

/**
 * Build a signed request using the fixture Ed25519 key.  Mirrors the AdCP
 * webhook profile layout: @method @target-uri @authority content-type
 * [+ content-digest when withDigest=true].
 */
function buildSignedRequest(options: {
  readonly method?: string;
  readonly url?: string;
  readonly body?: string;
  readonly withDigest?: boolean;
  readonly createdOffsetSeconds?: number;
  readonly expiresOffsetSeconds?: number;
  readonly keyid?: string;
  readonly tamperBody?: boolean;
  readonly omitSignatureHeader?: boolean;
  readonly signingKeyJwk?: typeof TEST_ED25519_PRIVATE_JWK;
}): WebhookRequest {
  const method = options.method ?? 'POST';
  const url = options.url ?? 'https://buyer.example.com/webhooks/adcp/media-buy';
  const body = options.body ?? '{"status":"completed","task_id":"task_42"}';
  const withDigest = options.withDigest ?? true;
  const keyid = options.keyid ?? 'test-ed25519-2026';
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
  const paramsSerialized =
    `;created=${created};expires=${expires};` +
    `nonce="${nonce}";keyid="${keyid}";alg="ed25519";tag="${tag}"`;
  const sigParamsValue = `${componentsList}${paramsSerialized}`;

  // Build signature base manually — this is the canonical form per
  // RFC 9421 §2.3, and is what the verifier rebuilds internally.
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

  // Sign.
  const privateKey = createPrivateKey({
    key: options.signingKeyJwk ?? TEST_ED25519_PRIVATE_JWK,
    format: 'jwk',
  });
  const signature = cryptoSign(null, Buffer.from(signatureBase, 'utf-8'), privateKey);
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

  return {
    method,
    url,
    headers,
    body: options.tamperBody ? `${body} `.slice(0, body.length) + 'X' : body,
  };
}

describe('verifyWebhookSignature', () => {
  const jwks: JWKS = TEST_JWKS;

  it('accepts a well-formed signature with content-digest', async () => {
    const req = buildSignedRequest({ withDigest: true });
    const result = await verifyWebhookSignature(req, jwks);
    expect(result).toEqual({
      valid: true,
      keyid: 'test-ed25519-2026',
      alg: 'ed25519',
    });
  });

  it('accepts a well-formed signature without content-digest when not required', async () => {
    const req = buildSignedRequest({ withDigest: false });
    const result = await verifyWebhookSignature(req, jwks, {
      requireContentDigest: false,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects with webhook_signature_required when Signature header is missing', async () => {
    const req = buildSignedRequest({ omitSignatureHeader: true });
    const result = await verifyWebhookSignature(req, jwks);
    expect(result).toEqual({
      valid: false,
      reason: 'webhook_signature_required',
    });
  });

  it('rejects with webhook_signature_required when both signature headers are absent', async () => {
    const req = buildSignedRequest({});
    const stripped: WebhookRequest = {
      method: req.method,
      url: req.url,
      body: req.body,
      headers: { 'Content-Type': 'application/json' },
    };
    const result = await verifyWebhookSignature(stripped, jwks);
    expect(result).toEqual({
      valid: false,
      reason: 'webhook_signature_required',
    });
  });

  it('rejects with webhook_signature_key_unknown when keyid is not in the JWKS', async () => {
    const req = buildSignedRequest({ keyid: 'not-a-real-kid' });
    const result = await verifyWebhookSignature(req, jwks);
    expect(result).toEqual({
      valid: false,
      reason: 'webhook_signature_key_unknown',
    });
  });

  it('rejects with webhook_signature_expired when created is far in the past', async () => {
    const req = buildSignedRequest({
      // created 2 hours ago; expires 1 hour ago — well past skew window.
      createdOffsetSeconds: -7200,
      expiresOffsetSeconds: -3600,
    });
    const result = await verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('webhook_signature_expired');
    }
  });

  it('rejects with webhook_signature_expired when validity window exceeds 5 minutes', async () => {
    const req = buildSignedRequest({
      // 10-minute window — double the spec cap.
      createdOffsetSeconds: -10,
      expiresOffsetSeconds: 600,
    });
    const result = await verifyWebhookSignature(req, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('webhook_signature_expired');
    }
  });

  it('rejects with webhook_content_digest_mismatch when body is tampered after signing', async () => {
    // Sign against the pristine body, then replace body bytes so the
    // receiver's recomputed SHA-256 won't match the header value.
    const original = buildSignedRequest({ withDigest: true });
    const tampered: WebhookRequest = {
      method: original.method,
      url: original.url,
      headers: original.headers,
      body: '{"status":"completed","task_id":"TAMPERED"}',
    };
    const result = await verifyWebhookSignature(tampered, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('webhook_content_digest_mismatch');
    }
  });

  it('rejects with webhook_content_digest_missing when digest required but not present', async () => {
    const req = buildSignedRequest({ withDigest: false });
    const result = await verifyWebhookSignature(req, jwks, {
      requireContentDigest: true,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('webhook_content_digest_missing');
    }
  });

  it('rejects with webhook_signature_header_malformed on unparseable Signature-Input', async () => {
    const req = buildSignedRequest({});
    const broken: WebhookRequest = {
      ...req,
      headers: {
        ...req.headers,
        'Signature-Input': 'this is not structured-fields syntax',
      },
    };
    const result = await verifyWebhookSignature(broken, jwks);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('webhook_signature_header_malformed');
    }
  });
});
