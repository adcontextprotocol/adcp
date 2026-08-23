/**
 * Legacy `/api/training-agent/mcp` route — back-compat alias to the v5
 * single-URL training agent. Mounted alongside the per-tenant routes so
 * existing AAO entries, Sage/Addie configs, docs, and external storyboard
 * runners keep working while references migrate to per-tenant URLs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { buildCatalog } from '../../src/training-agent/product-factory.js';
import { getCanonicalBase } from '../../src/training-agent/canonical-base.js';

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

  it('isolates stateless MCP task receipts by authenticated principal', async () => {
    const firstBearer = 'Bearer demo-task-owner-v1';
    const secondBearer = 'Bearer demo-task-other-v1';
    const created = await request(app)
      .post('/api/training-agent/mcp')
      .set('Authorization', firstBearer)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'get_products',
          task: { ttl: 60_000 },
          arguments: {
            adcp_version: '3.1-rc.15',
            idempotency_key: `principal-task-${randomUUID()}`,
            account: { brand: { domain: 'task-owner.example' }, operator: 'task-owner.example' },
            buying_mode: 'wholesale',
          },
        },
      });
    expect(created.status).toBe(200);
    const taskId = created.body.result?.task?.taskId as string | undefined;
    expect(taskId).toEqual(expect.any(String));

    const ownList = await request(app)
      .post('/api/training-agent/mcp')
      .set('Authorization', firstBearer)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 21, method: 'tasks/list', params: {} });
    expect(ownList.body.result?.tasks?.map((task: { taskId: string }) => task.taskId)).toContain(taskId);

    const otherList = await request(app)
      .post('/api/training-agent/mcp')
      .set('Authorization', secondBearer)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 22, method: 'tasks/list', params: {} });
    expect(otherList.body.result?.tasks?.map((task: { taskId: string }) => task.taskId) ?? [])
      .not.toContain(taskId);

    const otherGet = await request(app)
      .post('/api/training-agent/mcp')
      .set('Authorization', secondBearer)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 23, method: 'tasks/get', params: { taskId } });
    expect(otherGet.body.error).toBeDefined();
  });

  it('ignores malformed request-signing headers on the public legacy sandbox', async () => {
    const res = await request(app)
      .post('/api/training-agent/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Signature-Input', 'sig1=("@method");created=1;keyid="localhost-dev"')
      .set('Signature', 'sig1=:not-valid-base64:')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_adcp_capabilities', arguments: {} },
      });
    expect(res.status).toBe(200);
    expect(res.body.result?.structuredContent?.request_signing).toMatchObject({
      supported: false,
      required_for: [],
      supported_for: [],
    });
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
    expect(res.headers['access-control-allow-headers']).toContain('Signature-Input');
    expect(res.headers['access-control-allow-headers']).toContain('Signature');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Digest');
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
    expect(names.has('list_products')).toBe(true);
    expect(names.has('buy_products')).toBe(true);
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

  it('exposes all seven tenants via _training_agent_tenants in adagents.json', async () => {
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
    expect(ids).toEqual(['brand', 'creative', 'creative-builder', 'governance', 'sales', 'si', 'signals']);
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'brand')?.specialisms).toContain('brand-rights');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'governance')?.specialisms).toContain('content-standards');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'si')?.specialisms).toContain('sponsored-intelligence');
    // Tools surface so a developer can pick the right URL without trial.
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'sales')?.tools).toContain('list_products');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'signals')?.tools).toContain('get_signals');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'creative-builder')?.tools).toContain('build_creative');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'creative-builder')?.tools).not.toContain('get_products');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'governance')?.tools).toContain('check_governance');
    expect(body._training_agent_tenants.find(t => t.tenant_id === 'si')?.tools).toContain('si_initiate_session');
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

  it('accepts the 3.2 context-only execution shape through the pinned SDK transport overlay', async () => {
    const keyId = createHash('sha256')
      .update('test-token-for-legacy-mcp')
      .digest('hex')
      .slice(0, 32);
    const caller = `https://training-agent.adcontextprotocol.org/authenticated/${keyId}`;
    const planId = `plan-transport-${randomUUID()}`;
    const call = (id: number, name: string, args: Record<string, unknown>) => request(app)
      .post('/governance/mcp')
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

    const synced = await call(10, 'sync_plans', {
      idempotency_key: `sync-${randomUUID()}`,
      plans: [{
        plan_id: planId,
        brand: { domain: 'transport-overlay.example' },
        objectives: 'Prove source-aligned governance transport validation.',
        budget: { total: 1000, currency: 'USD', reallocation_threshold: 1000 },
        flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
      }],
    });
    expect(synced.body.result?.structuredContent?.adcp_error).toBeUndefined();

    const intent = await call(11, 'check_governance', {
      idempotency_key: `intent-${randomUUID()}`,
      plan_id: planId,
      brand: { domain: 'transport-overlay.example' },
      caller,
      target_agent: caller,
      tool: 'create_media_buy',
      payload: {
        total_budget: { amount: 100, currency: 'USD' },
      },
    });
    const context = intent.body.result?.structuredContent?.governance_context;
    expect(context).toEqual(expect.any(String));

    const execution = await call(12, 'check_governance', {
      idempotency_key: `execution-${randomUUID()}`,
      caller,
      governance_context: context,
      phase: 'purchase',
      planned_delivery: { total_budget: 80, currency: 'USD' },
    });
    const body = execution.body.result?.structuredContent;
    expect(body?.adcp_error, JSON.stringify(execution.body)).toBeUndefined();
    expect(body?.verdict).toBe('approved');
    expect(body).not.toHaveProperty('plan_id');
  });

  it('propagates authenticated agent identity through governed service tenants', async () => {
    const keyId = createHash('sha256')
      .update('test-token-for-legacy-mcp')
      .digest('hex')
      .slice(0, 32);
    const caller = `https://training-agent.adcontextprotocol.org/authenticated/${keyId}`;
    const brand = { domain: `governed-transport-${randomUUID()}.example` };
    const account = { brand, operator: brand.domain };
    const planId = `plan-governed-transport-${randomUUID()}`;
    let callId = 20;
    const call = (tenant: string, name: string, args: Record<string, unknown>) => request(app)
      .post(`/${tenant}/mcp`)
      .set('Authorization', AUTH)
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: callId++,
        method: 'tools/call',
        params: { name, arguments: args },
      });

    const synced = await call('governance', 'sync_plans', {
      idempotency_key: `sync-${randomUUID()}`,
      brand,
      plans: [{
        plan_id: planId,
        brand,
        objectives: 'Verify authenticated identity reaches governed service handlers.',
        budget: { total: 10_000, currency: 'USD', reallocation_threshold: 10_000 },
        flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
      }],
    });
    expect(synced.body.result?.structuredContent?.adcp_error, JSON.stringify(synced.body)).toBeUndefined();

    const product = buildCatalog()[0]!.product;
    const salesPayload = {
      idempotency_key: `buy-${randomUUID()}`,
      account,
      brand,
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: product.pricing_options[0]!.pricing_option_id,
        budget: 5_000,
        start_time: '2027-06-01T00:00:00Z',
        end_time: '2027-07-01T00:00:00Z',
      }],
    };
    const salesIntent = await call('governance', 'check_governance', {
      idempotency_key: `check-${randomUUID()}`,
      brand,
      plan_id: planId,
      caller,
      target_agent: `${getCanonicalBase()}/sales`,
      tool: 'create_media_buy',
      payload: salesPayload,
    });
    const salesContext = salesIntent.body.result?.structuredContent?.governance_context;
    expect(salesContext, JSON.stringify(salesIntent.body)).toEqual(expect.any(String));

    const created = await call('sales', 'create_media_buy', {
      ...salesPayload,
      governance_context: salesContext,
    });
    const createdBody = created.body.result?.structuredContent;
    expect(createdBody?.adcp_error, JSON.stringify(created.body)).toBeUndefined();
    expect(createdBody?.media_buy_id).toEqual(expect.any(String));

    const signalPayload = {
      idempotency_key: `signal-${randomUUID()}`,
      account,
      signal_agent_segment_id: 'trident_likely_ev_buyers',
      pricing_option_id: 'po_trident_ev_cpm',
      destinations: [{ type: 'agent', agent_url: 'https://activation-target.example' }],
    };
    const signalIntent = await call('governance', 'check_governance', {
      idempotency_key: `check-${randomUUID()}`,
      brand,
      plan_id: planId,
      caller,
      target_agent: `${getCanonicalBase()}/signals`,
      purchase_type: 'signal_activation',
      proposed_commitment: { amount: 3.5, currency: 'USD' },
      tool: 'activate_signal',
      payload: signalPayload,
    });
    const signalContext = signalIntent.body.result?.structuredContent?.governance_context;
    expect(signalContext, JSON.stringify(signalIntent.body)).toEqual(expect.any(String));

    const activated = await call('signals', 'activate_signal', {
      ...signalPayload,
      governance_context: signalContext,
    });
    const activatedBody = activated.body.result?.structuredContent;
    expect(activatedBody?.adcp_error, JSON.stringify(activated.body)).toBeUndefined();
    expect(activatedBody?.deployments?.[0]?.is_live).toBe(true);

    const rightsCatalog = await call('brand', 'get_rights', {
      buyer: { domain: brand.domain },
      query: 'Sofia Reyes commercial likeness rights',
      uses: ['commercial', 'likeness'],
    });
    const rightsOffering = rightsCatalog.body.result?.structuredContent?.rights?.find(
      (offering: { pricing_options?: Array<{ currency?: string }> }) =>
        offering.pricing_options?.some(option => option.currency === 'USD'),
    );
    expect(rightsOffering?.rights_id, JSON.stringify(rightsCatalog.body)).toEqual(expect.any(String));
    const rightsPricing = rightsOffering?.pricing_options?.find(
      (option: { currency?: string }) => option.currency === 'USD',
    );
    const rightsPayload = {
      idempotency_key: `rights-${randomUUID()}`,
      account,
      rights_id: rightsOffering.rights_id,
      pricing_option_id: rightsPricing.pricing_option_id,
      buyer: { domain: brand.domain },
      campaign: {
        description: 'Approved fitness campaign featuring Sofia Reyes',
        uses: ['likeness', 'commercial'],
        countries: ['US'],
        estimated_impressions: 1_000_000,
        start_date: '2027-06-01',
        end_date: '2027-07-01',
      },
      revocation_webhook: {
        url: `https://${brand.domain}/webhooks/rights-revocation`,
        authentication: { schemes: ['Bearer'], credentials: 'rights-revocation-secret-xxxxxxxxxxxx' },
      },
    };
    const rightsIntent = await call('governance', 'check_governance', {
      idempotency_key: `check-${randomUUID()}`,
      brand,
      plan_id: planId,
      caller,
      target_agent: `${getCanonicalBase()}/brand`,
      purchase_type: 'rights_license',
      proposed_commitment: { amount: 10_000, currency: 'USD' },
      tool: 'acquire_rights',
      payload: rightsPayload,
    });
    const rightsContext = rightsIntent.body.result?.structuredContent?.governance_context;
    expect(rightsContext, JSON.stringify(rightsIntent.body)).toEqual(expect.any(String));
    const acquired = await call('brand', 'acquire_rights', {
      ...rightsPayload,
      governance_context: rightsContext,
    });
    expect(acquired.body.result?.structuredContent?.rights_status, JSON.stringify(acquired.body)).toBe('acquired');

    const transformers = await call('creative-builder', 'list_transformers', {
      account,
      include_pricing: true,
    });
    const transformer = transformers.body.result?.structuredContent?.transformers?.[0];
    const transformerPricing = transformer?.pricing_options?.[0];
    expect(transformer?.transformer_id, JSON.stringify(transformers.body)).toEqual(expect.any(String));
    expect(transformerPricing?.unit_price).toBeGreaterThan(0);
    const creativePayload = {
      idempotency_key: `creative-${randomUUID()}`,
      account,
      mode: 'execute',
      transformer_id: transformer.transformer_id,
      target_capability_id: transformer.output_capability_ids[0],
      message: 'Produce an approved 30-second campaign voiceover.',
    };
    const creativeIntent = await call('governance', 'check_governance', {
      idempotency_key: `check-${randomUUID()}`,
      brand,
      plan_id: planId,
      caller,
      target_agent: `${getCanonicalBase()}/creative-builder`,
      purchase_type: 'creative_services',
      proposed_commitment: {
        amount: 10_000,
        currency: 'USD',
      },
      tool: 'build_creative',
      payload: creativePayload,
    });
    const creativeContext = creativeIntent.body.result?.structuredContent?.governance_context;
    expect(creativeContext, JSON.stringify(creativeIntent.body)).toEqual(expect.any(String));
    const built = await call('creative-builder', 'build_creative', {
      ...creativePayload,
      governance_context: creativeContext,
    });
    const builtBody = built.body.result?.structuredContent;
    expect(builtBody?.errors, JSON.stringify(built.body)).toBeUndefined();
    expect(builtBody?.creative_manifest).toBeDefined();
    expect(builtBody?.build_variant_id).toEqual(expect.any(String));
  });

  it('returns signing headers on tenant OPTIONS preflight', async () => {
    const res = await request(app).options('/sales/mcp');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toContain('Signature-Input');
    expect(res.headers['access-control-allow-headers']).toContain('Signature');
    expect(res.headers['access-control-allow-headers']).toContain('Content-Digest');
  });
});
