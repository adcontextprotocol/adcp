/**
 * Every write into `*_revisions.snapshot` goes through the allowlist, so a
 * credential or contact column on the registry row never reaches the history
 * table in the first place.
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

import { PropertyDatabase } from '../../src/db/property-db.js';
import { BrandDatabase } from '../../src/db/brand-db.js';

const SECRET_COLUMNS = {
  claim_token: 'claim_tok_live',
  verification_token: 'verify_tok_live',
  workos_organization_id: 'org_01OWNER',
  claimant_org_id: 'org_01CLAIMANT',
  created_by_user_id: 'user_01CREATOR',
  created_by_email: 'owner@example.com',
};

const PROPERTY_ROW = {
  id: 'prop_01',
  publisher_domain: 'news.example',
  adagents_json: { authorized_agents: [] },
  source_type: 'community',
  review_status: 'approved',
  is_public: true,
  domain_verified: false,
  ...SECRET_COLUMNS,
};

const EDITOR = { user_id: 'user_01EDITOR', email: 'editor@example.com', name: 'Sam' };

/** The snapshot JSON a `property_revisions` / `brand_revisions` INSERT wrote. */
function insertedSnapshot(calls: unknown[][], table: string): Record<string, unknown> {
  const insert = calls.find(c => typeof c[0] === 'string' && (c[0] as string).includes(`INSERT INTO ${table}`));
  expect(insert, `no INSERT INTO ${table}`).toBeDefined();
  const snapshot = (insert![1] as unknown[]).find(v => typeof v === 'string' && v.startsWith('{'));
  return JSON.parse(snapshot as string);
}

function expectNoSecrets(snapshot: Record<string, unknown>) {
  for (const field of Object.keys(SECRET_COLUMNS)) {
    expect(snapshot).not.toHaveProperty(field);
  }
  const serialized = JSON.stringify(snapshot);
  for (const value of Object.values(SECRET_COLUMNS)) {
    expect(serialized).not.toContain(value);
  }
}

function client(steps: Array<unknown>) {
  const queryFn = vi.fn();
  for (const step of steps) queryFn.mockResolvedValueOnce(step);
  queryFn.mockResolvedValue(undefined);
  return { query: queryFn, release: vi.fn() };
}

