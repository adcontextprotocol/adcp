import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdcpError } from '@adcp/sdk/server';

const shared = vi.hoisted(() => ({ runtime: undefined as unknown }));
vi.hoisted(() => {
  process.env.WORKOS_API_KEY = 'sk_test_reporting_routes';
  process.env.WORKOS_CLIENT_ID = 'client_test_reporting_routes';
});
vi.mock('@workos-inc/node', () => ({ WorkOS: class {
  apiKeys = { createValidation: async ({ value }: { value: string }) => ({
    apiKey: value === 'sk_private_reporting' ? { owner: { id: 'private-reader' } } : null,
  }) };
} }));
vi.mock('../../src/training-agent/tenants/router.js', () => ({ mountTenantRoutes: vi.fn() }));
vi.mock('../../src/training-agent/gcs-reporting.js', () => ({ getTrainingGcsReporting: () => shared.runtime }));
import { trainingGcsReportingRouter } from '../../src/training-agent/gcs-reporting-routes.js';
import { createTrainingAgentRouter } from '../../src/training-agent/index.js';

const actor = 'workos:private-reader';
const grant = { principal_id: actor, account_id: 'account-a', destination_ref: 'destination-a', generation: 1 };
const runtime = {
  provision: vi.fn(), grant: vi.fn(), buyerConfiguration: vi.fn(), revoke: vi.fn(), replaceNotifications: vi.fn(),
  service: { capabilities: { supported: true } },
};
const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.locals.trainingPrincipal = actor; next(); });
app.use('/reporting', trainingGcsReportingRouter());
const wiredApp = express();
wiredApp.use(express.json());
wiredApp.use(createTrainingAgentRouter({ disableRateLimit: true }));

describe('private reporting control plane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.runtime = runtime;
    runtime.provision.mockResolvedValue(grant);
    runtime.grant.mockResolvedValue(grant);
    runtime.buyerConfiguration.mockResolvedValue({ expected: { reportDefinitionSha256: 'pinned' } });
  });
  it('binds provisioning to the authenticated actor and marks private grants no-store', async () => {
    const result = await request(app).post('/reporting/destinations').send({ account_id: 'account-a', source_config_id: 'source-a', destination_ref: 'destination-a' });
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(runtime.provision).toHaveBeenCalledWith(actor, 'account-a', 'source-a', 'destination-a');
    expect(result.body.buyer.expected.reportDefinitionSha256).toBe('pinned');
  });
  it('serves the buyer URL through the full training router and authenticates WorkOS ownership', async () => {
    const result = await request(wiredApp).post('/sales/reporting/destinations')
      .set('Authorization', 'Bearer sk_private_reporting')
      .send({ account_id: 'account-a', source_config_id: 'source-a', destination_ref: 'destination-a' });
    expect(result.status).toBe(200);
    expect(runtime.provision).toHaveBeenCalledWith(actor, 'account-a', 'source-a', 'destination-a');
  });
  it('requires authentication at the sales control plane and does not serve an unscoped alias', async () => {
    expect((await request(wiredApp).get('/sales/reporting/destinations/account-a/destination-a')).status).toBe(401);
    expect((await request(wiredApp).get('/reporting/destinations/account-a/destination-a')).status).toBe(404);
    expect(runtime.grant).not.toHaveBeenCalled();
  });
  it.each(['principal_id', 'bucket', 'object_prefix', 'generation', 'credentials'])('refuses caller-selected %s', async field => {
    const result = await request(app).post('/reporting/destinations').send({ account_id: 'account-a', source_config_id: 'source-a', destination_ref: 'destination-a', [field]: 'untrusted' });
    expect(result.status).toBe(400);
    expect(runtime.provision).not.toHaveBeenCalled();
  });
  it('hides unauthorized or revoked grant existence', async () => {
    runtime.grant.mockResolvedValue(null);
    const result = await request(app).get('/reporting/destinations/account-a/destination-a');
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: 'ACCOUNT_NOT_FOUND' });
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('fails closed when disabled or when the provider fails without exposing error details', async () => {
    shared.runtime = undefined;
    expect((await request(app).get('/reporting/destinations/account-a/destination-a')).status).toBe(503);
    shared.runtime = runtime;
    runtime.provision.mockRejectedValue(new Error('provider token=must-not-leak'));
    const result = await request(app).post('/reporting/destinations').send({ account_id: 'account-a', source_config_id: 'source-a', destination_ref: 'destination-a' });
    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('must-not-leak');
  });
  it('preserves safe typed authorization failures', async () => {
    runtime.provision.mockRejectedValue(new AdcpError('ACCOUNT_NOT_FOUND', { message: 'Reporting account was not found.' }));
    const result = await request(app).post('/reporting/destinations').send({ account_id: 'account-a', source_config_id: 'source-a', destination_ref: 'destination-a' });
    expect(result.status).toBe(404);
  });
  it('limits notifications to two RFC 9421 endpoints without caller-supplied credentials', async () => {
    const endpoint = { subscriber_id: 'subscriber-a', url: 'https://receiver.example/reporting', event_types: ['reporting.delivery_ready'] };
    expect((await request(app).put('/reporting/notifications/account-a').send([{ ...endpoint, authentication: { mode: 'Bearer', credentials: 'secret' } }])).status).toBe(400);
    expect((await request(app).put('/reporting/notifications/account-a').send([endpoint, endpoint, endpoint])).status).toBe(400);
    expect(runtime.replaceNotifications).not.toHaveBeenCalled();
  });
});
