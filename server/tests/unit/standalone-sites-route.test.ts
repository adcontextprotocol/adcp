import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { HTTPServer } from '../../src/http.js';

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

describe('standalone standard sites (real server)', () => {
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

  function app() {
    server = new HTTPServer();
    return (server as unknown as { app: unknown }).app;
  }

  it('serves the brandjson.org landing page with neutral-chrome marker', async () => {
    const res = await request(app()).get('/').set('Host', 'brandjson.org');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<link rel="canonical" href="https://brandjson.org/">');
    expect(res.text).toContain('window.__ADCP_SITE__="brandjson"');
  });

  it('serves the builder at brandjson.org/builder', async () => {
    const res = await request(app()).get('/builder?domain=acme.example').set('Host', 'brandjson.org');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="host-with-aao-btn"');
    expect(res.text).toContain('window.__ADCP_SITE__="brandjson"');
  });

  it('does not expose the AAO app on brandjson.org', async () => {
    const res = await request(app()).get('/dashboard').set('Host', 'brandjson.org');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://agenticadvertising.org/dashboard');
  });

  it('redirects www.brandjson.org to the apex', async () => {
    const res = await request(app()).get('/builder').set('Host', 'www.brandjson.org');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://brandjson.org/builder');
  });

  it('serves the trustjson.org landing page and 404s app paths', async () => {
    const landing = await request(app()).get('/').set('Host', 'trustjson.org');
    expect(landing.status).toBe(200);
    expect(landing.text).toContain('window.__ADCP_SITE__="trustjson"');
    const other = await request(app()).get('/registry').set('Host', 'trustjson.org');
    expect(other.status).toBe(404);
  });

  it('leaves agenticadvertising.org pages without the standalone marker', async () => {
    const res = await request(app()).get('/brand/builder').set('Host', 'agenticadvertising.org');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('window.__ADCP_SITE__=');
  });
});