describe('property revision snapshots', () => {
  let db: PropertyDatabase;

  beforeEach(() => {
    db = new PropertyDatabase();
    mocks.query.mockReset();
    mocks.getClient.mockReset();
  });

  it('createCommunityProperty stores the allowlisted shape', async () => {
    const c = client([
      undefined, // BEGIN
      { rows: [PROPERTY_ROW] }, // INSERT hosted_properties RETURNING *
    ]);
    mocks.getClient.mockResolvedValueOnce(c);

    await db.createCommunityProperty(
      { publisher_domain: 'news.example', adagents_json: { authorized_agents: [] } },
      { user_id: EDITOR.user_id, email: EDITOR.email, name: EDITOR.name },
    );

    const snapshot = insertedSnapshot(c.query.mock.calls as unknown[][], 'property_revisions');
    expectNoSecrets(snapshot);
    expect(snapshot).toMatchObject({ publisher_domain: 'news.example', adagents_json: { authorized_agents: [] } });
  });

  it('editCommunityProperty stores the allowlisted shape', async () => {
    const c = client([
      undefined, // BEGIN
      { rows: [PROPERTY_ROW] }, // SELECT ... FOR UPDATE
      { rows: [] }, // discovered_properties authoritative check
      { rows: [{ next_rev: 2 }] },
    ]);
    c.query.mockResolvedValue({ rows: [PROPERTY_ROW] });
    mocks.getClient.mockResolvedValueOnce(c);

    await db.editCommunityProperty('news.example', {
      adagents_json: { authorized_agents: [{ url: 'https://agent.example' }] },
      edit_summary: 'Added an agent',
      editor_user_id: EDITOR.user_id,
      editor_email: EDITOR.email,
    });

    expectNoSecrets(insertedSnapshot(c.query.mock.calls as unknown[][], 'property_revisions'));
  });

  it('rollbackProperty stores the allowlisted shape and restores from a sanitized target', async () => {
    const c = client([
      undefined, // BEGIN
      { rows: [{ snapshot: JSON.stringify({ ...PROPERTY_ROW, adagents_json: { authorized_agents: ['old'] } }) }] },
      { rows: [PROPERTY_ROW] }, // SELECT ... FOR UPDATE
      { rows: [] }, // discovered_properties authoritative check
      { rows: [{ next_rev: 3 }] },
    ]);
    c.query.mockResolvedValue({ rows: [PROPERTY_ROW] });
    mocks.getClient.mockResolvedValueOnce(c);

    await db.rollbackProperty('news.example', 1, EDITOR);

    expectNoSecrets(insertedSnapshot(c.query.mock.calls as unknown[][], 'property_revisions'));
    const update = (c.query.mock.calls as unknown[][])
      .find(call => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE hosted_properties'));
    expect(JSON.parse((update![1] as string[])[1])).toEqual({ authorized_agents: ['old'] });
  });
});

describe('brand revision snapshots', () => {
  const BRAND_ROW = {
    id: 'brand_01',
    domain: 'acme.example',
    brand_name: 'Acme',
    brand_names: '[]',
    source_type: 'community',
    review_status: 'approved',
    brand_manifest: { name: 'Acme' },
    discovered_at: new Date(),
    verification_token: 'verify_tok_live',
    workos_organization_id: 'org_01OWNER',
    prior_owner_org_id: 'org_01PRIOR',
    created_by_user_id: 'user_01CREATOR',
    created_by_email: 'owner@example.com',
  };

  beforeEach(() => {
    mocks.query.mockReset();
    mocks.getClient.mockReset();
  });

  it('rollbackBrand restores every content column from a sanitized target', async () => {
    const target = {
      ...BRAND_ROW,
      canonical_domain: 'acme.example',
      house_domain: 'acmeholdings.example',
      brand_name: 'Acme (old)',
      brand_names: [{ name: 'Acme' }],
      keller_type: 'master',
      parent_brand: 'acmeholdings.example',
      brand_agent_url: 'https://agent.acme.example',
      brand_agent_capabilities: ['get_products'],
      has_brand_manifest: true,
      brand_manifest: { name: 'Acme (old)' },
    };
    const c = client([
      undefined, // BEGIN
      undefined, // advisory lock
      { rows: [{ snapshot: JSON.stringify(target) }] }, // target revision
      { rows: [BRAND_ROW] }, // SELECT ... FOR UPDATE
      { rows: [{ next_rev: 4 }] },
    ]);
    c.query.mockResolvedValue({ rows: [BRAND_ROW] });
    mocks.getClient.mockResolvedValueOnce(c);

    await new BrandDatabase().rollbackBrand('acme.example', 2, EDITOR);

    const update = (c.query.mock.calls as unknown[][])
      .find(call => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE brands SET'));
    expect(update, 'no UPDATE brands').toBeDefined();
    // Positional with the SET list in rollbackBrand: domain, then the ten
    // content columns the restore writes. An allowlist that dropped any of
    // them would restore a null over live content.
    expect(update![1]).toEqual([
      'acme.example',
      'acme.example',
      'acmeholdings.example',
      'Acme (old)',
      JSON.stringify([{ name: 'Acme' }]),
      'master',
      'acmeholdings.example',
      'https://agent.acme.example',
      ['get_products'],
      true,
      JSON.stringify({ name: 'Acme (old)' }),
    ]);
  });

  it('editDiscoveredBrand stores the allowlisted shape', async () => {
    const c = client([
      undefined, // BEGIN
      undefined, // advisory lock
      { rows: [BRAND_ROW] }, // SELECT ... FOR UPDATE
      { rows: [{ next_rev: 2 }] },
    ]);
    c.query.mockResolvedValue({ rows: [BRAND_ROW] });
    mocks.getClient.mockResolvedValueOnce(c);

    await new BrandDatabase().editDiscoveredBrand('acme.example', {
      brand_name: 'Acme Holdings',
      edit_summary: 'Renamed',
      editor_user_id: EDITOR.user_id,
      editor_email: EDITOR.email,
    });

    const snapshot = insertedSnapshot(c.query.mock.calls as unknown[][], 'brand_revisions');
    for (const field of ['verification_token', 'workos_organization_id', 'prior_owner_org_id', 'created_by_user_id', 'created_by_email']) {
      expect(snapshot).not.toHaveProperty(field);
    }
    expect(snapshot).toMatchObject({ domain: 'acme.example', brand_name: 'Acme' });
  });
});
