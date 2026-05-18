/**
 * Regression: editDiscoveredBrand must promote source_type='enriched' to
 * 'community' on first human edit.
 *
 * Why this matters: PR #3529 gated /brands/:domain/brand.json on
 * source_type ∈ {brand_json, community}. Before the promotion logic,
 * editDiscoveredBrand wrote curated content into brand_manifest but never
 * touched source_type, so Brandfetch-seeded rows that had been hand-curated
 * silently started 404ing post-#3529 (broke scope3.com, fandom.com).
 *
 * Pin:
 *   1. enriched row + a human edit → UPDATE includes source_type='community'.
 *   2. community/brand_json rows → source_type column is NOT in the UPDATE
 *      (no churn, no spurious revisions).
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

import { BrandDatabase } from '../../src/db/brand-db.js';

function makeClient(current: Record<string, unknown>) {
  const queryFn = vi.fn();
  queryFn
    // BEGIN
    .mockResolvedValueOnce(undefined)
    // SELECT ... FOR UPDATE (current row)
    .mockResolvedValueOnce({ rows: [current] })
    // SELECT next_rev
    .mockResolvedValueOnce({ rows: [{ next_rev: 1 }] })
    // INSERT brand_revisions
    .mockResolvedValueOnce(undefined)
    // UPDATE brands ... RETURNING *
    .mockResolvedValueOnce({ rows: [{ ...current, source_type: current.source_type === 'enriched' ? 'community' : current.source_type }] })
    // COMMIT
    .mockResolvedValueOnce(undefined);
  return { query: queryFn, release: vi.fn() };
}

function findUpdateCall(calls: unknown[][]) {
  return calls.find(c => typeof c[0] === 'string' && (c[0] as string).startsWith('UPDATE brands SET'));
}

describe('editDiscoveredBrand source_type promotion', () => {
  let db: BrandDatabase;

  beforeEach(() => {
    db = new BrandDatabase();
    mocks.query.mockReset();
    mocks.getClient.mockReset();
  });

  it('promotes enriched → community on edit', async () => {
    const client = makeClient({
      domain: 'scope3.com',
      source_type: 'enriched',
      review_status: 'approved',
      brand_manifest: { name: 'Scope3' },
      brand_names: '[]',
      discovered_at: new Date(),
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.editDiscoveredBrand('scope3.com', {
      brand_manifest: { name: 'Scope3', description: 'Updated by human' },
      edit_summary: 'Curated description',
      editor_user_id: 'user_1',
      editor_email: 'curator@example.com',
    });

    const updateCall = findUpdateCall(client.query.mock.calls);
    expect(updateCall).toBeDefined();
    const sql = updateCall![0] as string;
    expect(sql).toMatch(/source_type = \$/);
    const params = updateCall![1] as unknown[];
    expect(params).toContain('community');
  });

  it('does NOT touch source_type on a community row', async () => {
    const client = makeClient({
      domain: 'community.example',
      source_type: 'community',
      review_status: 'approved',
      brand_manifest: { name: 'Existing' },
      brand_names: '[]',
      discovered_at: new Date(),
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.editDiscoveredBrand('community.example', {
      brand_manifest: { name: 'Existing', description: 'tweak' },
      edit_summary: 'tweak',
      editor_user_id: 'user_1',
    });

    const updateCall = findUpdateCall(client.query.mock.calls);
    expect(updateCall).toBeDefined();
    const sql = updateCall![0] as string;
    expect(sql).not.toMatch(/source_type = \$/);
  });

  it('rejects edits to brand_json rows entirely (no promotion attempt)', async () => {
    const client = makeClient({
      domain: 'self-hosted.example',
      source_type: 'brand_json',
      review_status: 'approved',
      brand_manifest: { name: 'Self-hosted' },
      brand_names: '[]',
      discovered_at: new Date(),
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await expect(
      db.editDiscoveredBrand('self-hosted.example', {
        brand_manifest: { name: 'Tampered' },
        edit_summary: 'attempt',
        editor_user_id: 'user_1',
      }),
    ).rejects.toThrow(/Cannot edit authoritative/i);
  });
});
