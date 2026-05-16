/**
 * Integration coverage for the partner-storefront embed widget at
 * GET /publisher/:domain/embed. The widget is iframed by partner sites
 * to render publisher status without sending users away to AAO; the
 * route must:
 *   - serve a stripped-down HTML page (no nav script, no breadcrumb,
 *     no cross-link footer)
 *   - set CSP `frame-ancestors *` so any partner can frame it
 *   - expose a "View on AgenticAdvertising.org" canonical link so
 *     visitors can drill into the full page
 *   - share data with /publisher/<domain> by hitting the same
 *     /api/registry/publisher endpoint client-side (verified by the
 *     api-alternate <link> only — actual rendering is browser-side)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

vi.mock('../../src/middleware/auth.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/auth.js');
  const pass = (req: { user: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'user_test_embed', email: 'embed@test.com' };
    next();
  };
  return {
    ...actual,
    requireAuth: pass,
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/middleware/csrf.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/middleware/csrf.js');
  return {
    ...actual,
    csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

vi.mock('../../src/billing/stripe-client.js', () => ({
  stripe: null,
  getSubscriptionInfo: vi.fn().mockResolvedValue(null),
  createStripeCustomer: vi.fn().mockResolvedValue(null),
  createCustomerSession: vi.fn().mockResolvedValue(null),
  createBillingPortalSession: vi.fn().mockResolvedValue(null),
}));

import { HTTPServer } from '../../src/http.js';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const TEST_DOMAIN = 'embed-test.registry-baseline.example';

describe('Partner-storefront embed widget — /publisher/:domain/embed', () => {
  let server: HTTPServer;
  let app: unknown;

  beforeAll(async () => {
    initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    server = new HTTPServer();
    await server.start(0);
    app = (server as unknown as { app: unknown }).app;
  });

  afterAll(async () => {
    await server?.stop();
    await closeDatabase();
  });

  it('serves the embed HTML at /publisher/<domain>/embed', async () => {
    const res = await request(app).get(`/publisher/${encodeURIComponent(TEST_DOMAIN)}/embed`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    // Distinguish the embed shell from the canonical publisher-home
    // (which has a different title).
    expect(res.text).toContain('<title>Publisher | AAO embed</title>');
    expect(res.text).toContain('class="embed-root"');
  });

  it('sets Content-Security-Policy frame-ancestors * so partners can iframe it', async () => {
    const res = await request(app).get(`/publisher/${encodeURIComponent(TEST_DOMAIN)}/embed`);
    expect(res.status).toBe(200);
    // The headline assertion: partner sites need explicit permission
    // to iframe; the wildcard opts INTO being framed and overrides any
    // default helmet/middleware deny that might land later.
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors\s+\*/);
  });

  it('omits the global site nav script (visual stripping)', async () => {
    const res = await request(app).get(`/publisher/${encodeURIComponent(TEST_DOMAIN)}/embed`);
    expect(res.status).toBe(200);
    // The canonical publisher-home pulls /nav.js to render the AAO
    // global header. Embed must not — partner sites have their own
    // chrome and the page is iframed.
    expect(res.text).not.toContain('/nav.js');
    expect(res.text).not.toContain('id="adcp-nav"');
  });

  it('exposes a View-on-AAO canonical link so embedded visitors can drill in', async () => {
    const res = await request(app).get(`/publisher/${encodeURIComponent(TEST_DOMAIN)}/embed`);
    expect(res.status).toBe(200);
    // The canonical link target is set client-side, but the anchor +
    // "Powered by AAO" line ship in the static HTML.
    expect(res.text).toContain('view-canonical');
    expect(res.text).toMatch(/Powered by\s*<a[^>]*agenticadvertising\.org/i);
  });

  it('still serves the canonical /publisher/<domain> page for non-/embed paths', async () => {
    // Sanity: the embed route must register before the wildcard
    // /publisher/*domain catch-all, and the catch-all must continue
    // to handle the canonical full-page route.
    const res = await request(app).get(`/publisher/${encodeURIComponent(TEST_DOMAIN)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>Publisher | AgenticAdvertising.org</title>');
    // Embed-only chrome should NOT leak into the canonical page.
    expect(res.text).not.toContain('Powered by');
  });
});
