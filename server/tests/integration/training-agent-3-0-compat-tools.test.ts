import { describe, it, expect, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'compat-tools-token';
  process.env.NODE_ENV = 'test';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { createTrainingAgentServer } = await import('../../src/training-agent/task-handlers.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');

const COMPAT_CTX = { mode: 'open' as const, storyboardCompat: { version: '3.0' as const } };
const AUTH = 'Bearer compat-tools-token';
const CURRENT_ADCP_VERSION = '3.2-beta.2';

async function simulateListTools(server: ReturnType<typeof createTrainingAgentServer>): Promise<string[]> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/list');
  const response = await handler({ method: 'tools/list' }, {});
  return (response.tools as Array<{ name: string }>).map(tool => tool.name);
}

async function simulateCallTool(server: ReturnType<typeof createTrainingAgentServer>, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  const response = await handler({
    method: 'tools/call',
    params: { name, arguments: args },
  }, {});
  const text = response.content?.[0]?.text;
  return text ? JSON.parse(text) as Record<string, unknown> : response.structuredContent;
}

async function bootRouter(options: { compat?: boolean } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter(options.compat ? { storyboardCompat: { version: '3.0' } } : {}));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/training-agent`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

async function bootCompatRouter(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return bootRouter({ compat: true });
}

async function listTenantTools(baseUrl: string, tenant: string): Promise<string[]> {
  const url = `${baseUrl}/${tenant}/mcp`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: AUTH,
  };
  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'compat', version: '1' }, capabilities: {} },
    }),
  });
  const list = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const body = await list.json() as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map(tool => tool.name);
}

async function callTenantTool(baseUrl: string, tenant: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `${baseUrl}/${tenant}/mcp`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: AUTH,
  };
  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'compat', version: '1' }, capabilities: {} },
    }),
  });
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await response.json() as {
    result?: { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  };
  const text = body.result?.content?.[0]?.text;
  return body.result?.structuredContent ?? (text ? JSON.parse(text) as Record<string, unknown> : {});
}

afterAll(() => {
  stopSessionCleanup();
});

describe('training-agent 3.0 compat tool visibility', () => {
  const validImageManifest = {
    format_kind: 'image',
    assets: {
      image_main: {
        asset_type: 'image',
        url: 'https://cdn.acme.example/mrec.png',
        width: 300,
        height: 250,
      },
    },
  };

  it('hides and rejects validate_input on monolith routes used by strict MCP', async () => {
    const server = createTrainingAgentServer(COMPAT_CTX);
    const tools = await simulateListTools(server);
    expect(tools).not.toContain('validate_input');

    const result = await simulateCallTool(server, 'validate_input', {
      manifest: { format_kind: 'image', assets: {} },
      targets: [{ kind: 'canonical', id: 'image' }],
    });
    expect(result.adcp_error).toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Unknown tool: validate_input',
    });
  });

  it('hides validate_input on compat tenant routes and adagents discovery', async () => {
    const { baseUrl, close } = await bootCompatRouter();
    try {
      for (const tenant of ['sales', 'creative', 'creative-builder']) {
        await expect(listTenantTools(baseUrl, tenant)).resolves.not.toContain('validate_input');
      }

      const discovery = await fetch(`${baseUrl}/.well-known/adagents.json`);
      const body = await discovery.json() as {
        _training_agent_tenants?: Array<{ tenant_id: string; tools?: string[] }>;
      };
      for (const tenant of ['sales', 'creative', 'creative-builder']) {
        const entry = body._training_agent_tenants?.find(item => item.tenant_id === tenant);
        expect(entry?.tools ?? []).not.toContain('validate_input');
      }
    } finally {
      await close();
    }
  });

  it('keeps validate_input callable but undiscovered on the current compact media-buy profile', async () => {
    const { baseUrl, close } = await bootRouter();
    try {
      await expect(listTenantTools(baseUrl, 'sales')).resolves.not.toContain('validate_input');

      const unpinned = await callTenantTool(baseUrl, 'sales', 'validate_input', {
        manifest: validImageManifest,
        targets: [{ kind: 'canonical', id: 'image' }],
      });
      expect(unpinned.adcp_version).toBe(CURRENT_ADCP_VERSION);
      expect(unpinned.results).toEqual([
        { target: { kind: 'canonical', id: 'image' }, result_kind: 'validated_pass' },
      ]);

      const pinnedThreeOne = await callTenantTool(baseUrl, 'sales', 'validate_input', {
        adcp_version: '3.1-beta.5',
        manifest: validImageManifest,
        targets: [{ kind: 'canonical', id: 'image' }],
      });
      expect(pinnedThreeOne.adcp_version).toBe('3.1-beta.5');
      expect(pinnedThreeOne.results).toEqual(unpinned.results);

      const pinnedThreeZero = await callTenantTool(baseUrl, 'sales', 'validate_input', {
        adcp_version: '3.0',
        manifest: validImageManifest,
        targets: [{ kind: 'canonical', id: 'image' }],
      });
      expect(pinnedThreeZero.adcp_error).toMatchObject({
        code: 'INVALID_REQUEST',
        message: 'Unknown tool: validate_input',
      });
      expect(pinnedThreeZero.adcp_version).toBe('3.0');
    } finally {
      await close();
    }
  });

  it('keeps frozen 3.0 controller directives in the media buy brand session', async () => {
    const { baseUrl, close } = await bootCompatRouter();
    const domain = `compat-controller-${randomUUID()}.example`;
    const account = { brand: { domain }, operator: 'pinnacle-agency.example' };
    try {
      const created = await callTenantTool(baseUrl, 'sales', 'create_media_buy', {
        account,
        brand: { domain },
        start_time: '2099-04-01T00:00:00Z',
        end_time: '2099-06-30T23:59:59Z',
        packages: [{ product_id: 'test-product', pricing_option_id: 'test-pricing', budget: 5000 }],
        idempotency_key: randomUUID(),
      });
      expect(created.adcp_error, JSON.stringify(created)).toBeUndefined();
      expect(created.media_buy_id).toEqual(expect.any(String));

      const completed = await callTenantTool(baseUrl, 'sales', 'comply_test_controller', {
        brand: { domain },
        scenario: 'force_media_buy_status',
        params: { media_buy_id: created.media_buy_id, status: 'completed' },
      });
      expect(completed).toMatchObject({ success: true, current_state: 'completed' });

      const rejected = await callTenantTool(baseUrl, 'sales', 'comply_test_controller', {
        brand: { domain },
        scenario: 'force_media_buy_status',
        params: { media_buy_id: created.media_buy_id, status: 'active' },
      });
      expect(rejected).toMatchObject({ success: false, error: 'INVALID_TRANSITION' });
    } finally {
      await close();
    }
  });

  it('builds a frozen 3.0 creative from the natural-account library session', async () => {
    const { baseUrl, close } = await bootCompatRouter();
    const domain = `compat-creative-${randomUUID()}.example`;
    const account = { brand: { domain }, operator: 'pinnacle-agency.example' };
    const creativeId = `compat_video_${randomUUID()}`;
    try {
      const synced = await callTenantTool(baseUrl, 'creative', 'sync_creatives', {
        account,
        creatives: [{
          creative_id: creativeId,
          name: 'Compatibility video',
          format_id: { agent_url: 'https://creative-platform.example', id: 'video_30s' },
          assets: {
            video: {
              asset_type: 'video',
              url: 'https://cdn.pinnacle-agency.example/compat-video.mp4',
              width: 1920,
              height: 1080,
              duration_ms: 30000,
              mime_type: 'video/mp4',
            },
          },
        }],
        idempotency_key: randomUUID(),
      });
      expect(synced.adcp_error, JSON.stringify(synced)).toBeUndefined();

      const built = await callTenantTool(baseUrl, 'creative', 'build_creative', {
        account,
        creative_id: creativeId,
        target_format_id: { agent_url: 'https://creative-platform.example', id: 'vast_30s' },
        idempotency_key: randomUUID(),
      });
      expect(built.adcp_error, JSON.stringify(built)).toBeUndefined();
      expect(built.status).toBe('completed');
      expect(built.creative_manifest).toEqual(expect.any(Object));
    } finally {
      await close();
    }
  });

  it('keeps opaque account IDs isolated on the frozen 3.0 sales surface', async () => {
    const { baseUrl, close } = await bootCompatRouter();
    const suffix = randomUUID();
    const accountA = { account_id: `compat_opaque_a_${suffix}` };
    const accountB = { account_id: `compat_opaque_b_${suffix}` };
    try {
      const created = await callTenantTool(baseUrl, 'sales', 'create_media_buy', {
        account: accountA,
        start_time: '2099-04-01T00:00:00Z',
        end_time: '2099-06-30T23:59:59Z',
        packages: [{ product_id: 'test-product', pricing_option_id: 'test-pricing', budget: 5000 }],
        idempotency_key: randomUUID(),
      });
      expect(created.adcp_error, JSON.stringify(created)).toBeUndefined();

      const crossAccount = await callTenantTool(baseUrl, 'sales', 'comply_test_controller', {
        account: accountB,
        scenario: 'force_media_buy_status',
        params: { media_buy_id: created.media_buy_id, status: 'active' },
      });
      expect(crossAccount).toMatchObject({ success: false, error: 'NOT_FOUND' });

      const owningAccount = await callTenantTool(baseUrl, 'sales', 'comply_test_controller', {
        account: accountA,
        scenario: 'force_media_buy_status',
        params: { media_buy_id: created.media_buy_id, status: 'active' },
      });
      expect(owningAccount).toMatchObject({ success: true, current_state: 'active' });
    } finally {
      await close();
    }
  });

  it('projects frozen 3.0 natural-account fixtures into the legacy brand session', async () => {
    const { baseUrl, close } = await bootCompatRouter();
    const domain = `compat-fixture-${randomUUID()}.example`;
    const seedAccount = { brand: { domain }, operator: domain, sandbox: true };
    const buyerAccount = { brand: { domain }, operator: 'pinnacle-agency.example', sandbox: true };
    const productId = `compat_product_${randomUUID()}`;
    const pricingOptionId = `compat_price_${randomUUID()}`;
    try {
      const seededProduct = await callTenantTool(baseUrl, 'sales', 'comply_test_controller', {
        account: seedAccount,
        scenario: 'seed_product',
        params: {
          product_id: productId,
          fixture: { delivery_type: 'non_guaranteed', channels: ['display'] },
        },
      });
      expect(seededProduct.success, JSON.stringify(seededProduct)).toBe(true);

      const seededPricing = await callTenantTool(baseUrl, 'sales', 'comply_test_controller', {
        account: seedAccount,
        scenario: 'seed_pricing_option',
        params: {
          product_id: productId,
          pricing_option_id: pricingOptionId,
          fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 5 },
        },
      });
      expect(seededPricing.success, JSON.stringify(seededPricing)).toBe(true);

      const created = await callTenantTool(baseUrl, 'sales', 'create_media_buy', {
        account: buyerAccount,
        brand: { domain },
        start_time: '2099-04-01T00:00:00Z',
        end_time: '2099-06-30T23:59:59Z',
        packages: [{ product_id: productId, pricing_option_id: pricingOptionId, bid_price: 8, budget: 5000 }],
        idempotency_key: randomUUID(),
      });
      expect(created.adcp_error, JSON.stringify(created)).toBeUndefined();
      expect(created.media_buy_id).toEqual(expect.any(String));
    } finally {
      await close();
    }
  });
});
