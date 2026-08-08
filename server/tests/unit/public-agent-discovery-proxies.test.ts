import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const sdkMocks = vi.hoisted(() => ({
  getAdcpCapabilities: vi.fn(),
  agentExecuteTask: vi.fn(),
  getProducts: vi.fn(),
  singleExecuteTask: vi.fn(),
}));

vi.mock('@adcp/sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@adcp/sdk');
  return {
    ...actual,
    AdCPClient: class {
      agent() {
        return {
          getAdcpCapabilities: sdkMocks.getAdcpCapabilities,
          executeTask: sdkMocks.agentExecuteTask,
        };
      }
    },
    SingleAgentClient: class {
      getProducts = sdkMocks.getProducts;
      executeTask = sdkMocks.singleExecuteTask;
    },
  };
});

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

describe('public agent discovery proxies', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  it('returns canonical creative capabilities without calling the legacy fallback', async () => {
    const capability = {
      capability_id: 'preview_display',
      operations: ['preview'],
      format: { format_kind: 'display', params: { width: 300, height: 250 } },
    };
    sdkMocks.getAdcpCapabilities.mockResolvedValue({
      data: { creative: { supported_formats: [capability] } },
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://creative.example.com/mcp');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, formats: [capability] });
    expect(sdkMocks.agentExecuteTask).not.toHaveBeenCalled();
  });

  it('projects legacy list_creative_formats data when canonical capabilities are empty', async () => {
    sdkMocks.getAdcpCapabilities.mockResolvedValue({
      data: { creative: { supported_formats: [] } },
    });
    sdkMocks.agentExecuteTask.mockResolvedValue({
      success: true,
      data: {
        formats: [{
          format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
          canonical: { kind: 'display' },
          renders: [{ dimensions: { width: 300, height: 250 } }],
        }],
      },
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://creative.example.com/mcp');

    expect(response.status).toBe(200);
    expect(sdkMocks.agentExecuteTask).toHaveBeenCalledWith('list_creative_formats', {});
    expect(response.body.formats).toEqual([{
      capability_id: 'preview_display_300x250',
      operations: ['preview'],
      format: { format_kind: 'display', params: { width: 300, height: 250 } },
    }]);
  });

  it('returns a gateway error when legacy format discovery fails', async () => {
    sdkMocks.getAdcpCapabilities.mockRejectedValue(new Error('capability discovery failed'));
    sdkMocks.agentExecuteTask.mockResolvedValue({
      success: false,
      error: 'legacy discovery failed',
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://creative.example.com/mcp');

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Failed to fetch formats' });
  });

  it('normalizes publisher_domains from list_authorized_properties', async () => {
    sdkMocks.singleExecuteTask.mockResolvedValue({
      success: true,
      data: { publisher_domains: ['publisher.example.com'] },
    });

    const response = await request(app).get('/api/public/agent-publishers?url=https://sales.example.com/mcp');

    expect(response.status).toBe(200);
    expect(sdkMocks.singleExecuteTask).toHaveBeenCalledWith('list_authorized_properties', {});
    expect(response.body).toEqual({
      success: true,
      properties: [{
        identifier: 'publisher.example.com',
        domain: 'publisher.example.com',
        type: 'domain',
      }],
    });
  });

  it('returns a gateway error when publisher discovery fails', async () => {
    sdkMocks.singleExecuteTask.mockResolvedValue({
      success: false,
      error: 'publisher discovery failed',
    });

    const response = await request(app).get('/api/public/agent-publishers?url=https://sales.example.com/mcp');

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Failed to fetch publishers' });
  });

  it('returns the public product fields consumed by the registry UI', async () => {
    sdkMocks.getProducts.mockResolvedValue({
      data: {
        products: [{
          product_id: 'homepage',
          name: 'Homepage display',
          description: 'Premium placement',
          property_type: 'website',
          property_name: 'Example Publisher',
          pricing_model: 'cpm',
          base_rate: 12,
          currency: 'USD',
          format_options: [],
          private_field: 'do not expose',
        }],
      },
    });

    const response = await request(app).get('/api/public/agent-products?url=https://sales.example.com/mcp');

    expect(response.status).toBe(200);
    expect(response.body.products).toEqual([{
      product_id: 'homepage',
      name: 'Homepage display',
      description: 'Premium placement',
      property_type: 'website',
      property_name: 'Example Publisher',
      pricing_model: 'cpm',
      base_rate: 12,
      currency: 'USD',
      format_options: [],
    }]);
  });
});
