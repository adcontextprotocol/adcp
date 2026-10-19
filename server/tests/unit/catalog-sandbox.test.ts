import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { queryMock, getClientMock, writeMock } = vi.hoisted(() => ({
  queryMock: vi.fn(), getClientMock: vi.fn(), writeMock: vi.fn(),
}));
vi.mock('../../src/db/client.js', () => ({ query: queryMock, getClient: getClientMock }));
vi.mock('../../src/services/tranco-ingestion.js', () => ({ isTrancoLoaded: () => false }));

import { CatalogDatabase } from '../../src/db/catalog-db.js';
import { createCatalogApiRouter } from '../../src/routes/catalog-api.js';

const provenance = { type: 'agency_allowlist' } as const;
const identifiers = [{ type: 'domain', value: 'publisher.example' }];

function buildApp(authenticated = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated) req.user = { id: 'test_user', email: 'buyer@pinnacle.example' } as typeof req.user;
    next();
  });
  app.use('/api/registry', createCatalogApiRouter({}));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
  writeMock.mockResolvedValue({ rows: [] });
  getClientMock.mockResolvedValue({ query: writeMock, release: vi.fn() });
});

describe('sandbox contributions', () => {
  it('returns existing catalog handles without recording sandbox demand activity', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{
      identifier_type: 'domain', identifier_value: 'publisher.com',
      property_rid: 'existing_property', classification: 'property', source: 'authoritative',
    }] });
    const result = await new CatalogDatabase().resolveIdentifiers(
      [{ type: 'domain', value: 'publisher.com' }], 'resolve', 'test_user', provenance, { sandbox: true },
    );
    expect(result).toMatchObject({ sandbox: true, summary: { created: 0, resolved: 1 } });
    expect(result.resolved[0]).toMatchObject({ property_rid: 'existing_property', status: 'existing' });
    expect(getClientMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true);
  });

  it('simulates new identifiers without acquiring a write connection', async () => {
    const db = new CatalogDatabase();
    const result = await db.resolveIdentifiers(identifiers, 'resolve', 'test_user', provenance, { sandbox: true });
    expect(result).toMatchObject({ sandbox: true, summary: { created: 1, total: 1 } });
    expect(result.resolved[0]).toMatchObject({ identifier: identifiers[0], status: 'created' });
    expect(result.resolved[0].property_rid).toBeTruthy();
    expect(getClientMock).not.toHaveBeenCalled();
    expect(queryMock.mock.calls.every(([sql]) => sql.trimStart().startsWith('SELECT'))).toBe(true);
  });

  it('keeps normal resolve writes enabled and lookup writes disabled', async () => {
    const db = new CatalogDatabase();
    await db.resolveIdentifiers([{ type: 'domain', value: 'publisher.com' }], 'resolve', 'test_user', provenance);
    expect(getClientMock).toHaveBeenCalledOnce();
    expect(writeMock.mock.calls.some(([sql]) => sql.includes('INSERT INTO catalog_properties'))).toBe(true);
    getClientMock.mockClear();
    await db.resolveIdentifiers(identifiers, 'lookup', 'test_user', provenance);
    expect(getClientMock).not.toHaveBeenCalled();
  });

  it('wires the HTTP sandbox flag to the no-write path', async () => {
    const response = await request(buildApp()).post('/api/registry/resolve').send({ identifiers, provenance, sandbox: true });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ sandbox: true, summary: { created: 1 } });
    expect(getClientMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed or reserved member before any batch lookup or write', async () => {
    for (const value of ['publisher.example', 'https://publisher.com/path', 'publisher.com\n']) {
      const response = await request(buildApp()).post('/api/registry/resolve').send({
        identifiers: [{ type: 'domain', value: 'publisher.com' }, { type: 'domain', value }], provenance,
      });
      expect(response.status).toBe(400);
      expect(response.body.details[0].path).toEqual(['identifiers', 1, 'value']);
    }
    expect(queryMock).not.toHaveBeenCalled();
    expect(getClientMock).not.toHaveBeenCalled();
  });

  it('requires authentication for sandbox resolve, while sandbox lookup stays public', async () => {
    const app = buildApp(false);
    const body = { identifiers, provenance, sandbox: true };
    expect((await request(app).post('/api/registry/resolve').send(body)).status).toBe(401);
    expect((await request(app).post('/api/registry/resolve').send({ ...body, mode: 'lookup' })).status).toBe(200);
    expect(getClientMock).not.toHaveBeenCalled();
  });
});
