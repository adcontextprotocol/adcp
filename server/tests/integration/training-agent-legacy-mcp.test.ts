/**
 * Legacy `/api/training-agent/mcp` route — back-compat alias to the v5
 * single-URL training agent. Mounted alongside the per-tenant routes so
 * existing AAO entries, Sage/Addie configs, docs, and external storyboard
 * runners keep working while references migrate to per-tenant URLs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.hoisted(() => {
  process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token-for-legacy-mcp';
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const { stopSessionCleanup } = await import('../../src/training-agent/state.js');

const AUTH = 'Bearer test-token-for-legacy-mcp';

describe('Training Agent legacy /mcp back-compat alias', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/training-agent', createTrainingAgentRouter());
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  it('serves tools/list on /api/training-agent/mcp', async () => {
    const res = await request(app)
      .post('/api/training-agent/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const tools = (res.body.result?.tools ?? []) as Array<{ name: string }>;
    // v5 monolith advertises every tool on one URL — confirm a sampling
    // from each specialism shows up.
    const names = new Set(tools.map(t => t.name));
    expect(names.has('get_signals')).toBe(true);
    expect(names.has('get_products')).toBe(true);
    expect(names.has('list_creative_formats')).toBe(true);
  });

  it('emits Deprecation header to nudge callers toward per-tenant URLs', async () => {
    const res = await request(app)
      .post('/api/training-agent/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['link']).toContain('successor-version');
  });

  it('rejects unauthenticated requests with 401 + WWW-Authenticate', async () => {
    const res = await request(app)
      .post('/api/training-agent/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('returns 405 on GET with Allow: POST, OPTIONS', async () => {
    const res = await request(app).get('/api/training-agent/mcp');
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('POST, OPTIONS');
  });

  it('returns 204 on OPTIONS preflight with CORS headers', async () => {
    const res = await request(app).options('/api/training-agent/mcp');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

/**
 * Host-based dispatch — `test-agent.adcontextprotocol.org/<tenant>/mcp`
 * production routing. The training-agent router is mounted both at
 * `/api/training-agent` (legacy path) AND directly on the canonical
 * hostname (host-based dispatch in `http.ts:1214`). Tenant resolution
 * must work for both.
 */
describe('Tenant routes via host-based dispatch (no /api/training-agent prefix)', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // Simulate `test-agent.adcontextprotocol.org/<path>` routing — the
    // router is mounted at root.
    app.use('/', createTrainingAgentRouter());
  });

  afterAll(() => {
    stopSessionCleanup();
  });

  it('routes /sales/mcp to the sales tenant', async () => {
    const res = await request(app)
      .post('/sales/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const tools = (res.body.result?.tools ?? []) as Array<{ name: string }>;
    const names = new Set(tools.map(t => t.name));
    // Sales tenant carries the media-buy tools.
    expect(names.has('get_products')).toBe(true);
    expect(names.has('create_media_buy')).toBe(true);
  });

  it('routes /signals/mcp to the signals tenant', async () => {
    const res = await request(app)
      .post('/signals/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const tools = (res.body.result?.tools ?? []) as Array<{ name: string }>;
    const names = new Set(tools.map(t => t.name));
    expect(names.has('get_signals')).toBe(true);
    expect(names.has('activate_signal')).toBe(true);
  });

  it('exposes all six tenants via _training_agent_tenants in adagents.json', async () => {
    const res = await request(app).get('/.well-known/adagents.json');
    expect(res.status).toBe(200);
    const body = res.body as {
      authorized_agents: Array<{ url: string; authorization_type: string }>;
      _training_agent_tenants: Array<{
        tenant_id: string;
        url: string;
        specialisms: string[];
        tools: string[];
      }>;
    };
    // Schema-conformant authorized_agents covers sales (inline_properties)
    // and signals (signal_tags). Other tenants surface via the extension.
    expect(body.authorized_agents.find(a => a.url.endsWith('/sales/mcp'))?.authorization_type).toBe('inline_properties');
    expect(body.authorized_agents.find(a => a.url.endsWith('/signals/mcp'))?.authorization_type).toBe('signal_tags');
    // Discovery extension lists every tenant with its specialism declaration.
    const ids = body._training_agent_tenants.map(t => t.tenant_id).sort();
    expect(ids).toEqual(['brand', 'creative', 'creative-builder', 'governance', 'sales', 'signals']);
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'brand')?.specialisms).toContain('brand-rights');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'governance')?.specialisms).toContain('content-standards');
    // Tools surface so a developer can pick the right URL without trial.
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'sales')?.tools).toContain('get_products');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'signals')?.tools).toContain('get_signals');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'creative-builder')?.tools).toContain('build_creative');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'creative-builder')?.tools).not.toContain('list_creatives');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'governance')?.tools).toContain('check_governance');
  });

  it('routes /brand/mcp to the brand tenant', async () => {
    const res = await request(app)
      .post('/brand/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    const tools = (res.body.result?.tools ?? []) as Array<{ name: string }>;
    const names = new Set(tools.map(t => t.name));
    expect(names.has('get_brand_identity')).toBe(true);
  });
});
