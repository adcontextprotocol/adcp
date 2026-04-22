import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { createFrameworkTrainingAgentServer } from '../../src/training-agent/framework-server.js';
import { clearSessions, getSession } from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

type AnyServer = ReturnType<typeof createFrameworkTrainingAgentServer>;

const ACCOUNT = { brand: { domain: 'comply-fw.example.com' }, operator: 'tester', sandbox: true };
const BRAND = { domain: 'comply-fw.example.com' };

async function callTool(server: AnyServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const text = res.content?.[0]?.text;
  const parsed = typeof text === 'string' ? JSON.parse(text) : {};
  return parsed.adcp_error ?? parsed;
}

async function syncCreative(server: AnyServer): Promise<string> {
  const creativeId = `cr-fw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const result = await callTool(server, 'sync_creatives', {
    idempotency_key: crypto.randomUUID(),
    account: ACCOUNT,
    brand: BRAND,
    creatives: [{
      creative_id: creativeId,
      name: 'FW Test Creative',
      format_id: { agent_url: 'https://example.com', id: 'display_300x250' },
      assets: {
        image: {
          asset_type: 'image',
          url: 'https://via.placeholder.com/300x250',
          width: 300,
          height: 250,
          mime_type: 'image/png',
        },
      },
    }],
  });
  if ((result as { errors?: unknown[] }).errors) {
    throw new Error(`sync_creatives failed: ${JSON.stringify(result)}`);
  }
  return creativeId;
}

describe('framework-server comply_test_controller', () => {
  let server: AnyServer;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    const ctx: TrainingContext = { mode: 'open', principal: 'anonymous' };
    server = createFrameworkTrainingAgentServer(ctx);
  });

  it('returns UNKNOWN_SCENARIO with context echoed on unrecognized scenario', async () => {
    const correlationId = 'fw-unknown-scenario-test';
    const result = await callTool(server, 'comply_test_controller', {
      scenario: 'nonexistent_scenario',
      params: {},
      account: ACCOUNT,
      brand: BRAND,
      context: { correlation_id: correlationId },
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('UNKNOWN_SCENARIO');
    expect((result.context as { correlation_id?: string })?.correlation_id).toBe(correlationId);
  });

  it('returns INVALID_TRANSITION with context echoed when forcing a terminal creative back', async () => {
    const creativeId = await syncCreative(server);
    // approved -> archived (valid)
    const archived = await callTool(server, 'comply_test_controller', {
      scenario: 'force_creative_status',
      params: { creative_id: creativeId, status: 'archived' },
      account: ACCOUNT,
      brand: BRAND,
    });
    expect(archived.success).toBe(true);

    // Lock in the mechanism: archived state must be persisted to the session
    // store between requests, otherwise the next probe hits NOT_FOUND. If a
    // refactor ever changes session scoping so forceCreativeStatus reads from
    // a different store than the creative was synced into, this assertion
    // fires before the error-code check below.
    const session = await getSession('open:comply-fw.example.com');
    expect(session.creatives.get(creativeId)?.status).toBe('archived');

    // archived -> processing (invalid; archived only allows -> approved)
    const correlationId = 'fw-invalid-transition-test';
    const invalid = await callTool(server, 'comply_test_controller', {
      scenario: 'force_creative_status',
      params: { creative_id: creativeId, status: 'processing' },
      account: ACCOUNT,
      brand: BRAND,
      context: { correlation_id: correlationId },
    });
    expect(invalid.success).toBe(false);
    expect(invalid.error).toBe('INVALID_TRANSITION');
    expect((invalid.context as { correlation_id?: string })?.correlation_id).toBe(correlationId);
  });
});
