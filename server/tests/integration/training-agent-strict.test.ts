/**
 * Integration tests for the `/mcp-strict` grader-targeted route.
 *
 * Covers the capability declaration difference vs. `/mcp` and the presence-
 * gated enforcement of `required_for`. Signed-request verification is
 * exercised end-to-end by the storyboard runner against the signing vectors;
 * these tests focus on the route-level plumbing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Set token before module loads so the static-key authenticator picks it up.
vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-for-strict';
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

const AUTH = 'Bearer test-token-for-strict';

/** Call a tool via MCP JSON-RPC and return the parsed inner response. */
async function callTool(
  app: express.Application,
  route: '/mcp' | '/mcp-strict',
  tool: string,
  args: Record<string, unknown>,
  opts: { auth?: boolean } = { auth: true },
) {
  const req = request(app)
    .post(`/api/training-agent${route}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (opts.auth !== false) req.set('Authorization', AUTH);
  return req.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
}

/** Parse a StreamableHTTP `text/event-stream` response into the JSON-RPC
 *  envelope. The transport writes `event: message\ndata: {...}\n\n` for
 *  successful tools/call responses. */
function parseSse(res: request.Response): Record<string, unknown> {
  const text = res.text ?? '';
  const match = text.match(/^data: (.*)$/m);
  if (!match) throw new Error(`No data line in SSE response: ${text.slice(0, 200)}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** Extract the tool's inner response (parsed from the MCP text content). */
function innerResponse(res: request.Response): Record<string, unknown> {
  const envelope = parseSse(res) as { result?: { content?: Array<{ text?: string }> } };
  const text = envelope.result?.content?.[0]?.text;
  if (!text) throw new Error(`No content text in envelope: ${JSON.stringify(envelope)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

describe('Training Agent /mcp-strict route', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  describe('capability declaration', () => {
    it('/mcp returns required_for: [] (sandbox)', async () => {
      const res = await callTool(app, '/mcp', 'get_adcp_capabilities', {});
      expect(res.status).toBe(200);
      const inner = innerResponse(res) as { request_signing: { required_for: string[] }; specialisms: string[] };
      expect(inner.request_signing.required_for).toEqual([]);
      expect(inner.specialisms).toContain('signed-requests');
    });

    it('/mcp-strict returns required_for: ["create_media_buy"] (grader target)', async () => {
      const res = await callTool(app, '/mcp-strict', 'get_adcp_capabilities', {});
      expect(res.status).toBe(200);
      const inner = innerResponse(res) as { request_signing: { required_for: string[] }; specialisms: string[] };
      expect(inner.request_signing.required_for).toEqual(['create_media_buy']);
      expect(inner.specialisms).toContain('signed-requests');
    });
  });

  describe('presence-gated enforcement', () => {
    it('unsigned create_media_buy on /mcp-strict returns 401 request_signature_required', async () => {
      const res = await callTool(app, '/mcp-strict', 'create_media_buy', {
        account: { brand: { domain: 'strict-test.example.com' }, sandbox: true },
        idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('request_signature_required');
      expect(res.body.error_description).toMatch(/create_media_buy.*signed/);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
    });

    it('unsigned create_media_buy on /mcp still accepted (bearer fallthrough)', async () => {
      // Not asserting success (depends on product catalog state); only that
      // the auth layer doesn't reject it with request_signature_required.
      const res = await callTool(app, '/mcp', 'create_media_buy', {
        account: { brand: { domain: 'strict-test.example.com' }, sandbox: true },
        idempotency_key: '550e8400-e29b-41d4-a716-446655440001',
      });
      expect(res.status).not.toBe(401);
    });

    it('unsigned get_products on /mcp-strict is allowed (not in required_for)', async () => {
      const res = await callTool(app, '/mcp-strict', 'get_products', {
        account: { brand: { domain: 'strict-test.example.com' }, sandbox: true },
        brand: { domain: 'strict-test.example.com' },
        buying_mode: 'wholesale',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('route contract', () => {
    it('GET /mcp-strict returns 405', async () => {
      const res = await request(app).get('/api/training-agent/mcp-strict');
      expect(res.status).toBe(405);
      expect(res.headers['allow']).toMatch(/POST/);
    });

    it('POST /mcp-strict without auth returns 401', async () => {
      const res = await callTool(app, '/mcp-strict', 'get_adcp_capabilities', {}, { auth: false });
      expect(res.status).toBe(401);
    });
  });
});
