import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const AGENT_URL = 'https://sales.example.com/mcp';

vi.mock('../../src/db/agent-snapshot-db.js', () => ({
  AgentSnapshotDatabase: class {
    bulkGetCapabilities() {
      return Promise.resolve(new Map([[AGENT_URL, {
        discovered_tools_json: Array.from({ length: 5 }, (_, index) => `stale_tool_${index}`),
        inferred_type: 'sales',
      }]]));
    }

    bulkGetHealth() {
      return Promise.resolve(new Map([[AGENT_URL, {
        online: true,
        checked_at: new Date('2026-08-08T00:00:00Z'),
        tools_count: 10,
      }]]));
    }
  },
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function buildApp(): express.Express {
  const app = express();
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();
  const config = {
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {
      getFederatedIndex: () => ({
        listAllAgents: vi.fn().mockResolvedValue([{
          name: 'Example Sales Agent',
          url: AGENT_URL,
          type: 'sales',
          protocol: 'mcp',
        }]),
      }),
    } as unknown as RegistryApiConfig['crawler'],
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

describe('public registry tool count enrichment', () => {
  it('uses the fresher health count for legacy capability consumers', async () => {
    const response = await request(buildApp())
      .get('/api/registry/agents?health=true&capabilities=true');

    expect(response.status).toBe(200);
    expect(response.body.agents[0]).toMatchObject({
      health: { tools_count: 10 },
      capabilities: { tools_count: 10 },
    });
  });
});
