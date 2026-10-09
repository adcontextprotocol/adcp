/**
 * Registry writes that are not domain-attested must not set brand.json trust
 * fields (agents, keys, authorized_operators, brand_refs), and a hosted-brand
 * create must not replace a row the caller does not own.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  query: mocks.query,
  getClient: mocks.getClient,
}));

import { BrandDatabase, HostedBrandConflictError } from '../../src/db/brand-db.js';

function makeEditClient(current: Record<string, unknown>) {
  const queryFn = vi.fn();
  queryFn
    .mockResolvedValueOnce(undefined) // BEGIN
    .mockResolvedValueOnce(undefined) // advisory lock
    .mockResolvedValueOnce({ rows: [current] }) // SELECT ... FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ next_rev: 2 }] }) // next_rev
    .mockResolvedValueOnce(undefined) // INSERT brand_revisions
    .mockResolvedValueOnce({ rows: [current] }) // UPDATE ... RETURNING *
    .mockResolvedValue(undefined); // COMMIT and anything after
  return { query: queryFn, release: vi.fn() };
}

function persistedManifest(calls: unknown[][]): Record<string, any> {
  const update = calls.find(c => typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE brands SET'));
  expect(update).toBeDefined();
  const values = update![1] as unknown[];
  const json = values.find(v => typeof v === 'string' && v.startsWith('{'));
  return JSON.parse(json as string);
}

describe('editDiscoveredBrand trust fields', () => {
  let db: BrandDatabase;

  beforeEach(() => {
    db = new BrandDatabase();
    mocks.query.mockReset();
    mocks.getClient.mockReset();
  });

  it('ignores authorized_operators and agent keys in a community edit', async () => {
    const client = makeEditClient({
      domain: 'victim.example',
      source_type: 'community',
      review_status: 'approved',
      brand_manifest: { house: { domain: 'victim.example', name: 'Victim' }, brands: [] },
      brand_names: '[]',
      discovered_at: new Date(),
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.editDiscoveredBrand('victim.example', {
      brand_manifest: {
        house: {
          domain: 'victim.example',
          name: 'Victim',
          agents: [{ type: 'sales', id: 'x', url: 'https://agent.attacker.example/mcp', jwks_uri: 'https://attacker.example/jwks.json' }],
        },
        brands: [],
        authorized_operators: [{ domain: 'attacker.example', brands: ['*'] }],
      },
      edit_summary: 'update',
      editor_user_id: 'user_1',
    });

    const manifest = persistedManifest(client.query.mock.calls);
    expect(manifest.authorized_operators).toBeUndefined();
    expect(manifest.house.agents).toBeUndefined();
    expect(manifest.house.name).toBe('Victim');
  });

  it('keeps agents published through the member-profile flow when content is edited', async () => {
    const agents = [{ type: 'sales', id: 'agent_acme_example', url: 'https://agent.acme.example/mcp' }];
    const client = makeEditClient({
      domain: 'acme.example',
      source_type: 'community',
      review_status: 'approved',
      brand_manifest: { agents, description: 'old' },
      brand_names: '[]',
      discovered_at: new Date(),
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.editDiscoveredBrand('acme.example', {
      brand_manifest: { description: 'new' },
      edit_summary: 'update',
      editor_user_id: 'user_1',
    });

    const manifest = persistedManifest(client.query.mock.calls);
    expect(manifest.agents).toEqual(agents);
    expect(manifest.description).toBe('new');
  });
});

describe('createHostedBrand conflicts', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('refuses to replace domain-attested rows or rows claimed by someone else', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const db = new BrandDatabase();

    await expect(db.createHostedBrand({
      brand_domain: 'victim.example',
      brand_json: { house: { domain: 'victim.example' } },
      created_by_user_id: 'user_attacker',
    })).rejects.toBeInstanceOf(HostedBrandConflictError);

    const sql = mocks.query.mock.calls[0][0] as string;
    expect(sql).toContain("brands.source_type = 'brand_json'");
    expect(sql).toContain('brands.domain_verified = true');
    expect(sql).toContain('brands.created_by_user_id = EXCLUDED.created_by_user_id');
    expect(sql).toContain('brands.workos_organization_id = EXCLUDED.workos_organization_id');
    expect(sql).toContain('created_by_user_id = COALESCE(brands.created_by_user_id, EXCLUDED.created_by_user_id)');
  });
});
