/**
 * SI Chat Protocol lifecycle integration test.
 *
 * Validates the canonical four-step sequence against the /si training-agent
 * tenant and asserts that each handler's response conforms to the 3.1.8
 * SI schema shapes (si-get-offering-response, si-initiate-session-response,
 * si-send-message-response, si-terminate-session-response).
 *
 * Does NOT validate every field — covers the required fields and the structural
 * shapes that differ from non-conformant prior implementations (the offering_token
 * on get-offering, session_status + response wrapper on initiate/send,
 * session_status + no delete on terminate).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import crypto from 'node:crypto';

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
const { stopSiSessionCleanup } = await import('../../src/training-agent/si-handlers.js');

const AUTH = 'Bearer si-lifecycle-test-token';
const TENANT_URL_PATH = '/api/training-agent/si/mcp';

interface MCPResponse {
  error?: { code: number; message: string };
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

let server: http.Server;
let baseUrl: string;

async function initialize(): Promise<void> {
  const url = `${baseUrl}${TENANT_URL_PATH}`;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: AUTH },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'si-lifecycle', version: '1' }, capabilities: {} },
    }),
  });
}

async function callTool(toolName: string, args: Record<string, unknown>): Promise<MCPResponse> {
  const url = `${baseUrl}${TENANT_URL_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }),
  });
  return res.json() as Promise<MCPResponse>;
}

function parseToolResult(body: MCPResponse): Record<string, unknown> {
  // Handlers return JSON in content[0].text (MCP text envelope) or structuredContent.
  const text = body.result?.content?.[0]?.text;
  if (text) {
    try { return JSON.parse(text) as Record<string, unknown>; } catch { /* fall through */ }
  }
  return (body.result?.structuredContent ?? {}) as Record<string, unknown>;
}

