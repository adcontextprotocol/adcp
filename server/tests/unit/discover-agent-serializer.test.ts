/**
 * Serializer-shape regression guard for GET /api/public/discover-agent (#4256).
 *
 * Pins two invariants:
 *  1. The response always includes `tools_count` (int) and `tools` (array).
 *  2. `inputSchema` is never leaked — tools are stripped to {name, description}
 *     before serialization, regardless of what getAgentInfo returns.
 *
 * Uses a mock `getAgentInfo` so no live MCP agent or database is required.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ── Hoisted mocks ──────────────────────────────────────────────────────────
// vi.hoisted runs before vi.mock factories — lets factory closures reference
// shared control variables without temporal-dead-zone issues.
const { mockGetAgentInfo } = vi.hoisted(() => {
  // WorkOS initializes at auth.ts module load time; set env vars before any
  // imports so new WorkOS(...) succeeds without a real key.
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
  return { mockGetAgentInfo: vi.fn() };
});

// Mock SingleAgentClient so no live MCP connection is attempted.
vi.mock('@adcp/sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@adcp/sdk');
  return {
    ...actual,
    SingleAgentClient: class {
      getAgentInfo = mockGetAgentInfo;
      getProducts = vi.fn().mockRejectedValue(new Error('not used'));
    },
    CreativeAgentClient: class {
      listFormats = vi.fn().mockResolvedValue([]);
    },
  };
});

// Prevent A2A probe from reaching the network; the try/catch in the handler
// absorbs the rejection — we just want it to resolve cleanly.
vi.mock('@adcp/sdk/testing', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@adcp/sdk/testing');
  return actual;
});

// Stub global fetch so the A2A well-known check returns a non-OK response.
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

// ── App factory ────────────────────────────────────────────────────────────
import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();
  const config = {
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {} as RegistryApiConfig['crawler'],
    capabilityDiscovery: {} as RegistryApiConfig['capabilityDiscovery'],
    registryRequestsDb: {
      trackRequest: async () => {},
      markResolved: async () => true,
    },
    requireAuth: passAuth,
    optionalAuth: passAuth,
  };
  app.use('/api', createRegistryApiRouter(config));
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('GET /api/public/discover-agent — serializer shape (#4256)', () => {
  let app: express.Express;

  beforeEach(() => {
    mockGetAgentInfo.mockReset();
    app = buildApp();
  });

  it('includes tools_count and tools in the response', async () => {
    mockGetAgentInfo.mockResolvedValue({
      name: 'Acme Ad Agent',
      description: 'Sells inventory',
      protocol: 'mcp',
      tools: [
        { name: 'get_products', description: 'List products', inputSchema: { type: 'object', properties: {} } },
        { name: 'list_creative_formats', description: 'List formats', inputSchema: { type: 'object' } },
      ],
    });

    const res = await request(app).get('/api/public/discover-agent?url=https://agent.example.com/');

    expect(res.status).toBe(200);
    expect(typeof res.body.tools_count).toBe('number');
    expect(res.body.tools_count).toBe(2);
    expect(Array.isArray(res.body.tools)).toBe(true);
    expect(res.body.tools).toHaveLength(2);
  });

  it('does not leak inputSchema into the tools array', async () => {
    mockGetAgentInfo.mockResolvedValue({
      name: 'Acme Ad Agent',
      protocol: 'mcp',
      tools: [
        {
          name: 'get_products',
          description: 'List products',
          inputSchema: {
            type: 'object',
            properties: { buying_mode: { type: 'string', enum: ['wholesale', 'retail'] } },
            required: ['buying_mode'],
          },
        },
      ],
    });

    const res = await request(app).get('/api/public/discover-agent?url=https://agent.example.com/');

    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(1);
    const tool = res.body.tools[0];
    expect(tool.name).toBe('get_products');
    expect(tool).not.toHaveProperty('inputSchema');
  });

  it('tools_count matches tools.length when the agent exposes no tools', async () => {
    mockGetAgentInfo.mockResolvedValue({
      name: 'Silent Agent',
      protocol: 'mcp',
      tools: [],
    });

    const res = await request(app).get('/api/public/discover-agent?url=https://agent.example.com/');

    expect(res.status).toBe(200);
    expect(res.body.tools_count).toBe(0);
    expect(res.body.tools).toEqual([]);
  });
});
