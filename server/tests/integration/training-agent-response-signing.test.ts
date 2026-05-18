/**
 * Integration test for outbound RFC 9421 response signing on tenant MCP
 * routes. Asserts:
 *   - successful JSON-RPC responses get `Signature`, `Signature-Input`, and
 *     `Content-Digest` headers
 *   - the signature verifies against the tenant's `response-signing` JWK
 *     published at `/.well-known/jwks.json`
 *   - the JWK carries `adcp_use: "response-signing"` (purpose-binding)
 *   - non-JSON / SSE responses pass through unsigned
 *
 * Verifier-side helpers (`buildResponseSignatureBase`, Ed25519 verify via
 * node:crypto) follow the same pattern as the SDK's own response-signing
 * test — round-trips the bytes without depending on a verifier helper that
 * hasn't shipped yet.
 */
import { createPublicKey, createVerify, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { buildResponseSignatureBase, type ResponseLike } from '@adcp/sdk/signing';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-for-response-signing';
  delete process.env.BASE_URL;
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');

/** Parse the Signature-Input header value into components + params.
 *  Format per RFC 9421 §4.1: `sig1=("@status" "@authority" "content-digest");created=…;keyid=…;alg=…` */
function parseSignatureInput(headerValue: string): { label: string; components: string[]; params: Record<string, string | number> } {
  const eq = headerValue.indexOf('=');
  const label = headerValue.slice(0, eq);
  const rest = headerValue.slice(eq + 1);
  const closeParen = rest.indexOf(')');
  const componentList = rest.slice(1, closeParen);
  const components = componentList.split(' ').map(c => c.replace(/^"|"$/g, ''));
  const paramPart = rest.slice(closeParen + 1).replace(/^;/, '');
  const params: Record<string, string | number> = {};
  for (const p of paramPart.split(';')) {
    if (!p) continue;
    const [k, v] = p.split('=');
    if (!k) continue;
    const stripped = (v ?? '').replace(/^"|"$/g, '');
    params[k] = /^\d+$/.test(stripped) ? Number(stripped) : stripped;
  }
  return { label, components, params };
}

/** Decode the bare signature bytes from a Signature header value.
 *  Format: `sig1=:<base64>:` per RFC 9421 §4.2. */
function decodeSignatureBytes(headerValue: string): Buffer {
  const colon = headerValue.indexOf(':');
  const closing = headerValue.lastIndexOf(':');
  const b64 = headerValue.slice(colon + 1, closing);
  return Buffer.from(b64, 'base64');
}

describe('Training Agent response signing', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json({
      limit: '5mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
      },
    }));
    app.use('/api/training-agent', createTrainingAgentRouter());
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  it("publishes the response-signing JWK on /.well-known/jwks.json", async () => {
    const res = await request(app)
      .get('/api/training-agent/.well-known/jwks.json')
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(200);
    const keys = res.body.keys as Array<Record<string, unknown>>;
    const salesKey = keys.find(k => typeof k.kid === 'string' && (k.kid as string).startsWith('training-sales-resp-'));
    expect(salesKey, 'sales tenant must publish a response-signing JWK').toBeDefined();
    expect(salesKey?.adcp_use).toBe('response-signing');
    expect(salesKey?.kty).toBe('OKP');
    expect(salesKey?.crv).toBe('Ed25519');
    expect(salesKey?.alg).toBe('EdDSA');
  });

  it('signs initialize responses on /sales/mcp and the signature verifies', async () => {
    // The MCP `initialize` handshake produces a plain JSON-RPC 2.0 result
    // that the response-signing wrapper covers. We use it instead of
    // `tools/list` because supertest doesn't negotiate the streamable HTTP
    // SSE upgrade, and initialize returns plain JSON in both modes.
    const res = await request(app)
      .post('/api/training-agent/sales/mcp')
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https')
      .set('Authorization', 'Bearer test-token-for-response-signing')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          clientInfo: { name: 'response-signing-test', version: '1.0' },
          capabilities: {},
        },
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['signature']).toBeDefined();
    expect(res.headers['signature-input']).toBeDefined();
    expect(res.headers['content-digest']).toBeDefined();

    // Pull the kid out of Signature-Input + look up the matching public key.
    const parsed = parseSignatureInput(res.headers['signature-input']);
    expect(parsed.components).toContain('@status');
    expect(parsed.components).toContain('@authority');
    expect(parsed.components).toContain('content-digest');
    expect(typeof parsed.params.keyid).toBe('string');
    const kid = parsed.params.keyid as string;
    expect(kid).toMatch(/^training-sales-resp-/);

    const jwksRes = await request(app)
      .get('/api/training-agent/.well-known/jwks.json')
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https');
    const jwk = (jwksRes.body.keys as Array<Record<string, unknown>>).find(k => k.kid === kid);
    expect(jwk).toBeDefined();

    // Reconstruct the signature base the signer produced, then verify the
    // Ed25519 signature against the JWK. This is a round-trip of the wire
    // bytes — same pattern as the SDK's own response-signing test.
    const responseLike: ResponseLike = {
      status: res.status,
      headers: {
        'content-type': res.headers['content-type'],
        'content-digest': res.headers['content-digest'],
      },
      body: res.text,
      request: {
        method: 'POST',
        url: 'https://test-agent.example.org/api/training-agent/sales/mcp',
      },
    };
    const sigInputHeader = res.headers['signature-input'] as string;
    const sigParamsValue = sigInputHeader.slice(sigInputHeader.indexOf('=') + 1);
    const base = buildResponseSignatureBase(parsed.components, responseLike, parsed.params as Parameters<typeof buildResponseSignatureBase>[2], sigParamsValue);
    const signatureBytes = decodeSignatureBytes(res.headers['signature'] as string);

    const publicKey: KeyObject = createPublicKey({ format: 'jwk', key: jwk as Parameters<typeof createPublicKey>[0]['key'] });
    const ok = cryptoVerify(null, Buffer.from(base, 'utf8'), publicKey, signatureBytes);
    expect(ok, 'Signature must verify against the published response-signing JWK').toBe(true);
  });

  it('passes through non-JSON responses unsigned (health endpoint)', async () => {
    const res = await request(app).get('/api/training-agent/health');
    expect(res.headers['signature']).toBeUndefined();
    expect(res.headers['signature-input']).toBeUndefined();
  });
});
