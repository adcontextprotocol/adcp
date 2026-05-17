/**
 * Integration test for the training agent's `/.well-known/brand.json` discovery
 * endpoint. Validates against the canonical brand.json schema
 * (`static/schemas/source/brand.json` oneOf[3], house portfolio variant) using
 * Ajv so any future drift between handler and schema fails CI.
 *
 * What the verification walkthrough at docs/verification/overview depends on:
 *   - schema-conformant brand.json served from a well-known path
 *   - house.agents[] enumerates each tenant with a typed brand_agent_entry
 *     pointing at the tenant's MCP endpoint and the shared JWKS
 *   - brands[] declares at least one brand under the house (variant 4 requires
 *     either brands[] or brand_refs[])
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

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

const SCHEMA_BASE_DIR = join(process.cwd(), 'static/schemas/source');

/** Compile the published brand.json schema with $ref resolution against the
 *  local schema tree. Same pattern as `account-handlers.test.ts`. */
async function compileBrandJsonValidator() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async (uri: string) => {
      if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load: ${uri}`);
      const p = join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
      return JSON.parse(readFileSync(p, 'utf8'));
    },
  });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(SCHEMA_BASE_DIR, 'brand.json'), 'utf8'));
  return ajv.compileAsync(schema);
}

describe('Training Agent /.well-known/brand.json', () => {
  let app: express.Application;
  let body: Record<string, unknown>;
  let validate: Awaited<ReturnType<typeof compileBrandJsonValidator>>;

  beforeAll(async () => {
    app = express();
    app.use('/api/training-agent', createTrainingAgentRouter());
    validate = await compileBrandJsonValidator();

    // `X-Forwarded-Proto: https` so URLs in the response match the
    // `^https://` pattern the brand.json schema enforces on
    // brand_agent_entry.url and jwks_uri. Production deployments behind
    // a TLS proxy set this header automatically.
    const res = await request(app)
      .get('/api/training-agent/.well-known/brand.json')
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    body = res.body;
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  it('validates against the published brand.json schema', () => {
    const ok = validate(body);
    if (!ok) {
      const errs = (validate.errors ?? [])
        .map(e => `${e.instancePath || '(root)'}: ${e.message}`)
        .join('; ');
      throw new Error(`brand.json failed schema validation: ${errs}`);
    }
    expect(ok).toBe(true);
  });

  it('serves a house portfolio document with the training-agent brand', () => {
    expect(body.$schema).toBe('/schemas/brand.json');
    expect(body.version).toBe('1.0');

    const house = body.house as Record<string, unknown>;
    expect(house.domain).toBe('adcontextprotocol.org');
    expect(house.name).toBe('Ad Context Protocol');

    const brands = body.brands as Array<Record<string, unknown>>;
    expect(Array.isArray(brands)).toBe(true);
    const trainingBrand = brands.find(b => b.id === 'adcp_training_agent');
    expect(trainingBrand).toBeDefined();
    expect(trainingBrand?.keller_type).toBe('master');
  });

  it('lists every tenant as a typed brand_agent_entry with shared JWKS', () => {
    const house = body.house as { agents: Array<{ id: string; type: string; url: string; jwks_uri: string }> };
    expect(Array.isArray(house.agents)).toBe(true);

    const tenants = ['sales', 'signals', 'governance', 'creative', 'creative-builder', 'brand'];
    for (const tenant of tenants) {
      const entry = house.agents.find(a => a.url.endsWith(`/${tenant}/mcp`));
      expect(entry, `agents[] entry for tenant=${tenant}`).toBeDefined();
      expect(entry?.id).toBe(`aao_training_agent_${tenant.replace(/-/g, '_')}`);
      expect(entry?.jwks_uri).toMatch(/^https:\/\/.+\/\.well-known\/jwks\.json$/);
      expect(['sales', 'signals', 'governance', 'creative', 'brand']).toContain(entry?.type);
    }
  });

  it('caches with public max-age=300 and Vary on forwarding headers', async () => {
    const res = await request(app)
      .get('/api/training-agent/.well-known/brand.json')
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https');

    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['vary']).toMatch(/X-Forwarded-Host/i);
    expect(res.headers['vary']).toMatch(/X-Forwarded-Proto/i);
  });

  it('JWKS pointed to by brand.json agents[] actually resolves', async () => {
    const house = body.house as { agents: Array<{ jwks_uri: string }> };
    const jwksPath = new URL(house.agents[0].jwks_uri).pathname;

    const jwksRes = await request(app)
      .get(jwksPath)
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https');

    expect(jwksRes.status).toBe(200);
    expect(Array.isArray(jwksRes.body.keys)).toBe(true);
    expect(jwksRes.body.keys.length).toBeGreaterThan(0);
  });
});
