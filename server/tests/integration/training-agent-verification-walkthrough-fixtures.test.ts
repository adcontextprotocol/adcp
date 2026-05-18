/**
 * Integration test for the verification-walkthrough fixture documents. Three
 * brand.json variants + one adagents.json forming the bilateral mutual-
 * assertion chain documented at `docs/verification/overview`. Each fixture
 * is validated against the canonical schema with Ajv, and the cross-document
 * bilateral invariants are spot-checked end-to-end.
 *
 * What the walkthrough's steps depend on:
 *   - step 2: northwind brand.json is fetchable, names its signing JWKS
 *   - step 3: streamhaus adagents.json authorizes northwind with
 *     delegation_type "delegated" and names the signing key by kid
 *   - step 4: streamhaus brand.json declares house_domain, sportshaus
 *     brand.json reciprocates with a matching brand_refs[] entry (bilateral
 *     parent/sub-brand assertion)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-for-walkthrough-fixtures';
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

async function compileSchema(schemaPath: string) {
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
  const schema = JSON.parse(readFileSync(join(SCHEMA_BASE_DIR, schemaPath), 'utf8'));
  return ajv.compileAsync(schema);
}

function explainErrors(errors: Ajv['errors']) {
  return (errors ?? [])
    .map(e => `${e.instancePath || '(root)'}: ${e.message}`)
    .join('; ');
}

describe('Verification-walkthrough fixtures', () => {
  let app: express.Application;
  let validateBrand: Awaited<ReturnType<typeof compileSchema>>;
  let validateAdagents: Awaited<ReturnType<typeof compileSchema>>;

  async function fetchFixture(path: string): Promise<Record<string, unknown>> {
    const res = await request(app)
      .get(`/api/training-agent${path}`)
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https');
    expect(res.status, `GET ${path}`).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    return res.body;
  }

  beforeAll(async () => {
    app = express();
    app.use('/api/training-agent', createTrainingAgentRouter());
    validateBrand = await compileSchema('brand.json');
    validateAdagents = await compileSchema('adagents.json');
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  it("northwind brand.json validates and names a signing JWKS", async () => {
    const body = await fetchFixture('/fixtures/walkthrough/northwind/.well-known/brand.json');
    const ok = validateBrand(body);
    if (!ok) throw new Error(`northwind brand.json invalid: ${explainErrors(validateBrand.errors)}`);

    expect(body.id).toBe('northwind_media');
    expect(body.url).toBe('https://northwind.example');
    expect(body.house_domain).toBeUndefined();   // standalone agency, no parent
    const agents = body.agents as Array<Record<string, string>>;
    expect(agents[0].type).toBe('sales');
    expect(agents[0].jwks_uri).toBe('https://northwind.example/.well-known/jwks.json');
  });

  it('streamhaus brand.json validates and declares the parent house_domain', async () => {
    const body = await fetchFixture('/fixtures/walkthrough/streamhaus/.well-known/brand.json');
    const ok = validateBrand(body);
    if (!ok) throw new Error(`streamhaus brand.json invalid: ${explainErrors(validateBrand.errors)}`);

    expect(body.id).toBe('streamhaus');
    expect(body.house_domain).toBe('sportshaus-holdings.example');
    expect(body.keller_type).toBe('endorsed');
  });

  it('sportshaus-holdings brand.json validates and reciprocates streamhaus', async () => {
    const body = await fetchFixture('/fixtures/walkthrough/sportshaus-holdings/.well-known/brand.json');
    const ok = validateBrand(body);
    if (!ok) throw new Error(`sportshaus brand.json invalid: ${explainErrors(validateBrand.errors)}`);

    const house = body.house as Record<string, string>;
    expect(house.domain).toBe('sportshaus-holdings.example');
    const refs = body.brand_refs as Array<Record<string, string>>;
    const streamhausRef = refs.find(r => r.domain === 'streamhaus.example');
    expect(streamhausRef).toBeDefined();
    expect(streamhausRef?.brand_id).toBe('streamhaus');
  });

  it("streamhaus adagents.json validates and authorizes northwind by delegation_type", async () => {
    const body = await fetchFixture('/fixtures/walkthrough/streamhaus/.well-known/adagents.json');
    const ok = validateAdagents(body);
    if (!ok) throw new Error(`streamhaus adagents.json invalid: ${explainErrors(validateAdagents.errors)}`);

    const agents = body.authorized_agents as Array<Record<string, unknown>>;
    const northwindEntry = agents.find(a => new URL(a.url as string).hostname === 'northwind.example');
    expect(northwindEntry).toBeDefined();
    expect(northwindEntry?.delegation_type).toBe('delegated');
    expect(northwindEntry?.authorization_type).toBe('property_ids');
    expect(northwindEntry?.property_ids).toEqual(['streamhaus_ctv']);
  });

  it('bilateral parent / sub-brand assertion closes (streamhaus ↔ sportshaus-holdings)', async () => {
    const child = await fetchFixture('/fixtures/walkthrough/streamhaus/.well-known/brand.json');
    const parent = await fetchFixture('/fixtures/walkthrough/sportshaus-holdings/.well-known/brand.json');

    const childHouseDomain = child.house_domain as string;
    const parentHouse = parent.house as { domain: string };
    expect(childHouseDomain).toBe(parentHouse.domain);

    const refs = parent.brand_refs as Array<{ domain: string; brand_id: string }>;
    const matchingRef = refs.find(r => r.domain === (new URL(child.url as string).hostname));
    expect(matchingRef, 'parent brand_refs[] must include the child by domain').toBeDefined();
    expect(matchingRef?.brand_id).toBe(child.id);
  });

  it('caches with public max-age=300 and Vary on forwarding headers', async () => {
    const res = await request(app)
      .get('/api/training-agent/fixtures/walkthrough/northwind/.well-known/brand.json')
      .set('Host', 'test-agent.example.org')
      .set('X-Forwarded-Proto', 'https');

    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['vary']).toMatch(/X-Forwarded-Host/i);
    expect(res.headers['vary']).toMatch(/X-Forwarded-Proto/i);
  });
});
