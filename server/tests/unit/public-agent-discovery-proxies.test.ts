import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const sdkMocks = vi.hoisted(() => ({
  getAdcpCapabilities: vi.fn(),
  listCreativeFormatsLegacy: vi.fn(),
  getProducts: vi.fn(),
  singleExecuteTaskLegacy: vi.fn(),
  clientOptions: [] as unknown[],
}));

vi.mock('@adcp/sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@adcp/sdk');
  return {
    ...actual,
    AdCPClient: class {
      constructor(_agents: unknown, options: unknown) {
        sdkMocks.clientOptions.push(options);
      }
      agent() {
        return {
          getAdcpCapabilities: sdkMocks.getAdcpCapabilities,
          listCreativeFormatsLegacy: sdkMocks.listCreativeFormatsLegacy,
        };
      }
    },
    SingleAgentClient: class {
      constructor(_agent: unknown, options: unknown) {
        sdkMocks.clientOptions.push(options);
      }
      getProducts = sdkMocks.getProducts;
      executeTaskLegacy = sdkMocks.singleExecuteTaskLegacy;
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
    sdkMocks.clientOptions.length = 0;
    app = buildApp();
  });

  it('returns canonical creative capabilities without calling the legacy fallback', async () => {
    const capability = {
      capability_id: 'preview_display',
      operations: ['preview'],
      format: { format_kind: 'image', params: { width: 300, height: 250 } },
    };
    sdkMocks.getAdcpCapabilities.mockResolvedValue({
      data: { creative: { supported_formats: [capability] } },
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://creative.example.com/mcp');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, formats: [capability] });
    expect(sdkMocks.clientOptions[0]).toMatchObject({
      transport: { maxResponseBytes: 1024 * 1024, requestTimeoutMs: 10_000 },
    });
    expect(sdkMocks.listCreativeFormatsLegacy).not.toHaveBeenCalled();
  });

  it('projects legacy list_creative_formats data when canonical capabilities are empty', async () => {
    sdkMocks.getAdcpCapabilities.mockResolvedValue({
      data: { creative: { supported_formats: [] } },
    });
    sdkMocks.listCreativeFormatsLegacy.mockResolvedValue({
      success: true,
      data: {
        formats: [{
          format_id: { agent_url: 'https://creative.example.com', id: 'display_300x250' },
          canonical: { kind: 'image' },
          renders: [{ dimensions: { width: 300, height: 250 } }],
        }],
      },
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://creative.example.com/mcp');

    expect(response.status).toBe(200);
    expect(sdkMocks.listCreativeFormatsLegacy).toHaveBeenCalledWith(
      {},
      undefined,
      { timeout: 10_000 },
    );
    expect(response.body.formats).toEqual([{
      capability_id: 'preview_display_300x250',
      operations: ['preview'],
      format: { format_kind: 'image', params: { width: 300, height: 250 } },
    }]);
  });

  it('projects a 3.1 display catalog without optional canonical annotations', async () => {
    sdkMocks.getAdcpCapabilities.mockResolvedValue({
      data: { creative: { supported_formats: [] } },
    });
    sdkMocks.listCreativeFormatsLegacy.mockResolvedValue({
      success: true,
      data: {
        formats: [{
          format_id: { agent_url: 'https://sales.example.com', id: 'display_300x250' },
          name: 'Medium Rectangle',
          type: 'display',
          assets: [{
            asset_type: 'image',
            requirements: {
              min_width: 300,
              max_width: 300,
              min_height: 250,
              max_height: 250,
            },
          }],
        }],
      },
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://sales.example.com/mcp');

    expect(response.status).toBe(200);
    expect(response.body.formats).toEqual([{
      capability_id: 'preview_display_300x250',
      operations: ['preview'],
      description: 'Medium Rectangle',
      format: { format_kind: 'image', params: { width: 300, height: 250 } },
    }]);
  });

  it('drops hostile legacy format parameters before they reach the registry UI', async () => {
    sdkMocks.getAdcpCapabilities.mockResolvedValue({
      data: { creative: { supported_formats: [] } },
    });
    sdkMocks.listCreativeFormatsLegacy.mockResolvedValue({
      success: true,
      data: {
        formats: [{
          format_id: { agent_url: 'https://creative.example.com', id: 'hostile' },
          canonical: {
            kind: 'image',
            parameters: { min_width: '<img src=x onerror=alert(1)>' },
          },
        }],
      },
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://creative.example.com/mcp');

    expect(response.status).toBe(200);
    expect(response.body.formats).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain('onerror');
  });

  it('returns a gateway error when legacy format discovery fails', async () => {
    sdkMocks.getAdcpCapabilities.mockRejectedValue(new Error('capability discovery failed'));
    sdkMocks.listCreativeFormatsLegacy.mockResolvedValue({
      success: false,
      error: 'legacy discovery failed',
    });

    const response = await request(app).get('/api/public/agent-formats?url=https://creative.example.com/mcp');

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Failed to fetch formats' });
  });

  it('normalizes publisher_domains from list_authorized_properties', async () => {
    sdkMocks.singleExecuteTaskLegacy.mockResolvedValue({
      success: true,
      data: { publisher_domains: ['publisher.example.com'] },
    });

    const response = await request(app).get('/api/public/agent-publishers?url=https://sales.example.com/mcp');

    expect(response.status).toBe(200);
    expect(sdkMocks.singleExecuteTaskLegacy).toHaveBeenCalledWith(
      'list_authorized_properties',
      {},
      undefined,
      { timeout: 10_000 },
    );
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
    sdkMocks.singleExecuteTaskLegacy.mockResolvedValue({
      success: false,
      error: 'publisher discovery failed',
    });

    const response = await request(app).get('/api/public/agent-publishers?url=https://sales.example.com/mcp');

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: 'Failed to fetch publishers' });
  });

  it('strips peer-supplied publisher verification state and unsafe links', async () => {
    sdkMocks.singleExecuteTaskLegacy.mockResolvedValue({
      success: true,
      data: {
        properties: [{
          identifier: 'publisher.example.com',
          domain: 'publisher.example.com',
          type: 'domain',
          verified: true,
          verification_url: 'javascript:alert(1)',
          verification_error: '<img src=x onerror=alert(1)>',
          private_field: 'do not expose',
        }],
      },
    });

    const response = await request(app).get('/api/public/agent-publishers?url=https://sales.example.com/mcp');

    expect(response.status).toBe(200);
    expect(response.body.properties).toEqual([{
      identifier: 'publisher.example.com',
      domain: 'publisher.example.com',
      type: 'domain',
    }]);
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