describe('SI Chat Protocol lifecycle (/si tenant)', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    await initialize();
  });

  afterAll(async () => {
    stopSessionCleanup();
    stopSiSessionCleanup();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('advertises the native sponsored-intelligence surface', async () => {
    const body = await callTool('get_adcp_capabilities', {});
    const result = parseToolResult(body);

    expect(result['specialisms']).toEqual(expect.arrayContaining(['sponsored-intelligence']));
    expect(result['supported_protocols']).toEqual(expect.arrayContaining(['sponsored_intelligence']));
  });

  it('si_get_offering returns available, offering_token, ttl_seconds, checked_at', async () => {
    const body = await callTool('si_get_offering', { offering_id: 'novamotors_conversational_v1' });
    expect(body.error).toBeUndefined();
    const result = parseToolResult(body);

    expect(result).toHaveProperty('available', true);
    expect(result).toHaveProperty('offering_token');
    expect(typeof result['offering_token']).toBe('string');
    expect(result).toHaveProperty('ttl_seconds');
    expect(typeof result['ttl_seconds']).toBe('number');
    expect(result).toHaveProperty('checked_at');
    expect(typeof result['checked_at']).toBe('string');
    expect(result).toHaveProperty('offering');
    expect(result).toHaveProperty('sponsored_context');
  });

  it('si_get_offering for unknown offering_id returns correctable error', async () => {
    const body = await callTool('si_get_offering', { offering_id: 'offer_does_not_exist' });
    // Native platform errors are projected as adcp_error in structuredContent.
    const adcpError = body.result?.structuredContent?.['adcp_error'] as Record<string, unknown> | undefined;
    expect(adcpError?.['code']).toBe('NOT_FOUND');
    expect(adcpError?.['recovery']).toBe('correctable');
  });

  it('full lifecycle: initiate → send → send with action → terminate', async () => {
    const ikey = `test-${crypto.randomUUID()}`;

    // Step 1: initiate session
    const initiateBody = await callTool('si_initiate_session', {
      idempotency_key: ikey,
      intent: 'looking for a widget',
      identity: { consent_granted: true },
      offering_id: 'offer_sandbox_001',
    });
    expect(initiateBody.error).toBeUndefined();
    const initResult = parseToolResult(initiateBody);

    expect(initResult).toHaveProperty('session_id');
    expect(initResult).toHaveProperty('session_status', 'active');
    expect(initResult).toHaveProperty('response');
    expect(initResult).toHaveProperty('sponsored_context');
    const initResponse = initResult['response'] as Record<string, unknown>;
    expect(typeof initResponse['message']).toBe('string');
    expect(Array.isArray(initResponse['ui_elements'])).toBe(true);

    const sessionId = initResult['session_id'] as string;

    // Accepted receipts cannot silently downgrade the declared context use.
    const downgradeBody = await callTool('si_send_message', {
      idempotency_key: `send-${crypto.randomUUID()}`,
      session_id: sessionId,
      message: 'This request must be rejected before advancing the transcript.',
      sponsored_context_receipt: {
        sponsored_context: {
          paying_principal: { brand: { domain: 'acmeoutdoor.example' } },
          context_use: 'presentation_only',
          disclosure_obligation: { required: false },
        },
        host_receipt: {
          status: 'accepted',
          accepted_context_use: 'reasoning_context',
          received_at: '2026-06-15T10:00:07Z',
          disclosure_commitment: { status: 'not_required' },
        },
      },
    });
    const downgradeError = downgradeBody.result?.structuredContent?.['adcp_error'] as
      | Record<string, unknown>
      | undefined;
    expect(['INVALID_REQUEST', 'VALIDATION_ERROR']).toContain(downgradeError?.['code']);

    // Step 2: send a conversational message
    const sendKey1 = `send-${crypto.randomUUID()}`;
    const sendBody1 = await callTool('si_send_message', {
      idempotency_key: sendKey1,
      session_id: sessionId,
      message: 'What products do you have?',
    });
    expect(sendBody1.error).toBeUndefined();
    const sendResult1 = parseToolResult(sendBody1);

    expect(sendResult1).toHaveProperty('session_id', sessionId);
    expect(sendResult1).toHaveProperty('session_status', 'active');
    expect(sendResult1).toHaveProperty('response');
    expect(sendResult1).toHaveProperty('sponsored_context');
    const sendResponse1 = sendResult1['response'] as Record<string, unknown>;
    expect(typeof sendResponse1['message']).toBe('string');
    expect(Array.isArray(sendResponse1['ui_elements'])).toBe(true);

    // Validate UI element type conformance (must be one of the canonical types)
    const canonicalTypes = new Set(['text', 'link', 'image', 'product_card', 'carousel', 'action_button', 'app_handoff', 'integration_actions']);
    for (const el of (sendResponse1['ui_elements'] as Array<Record<string, unknown>>)) {
      expect(canonicalTypes.has(el['type'] as string), `non-canonical UI element type: ${el['type']}`).toBe(true);
      if (el['type'] !== 'app_handoff') {
        expect(el).toHaveProperty('data');
      }
    }

    // Step 3: send a commerce action_response
    const sendKey2 = `send-${crypto.randomUUID()}`;
    const sendBody2 = await callTool('si_send_message', {
      idempotency_key: sendKey2,
      session_id: sessionId,
      action_response: { action: 'commerce_handoff', payload: { product_id: 'prod_alpha' } },
    });
    const sendResult2 = parseToolResult(sendBody2);

    expect(sendResult2).toHaveProperty('session_id', sessionId);
    // Commerce action triggers pending_handoff status
    expect(['active', 'pending_handoff']).toContain(sendResult2['session_status']);

    // Step 4: terminate session
    const termBody = await callTool('si_terminate_session', {
      session_id: sessionId,
      reason: 'user_exit',
    });
    expect(termBody.error).toBeUndefined();
    const termResult = parseToolResult(termBody);

    expect(termResult).toHaveProperty('session_id', sessionId);
    expect(termResult).toHaveProperty('terminated', true);
    expect(termResult).toHaveProperty('session_status', 'terminated');
  });

  it('si_terminate_session with handoff_transaction sets session_status to complete', async () => {
    const ikey = `test-${crypto.randomUUID()}`;
    const initiateBody = await callTool('si_initiate_session', {
      idempotency_key: ikey,
      intent: 'buy a widget',
      identity: { consent_granted: true },
    });
    const initResult = parseToolResult(initiateBody);
    const sessionId = initResult['session_id'] as string;

    const termBody = await callTool('si_terminate_session', {
      session_id: sessionId,
      reason: 'handoff_transaction',
    });
    const termResult = parseToolResult(termBody);

    expect(termResult).toHaveProperty('terminated', true);
    expect(termResult).toHaveProperty('session_status', 'complete');
    expect(termResult).toHaveProperty('acp_handoff');
  });

  it('si_send_message after termination returns SESSION_TERMINATED error (session not deleted)', async () => {
    const ikey = `test-${crypto.randomUUID()}`;
    const initiateBody = await callTool('si_initiate_session', {
      idempotency_key: ikey,
      intent: 'test session terminated path',
      identity: { consent_granted: false, anonymous_session_id: 'anon_test_123' },
    });
    const initResult = parseToolResult(initiateBody);
    const sessionId = initResult['session_id'] as string;

    // Terminate first
    await callTool('si_terminate_session', { session_id: sessionId, reason: 'user_exit' });

    // Now try to send a message — must get SESSION_TERMINATED, not NOT_FOUND
    const sendKey = `send-${crypto.randomUUID()}`;
    const sendBody = await callTool('si_send_message', {
      idempotency_key: sendKey,
      session_id: sessionId,
      message: 'hello?',
    });
    // Native platform errors are projected as adcp_error in structuredContent.
    const adcpError = sendBody.result?.structuredContent?.['adcp_error'] as Record<string, unknown> | undefined;
    expect(adcpError?.['code']).toBe('SESSION_TERMINATED');
  });

  it('si_initiate_session without consent_granted returns an error', async () => {
    const body = await callTool('si_initiate_session', {
      idempotency_key: `test-${crypto.randomUUID()}`,
      intent: 'looking for something',
      identity: { anonymous_session_id: 'anon_456' },
    });
    // The handler validates consent_granted and returns MISSING_REQUIRED when absent.
    // The custom tool wrapper converts this to adcp_error in structuredContent (isError: true).
    const adcpError = body.result?.structuredContent?.['adcp_error'] as Record<string, unknown> | undefined;
    const isToolError = body.result?.isError === true;
    const isJsonRpcError = body.error != null;
    expect(
      adcpError != null || isToolError || isJsonRpcError,
      'expected an error when consent_granted is missing',
    ).toBe(true);
  });
});
