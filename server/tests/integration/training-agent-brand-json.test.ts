/**
 * Integration test for the training agent's `/.well-known/brand.json` discovery
 * endpoint. Asserts schema-conformant shape per
 * `static/schemas/source/brand.json` oneOf[3] (house portfolio variant).
 *
 * What the verification walkthrough at docs/verification/overview depends on:
 *   - schema-conformant brand.json served from a well-known path
 *   - house.agents[] enumerates each tenant with a typed brand_agent_entry
 *     pointing at the tenant's MCP endpoint and the shared JWKS
 *   - brands[] declares at least one brand under the house (variant 4 requires
 *     either brands[] or brand_refs[])
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-for-brand-json';
  // `mcp-resolve-base-url.test.ts` sets BASE_URL='/' and other tests in the
  // same vitest pool may inherit it. We want getBaseUrl(req) to derive
  // proto/host from the request headers, not from a global override.
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

describe('Training Agent /.well-known/brand.json', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/api/training-agent', createTrainingAgentRouter());
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  it('serves a schema-conformant house portfolio brand.json', async () => {
    const res = await request(app)
      .get('/api/training-agent/.well-known/brand.json')
      .set('Host', 'test-agent.example.org');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);

    const body = res.body;
    expect(body.$schema).toBe('/schemas/brand.json');
    expect(body.version).toBe('1.0');

    expect(body.house).toBeDefined();
    expect(body.house.domain).toBe('adcontextprotocol.org');
    expect(body.house.name).toBe('Ad Context Protocol');

    expect(Array.isArray(body.brands)).toBe(true);
    expect(body.brands.length).toBeGreaterThanOrEqual(1);

    const trainingBrand = body.brands.find((b: { id: string }) => b.id === 'adcp_training_agent');
    expect(trainingBrand).toBeDefined();
    expect(trainingBrand.names).toEqual([{ en_US: 'AdCP Training Agent' }]);
    expect(trainingBrand.keller_type).toBe('master');
  });

  it('lists every tenant as a typed brand_agent_entry with shared JWKS', async () => {
    const res = await request(app)
      .get('/api/training-agent/.well-known/brand.json')
      .set('Host', 'test-agent.example.org');

    const agents = res.body.house.agents;
    expect(Array.isArray(agents)).toBe(true);

    const tenants = ['sales', 'signals', 'governance', 'creative', 'creative-builder', 'brand'];
    for (const tenant of tenants) {
      const entry = agents.find((a: { url: string }) => a.url.endsWith(`/${tenant}/mcp`));
      expect(entry, `agents[] entry for tenant=${tenant}`).toBeDefined();
      expect(entry.id).toBe(`aao_training_agent_${tenant.replace(/-/g, '_')}`);
      expect(entry.jwks_uri).toMatch(/\/\.well-known\/jwks\.json$/);
      expect(['sales', 'signals', 'governance', 'creative', 'brand']).toContain(entry.type);
    }
  });

  it('caches with public max-age=300', async () => {
    const res = await request(app)
      .get('/api/training-agent/.well-known/brand.json')
      .set('Host', 'test-agent.example.org');

    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('JWKS pointed to by brand.json agents[] actually resolves', async () => {
    const brandRes = await request(app)
      .get('/api/training-agent/.well-known/brand.json')
      .set('Host', 'test-agent.example.org');

    const jwksUri = brandRes.body.house.agents[0].jwks_uri;
    const jwksPath = new URL(jwksUri).pathname;

    const jwksRes = await request(app)
      .get(jwksPath)
      .set('Host', 'test-agent.example.org');

    expect(jwksRes.status).toBe(200);
    expect(Array.isArray(jwksRes.body.keys)).toBe(true);
    expect(jwksRes.body.keys.length).toBeGreaterThan(0);
  });
});
