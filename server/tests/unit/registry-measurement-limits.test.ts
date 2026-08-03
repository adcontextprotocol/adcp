import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.hoisted(() => {
  process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY ?? 'sk_test';
  process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID ?? 'client_test';
});

vi.mock('../../src/db/agent-snapshot-db.js', () => ({
  AgentSnapshotDatabase: vi.fn().mockImplementation(() => ({
    filterMeasurementAgents: vi.fn().mockResolvedValue(new Set()),
    bulkGetHealth: vi.fn().mockResolvedValue(null),
    bulkGetCapabilities: vi.fn().mockResolvedValue(null),
  })),
}));

import { createRegistryApiRouter, type RegistryApiConfig } from '../../src/routes/registry-api.js';

function makeApp(): express.Express {
  const app = express();
  const passAuth: import('express').RequestHandler = (_req, _res, next) => next();
  const config: RegistryApiConfig = {
    brandManager: {} as RegistryApiConfig['brandManager'],
    brandDb: {} as RegistryApiConfig['brandDb'],
    propertyDb: {} as RegistryApiConfig['propertyDb'],
    adagentsManager: {} as RegistryApiConfig['adagentsManager'],
    healthChecker: {} as RegistryApiConfig['healthChecker'],
    crawler: {
      getFederatedIndex: () => ({ listAllAgents: vi.fn().mockResolvedValue([]) }),
    } as unknown as RegistryApiConfig['crawler'],
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

describe('GET /api/registry/agents — measurement filter limits', () => {
  it('rejects when metric_id count exceeds 20', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `metric_${i}`);
    const qs = ids.map(id => `metric_id=${encodeURIComponent(id)}`).join('&');
    const res = await request(makeApp()).get(`/api/registry/agents?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metric_id.*21.*maximum is 20/i);
  });

  it('rejects when accreditation count exceeds 20', async () => {
    const bodies = Array.from({ length: 21 }, (_, i) => `ORG_${i}`);
    const qs = bodies.map(b => `accreditation=${encodeURIComponent(b)}`).join('&');
    const res = await request(makeApp()).get(`/api/registry/agents?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/accreditation.*21.*maximum is 20/i);
  });

  it('rejects when metric_id × accreditation cross-product exceeds 100 pairs', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `metric_${i}`);
    const bodies = Array.from({ length: 10 }, (_, i) => `ORG_${i}`);
    const qs = [
      ...ids.map(id => `metric_id=${encodeURIComponent(id)}`),
      ...bodies.map(b => `accreditation=${encodeURIComponent(b)}`),
    ].join('&');
    const res = await request(makeApp()).get(`/api/registry/agents?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cross-product.*11 × 10 = 110.*100-pair limit/i);
  });

  it('duplicate metric_id values are deduplicated and do not consume the pair budget', async () => {
    // Send 11 copies of the same metric_id + 10 distinct accreditations.
    // After dedup: 1 × 10 = 10 pairs — well within the 100-pair limit.
    // Without dedup this would produce 11 × 10 = 110 pairs and trigger a 400.
    const bodies = Array.from({ length: 10 }, (_, i) => `ORG_${i}`);
    const qs = [
      ...Array.from({ length: 11 }, () => 'metric_id=attention_units'),
      ...bodies.map(b => `accreditation=${encodeURIComponent(b)}`),
    ].join('&');
    const res = await request(makeApp()).get(`/api/registry/agents?${qs}`);
    expect(res.status).not.toBe(400);
  });

  it('accepts a request at the exact per-filter limit (20 each)', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `metric_${i}`);
    const bodies = Array.from({ length: 5 }, (_, i) => `ORG_${i}`);
    const qs = [
      ...ids.map(id => `metric_id=${encodeURIComponent(id)}`),
      ...bodies.map(b => `accreditation=${encodeURIComponent(b)}`),
    ].join('&');
    const res = await request(makeApp()).get(`/api/registry/agents?${qs}`);
    // 20 × 5 = 100 pairs — at the limit, should not 400
    expect(res.status).not.toBe(400);
  });
});
