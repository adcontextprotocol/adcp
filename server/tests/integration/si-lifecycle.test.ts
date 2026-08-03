/**
 * SI Chat Protocol full lifecycle integration test.
 *
 * Covers:
 *   1. si_get_offering — offering discovery, available field, offering_token
 *   2. si_initiate_session — session_id, session_status, response wrapper, UI elements
 *   3. si_send_message — response wrapper, UI element types with data wrapper
 *   4. si_terminate_session — terminated flag, session_status enum, turns_completed
 *   5. SESSION_ENDED path — si_terminate_session keeps session in map so
 *      subsequent si_send_message returns SESSION_ENDED (not NOT_FOUND)
 *   6. S5 sandbox_action reachability through ['sales', 'si'] tenant pins
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'si-lifecycle-test-token';
  process.env.NODE_ENV = 'test';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');
const { toolsForTenant } = await import('../../src/training-agent/tenants/tool-catalog.js');

const AUTH = 'Bearer si-lifecycle-test-token';

interface MCPBody {
  error?: unknown;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

describe('SI Chat Protocol lifecycle', () => {
  let server: http.Server;
  let baseUrl: string;

  async function callTool(
    tenantId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const url = `${baseUrl}/api/training-agent/${tenantId}/mcp`;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: AUTH,
    };
    // MCP requires an initialize handshake before tools/call.
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'si-test', version: '1' }, capabilities: {} },
      }),
    });
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await res.json() as MCPBody;
    if (body.error) {
      throw new Error(`JSON-RPC error on ${tenantId}/${name}: ${JSON.stringify(body.error)}`);
    }
    const sc = body.result?.structuredContent;
    if (sc) return sc as Record<string, unknown>;
    const text = body.result?.content?.[0]?.text;
    if (text) return JSON.parse(text) as Record<string, unknown>;
    throw new Error(`No result from ${tenantId}/${name}: ${JSON.stringify(body)}`);
  }

  function si(name: string, args: Record<string, unknown>) {
    return callTool('si', name, args);
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    stopSessionCleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  // ── S5 tool reachability ──────────────────────────────────────────

  it('every S5 sandbox_action is reachable through the S5 tenant URLs (sales + si)', () => {
    const S5_SANDBOX_ACTIONS = [
      'list_creative_formats',
      'build_creative',
      'sync_catalogs',
      'get_products',
      'create_media_buy',
      'si_get_offering',
      'si_initiate_session',
      'si_send_message',
      'si_terminate_session',
    ];
    for (const action of S5_SANDBOX_ACTIONS) {
      const covered = ['sales', 'si'].some(t => toolsForTenant(t).includes(action));
      expect(covered, `S5 sandbox_action "${action}" not reachable from ['sales', 'si']`).toBe(true);
    }
  });

  // ── si_get_offering ───────────────────────────────────────────────

  it('si_get_offering returns available=true with offering_token and offering object', async () => {
    const result = await si('si_get_offering', { offering_id: 'offer_sandbox_001' });
    expect(result.available).toBe(true);
    expect(typeof result.offering_token).toBe('string');
    expect(typeof result.checked_at).toBe('string');
    expect(typeof result.ttl_seconds).toBe('number');
    const offering = result.offering as Record<string, unknown>;
    expect(offering.offering_id).toBe('offer_sandbox_001');
    expect(typeof offering.title).toBe('string');
  });

  it('si_get_offering with include_products returns matching_products array', async () => {
    const result = await si('si_get_offering', {
      offering_id: 'offer_sandbox_001',
      include_products: true,
      product_limit: 2,
    });
    expect(result.available).toBe(true);
    expect(Array.isArray(result.matching_products)).toBe(true);
  });

  it('si_get_offering returns NOT_FOUND error for unknown offering_id', async () => {
    const result = await si('si_get_offering', { offering_id: 'offer_does_not_exist' });
    const err = result.adcp_error as Record<string, unknown> | undefined;
    expect(err?.code).toBe('NOT_FOUND');
  });

  // ── Full four-step lifecycle ──────────────────────────────────────

  it('four-step lifecycle: get_offering → initiate → send → terminate, then SESSION_ENDED', async () => {
    // Step 1: si_get_offering — offering discovery
    const offering = await si('si_get_offering', { offering_id: 'offer_sandbox_001' });
    expect(offering.available).toBe(true);
    expect(typeof offering.offering_token).toBe('string');

    // Step 2: si_initiate_session — start brand conversation
    const session = await si('si_initiate_session', {
      idempotency_key: `si-lc-init-${randomUUID()}`,
      intent: 'product_discovery',
      identity: { consent_granted: true },
      offering_id: 'offer_sandbox_001',
      offering_token: offering.offering_token,
    });
    expect(typeof session.session_id).toBe('string');
    expect(session.session_status).toBe('active');
    const initResponse = session.response as Record<string, unknown>;
    expect(typeof initResponse.message).toBe('string');
    expect(Array.isArray(initResponse.ui_elements)).toBe(true);
    // Greeting disclosure uses type 'text' with a data wrapper
    const greetEl = (initResponse.ui_elements as Array<Record<string, unknown>>)[0];
    expect(greetEl?.type).toBe('text');
    expect(typeof greetEl?.data).toBe('object');
    const sessionId = session.session_id as string;

    // Step 3: si_send_message — exchange messages
    const msg = await si('si_send_message', {
      idempotency_key: `si-lc-msg-${randomUUID()}`,
      session_id: sessionId,
      message: 'What products do you have?',
    });
    expect(msg.session_id).toBe(sessionId);
    expect(['active', 'pending_handoff']).toContain(msg.session_status);
    const msgResponse = msg.response as Record<string, unknown>;
    expect(typeof msgResponse.message).toBe('string');
    expect(Array.isArray(msgResponse.ui_elements)).toBe(true);
    // Turn 1 returns a product_card; UI element must have a data wrapper
    const msgEl = (msgResponse.ui_elements as Array<Record<string, unknown>>)[0];
    expect(msgEl?.type).toBe('product_card');
    expect(typeof msgEl?.data).toBe('object');

    // Step 4: si_terminate_session — end the session
    const term = await si('si_terminate_session', {
      session_id: sessionId,
      reason: 'user_exit',
    });
    expect(term.terminated).toBe(true);
    expect(term.session_id).toBe(sessionId);
    expect(term.session_status).toBe('terminated');
    expect(typeof term.turns_completed).toBe('number');

    // Bonus step: SESSION_ENDED — session remains in map after termination
    // so si_send_message returns SESSION_ENDED, not NOT_FOUND.
    const afterTerm = await si('si_send_message', {
      idempotency_key: `si-lc-after-${randomUUID()}`,
      session_id: sessionId,
      message: 'Hello?',
    });
    const afterErr = afterTerm.adcp_error as Record<string, unknown> | undefined;
    expect(afterErr?.code).toBe('SESSION_ENDED');
  });

  // ── Terminate reason codes ────────────────────────────────────────

  it('si_terminate_session with handoff_transaction returns session_status=complete', async () => {
    const session = await si('si_initiate_session', {
      idempotency_key: `si-lc-handoff-${randomUUID()}`,
      intent: 'purchase',
      identity: { consent_granted: true },
    });
    const sessionId = session.session_id as string;

    const term = await si('si_terminate_session', {
      session_id: sessionId,
      reason: 'handoff_transaction',
    });
    expect(term.terminated).toBe(true);
    expect(term.session_status).toBe('complete');
  });

  it('si_terminate_session with handoff_complete returns session_status=complete', async () => {
    const session = await si('si_initiate_session', {
      idempotency_key: `si-lc-hcomplete-${randomUUID()}`,
      intent: 'post_purchase',
      identity: { consent_granted: true },
    });
    const sessionId = session.session_id as string;

    const term = await si('si_terminate_session', {
      session_id: sessionId,
      reason: 'handoff_complete',
    });
    expect(term.terminated).toBe(true);
    expect(term.session_status).toBe('complete');
  });

  it('si_terminate_session is idempotent — repeated call returns same terminal state', async () => {
    const session = await si('si_initiate_session', {
      idempotency_key: `si-lc-idem-${randomUUID()}`,
      intent: 'test',
      identity: { consent_granted: false },
    });
    const sessionId = session.session_id as string;

    const term1 = await si('si_terminate_session', { session_id: sessionId, reason: 'user_exit' });
    expect(term1.terminated).toBe(true);
    expect(term1.session_status).toBe('terminated');

    const term2 = await si('si_terminate_session', { session_id: sessionId, reason: 'user_exit' });
    expect(term2.terminated).toBe(true);
    expect(term2.session_status).toBe('terminated');
  });

  // ── Carousel and action_button UI elements (turns 2 and 3) ───────

  it('si_send_message turn 2 returns carousel UI element', async () => {
    const session = await si('si_initiate_session', {
      idempotency_key: `si-turn2-init-${randomUUID()}`,
      intent: 'comparison',
      identity: { consent_granted: true },
    });
    const sessionId = session.session_id as string;

    // Consume turn 1
    await si('si_send_message', {
      idempotency_key: `si-turn2-msg1-${randomUUID()}`,
      session_id: sessionId,
      message: 'Tell me about your products',
    });

    // Turn 2 should return a carousel
    const msg2 = await si('si_send_message', {
      idempotency_key: `si-turn2-msg2-${randomUUID()}`,
      session_id: sessionId,
      message: 'Can you compare them?',
    });
    const resp = msg2.response as Record<string, unknown>;
    expect(Array.isArray(resp.ui_elements)).toBe(true);
    const el = (resp.ui_elements as Array<Record<string, unknown>>)[0];
    expect(el?.type).toBe('carousel');
    expect(typeof el?.data).toBe('object');

    await si('si_terminate_session', { session_id: sessionId, reason: 'user_exit' });
  });
});
