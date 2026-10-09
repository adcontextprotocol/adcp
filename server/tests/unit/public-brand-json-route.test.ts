import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { HTTPServer } from '../../src/http.js';
import { TRAINING_AGENT_URL } from '../../src/training-agent/config.js';

const ORIGINAL_WORKOS_ENV = vi.hoisted(() => ({
  apiKey: process.env.WORKOS_API_KEY,
  clientId: process.env.WORKOS_CLIENT_ID,
}));

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY || 'sk_test_public_brand_json_route';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || 'client_test_public_brand_json_route';
});

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual('../../src/config.js');
  return {
    ...actual,
    getDatabaseConfig: vi.fn().mockReturnValue({
      connectionString: 'postgresql://localhost/test',
    }),
  };
});

vi.mock('../../src/db/client.js', () => ({
  initializeDatabase: vi.fn(),
  getPool: vi.fn().mockReturnValue({ query: vi.fn() }),
  isDatabaseInitialized: vi.fn().mockReturnValue(true),
  closeDatabase: vi.fn(),
  healthCheck: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/db/migrate.js', () => ({
  runMigrations: vi.fn().mockResolvedValue(undefined),
}));

describe('GET /brands/:domain/brand.json real route', () => {
  let server: HTTPServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (ORIGINAL_WORKOS_ENV.apiKey === undefined) {
      delete process.env.WORKOS_API_KEY;
    } else {
      process.env.WORKOS_API_KEY = ORIGINAL_WORKOS_ENV.apiKey;
    }
    if (ORIGINAL_WORKOS_ENV.clientId === undefined) {
      delete process.env.WORKOS_CLIENT_ID;
    } else {
      process.env.WORKOS_CLIENT_ID = ORIGINAL_WORKOS_ENV.clientId;
    }
  });

  it('strips legacy Brand Context API data from public enriched brand.json responses', async () => {
    server = new HTTPServer();
    const app = (server as unknown as { app: unknown }).app;
    const getDiscoveredBrandByDomain = vi.fn().mockResolvedValue({
      is_public: true,
      source_type: 'enriched',
      brand_manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        colors: { primary: '#123456' },
        brand_context: {
          brand: { voice: { summary: 'Private context should not be public.' } },
          positioning: { value_proposition: 'Private positioning.' },
        },
      },
    });
    (server as unknown as { brandDb: { getDiscoveredBrandByDomain: typeof getDiscoveredBrandByDomain } }).brandDb = {
      getDiscoveredBrandByDomain,
    };

    const res = await request(app).get('/brands/acme.com/brand.json');

    expect(res.status).toBe(200);
    expect(res.headers['x-aao-source']).toBe('enriched');
    expect(res.body).toMatchObject({
      $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json',
      name: 'Acme',
      url: 'https://acme.com',
      colors: { primary: '#123456' },
    });
    expect(res.body.brand_context).toBeUndefined();
  });

  it('does not publish trust fields from rows whose domain control is unproven', async () => {
    server = new HTTPServer();
    const app = (server as unknown as { app: unknown }).app;
    const getDiscoveredBrandByDomain = vi.fn().mockResolvedValue({
      is_public: true,
      source_type: 'community',
      review_status: 'approved',
      brand_manifest: {
        house: {
          domain: 'victim.example',
          name: 'Victim',
          agents: [{ type: 'sales', id: 's', url: 'https://agent.victim.example/mcp', jwks_uri: 'https://attacker.example/jwks.json' }],
        },
        brands: [{ id: 'victim', names: [{ en: 'Victim' }] }],
        authorized_operators: [{ domain: 'attacker.example', brands: ['*'] }],
        brand_refs: [{ domain: 'other.example', brand_id: 'other' }],
      },
    });
    (server as unknown as { brandDb: { getDiscoveredBrandByDomain: typeof getDiscoveredBrandByDomain } }).brandDb = {
      getDiscoveredBrandByDomain,
    };

    const res = await request(app).get('/brands/victim.example/brand.json');

    expect(res.status).toBe(200);
    expect(res.body.authorized_operators).toBeUndefined();
    expect(res.body.brand_refs).toBeUndefined();
    expect(res.body.house.agents).toEqual([{ type: 'sales', id: 's', url: 'https://agent.victim.example/mcp' }]);
    expect(res.body.house.name).toBe('Victim');
  });

  it('publishes trust fields from verified owner-hosted rows', async () => {
    server = new HTTPServer();
    const app = (server as unknown as { app: unknown }).app;
    const manifest = {
      house: { domain: 'owner.example', name: 'Owner' },
      brands: [{ id: 'owner', names: [{ en: 'Owner' }] }],
      authorized_operators: [{ domain: 'agency.example', brands: ['*'] }],
    };
    const getDiscoveredBrandByDomain = vi.fn().mockResolvedValue({
      is_public: true,
      source_type: 'community',
      review_status: 'approved',
      domain_verified: true,
      workos_organization_id: 'org_owner',
      brand_manifest: manifest,
    });
    (server as unknown as { brandDb: { getDiscoveredBrandByDomain: typeof getDiscoveredBrandByDomain } }).brandDb = {
      getDiscoveredBrandByDomain,
    };

    const res = await request(app).get('/brands/owner.example/brand.json');

    expect(res.status).toBe(200);
    expect(res.body.authorized_operators).toEqual(manifest.authorized_operators);
  });

  it('publishes the training agent operator record on its canonical hostname', async () => {
    server = new HTTPServer();
    const app = (server as unknown as { app: unknown }).app;

    const res = await request(app)
      .get('/.well-known/brand.json')
      .set('Host', new URL(TRAINING_AGENT_URL).host);

    expect(res.status).toBe(200);
    expect(res.body.authoritative_location).toBeUndefined();
    expect(res.body.agents).toContainEqual(expect.objectContaining({
      id: 'training_agent',
      url: `${TRAINING_AGENT_URL}/api/training-agent/mcp`,
      jwks_uri: 'https://adcontextprotocol.org/.well-known/jwks.json',
    }));
  });

  it('strips legacy Brand Context API data from discovered brand edit-status responses', async () => {
    server = new HTTPServer();
    const app = (server as unknown as { app: unknown }).app;
    const getDiscoveredBrandByDomain = vi.fn().mockResolvedValue({
      source_type: 'enriched',
      review_status: 'approved',
      brand_name: 'Acme',
      brand_manifest: {
        name: 'Acme',
        url: 'https://acme.com',
        brand_context: {
          identity: { description: 'Private context should not be public.' },
        },
      },
    });
    (server as unknown as { brandDb: { getDiscoveredBrandByDomain: typeof getDiscoveredBrandByDomain } }).brandDb = {
      getDiscoveredBrandByDomain,
    };

    const res = await request(app).get('/api/brands/discovered/acme.com/edit-status');

    expect(res.status).toBe(200);
    expect(res.body.editable).toBe(true);
    expect(res.body.brand_manifest).toEqual({ name: 'Acme', url: 'https://acme.com' });
  });
});
