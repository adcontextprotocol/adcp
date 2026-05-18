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
 *   1. enriched row + a human edit that changes content → UPDATE includes
 *      source_type='community'.
 *   2. community/brand_json rows → source_type column is NOT in the UPDATE
 *      (no churn, no spurious revisions).
 *   3. System callers (system:logo-service, system:addie) never promote —
 *      they're provenance bookkeeping, not curation, and a logo upload to
 *      an enriched brand must not flip it to community-attested.
 *   4. Audit-only revisions (edit_summary with no manifest input) don't
 *      promote even from a human caller — no content was curated.
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

  it('does NOT promote enriched → community when system:logo-service rebuilds the manifest', async () => {
    // The logo service writes a manifest update whenever a logo is approved
    // (logos array refresh). The brand content fields are still raw
    // Brandfetch — promotion would silently start serving them under the
    // community label.
    const client = makeClient({
      domain: 'enriched.example',
      source_type: 'enriched',
      review_status: 'approved',
      brand_manifest: { name: 'Brandfetch Data', description: 'Raw Brandfetch' },
      brand_names: '[]',
      discovered_at: new Date(),
    });
    mocks.getClient.mockResolvedValueOnce(client);

    await db.editDiscoveredBrand('enriched.example', {
      brand_manifest: { logos: [{ url: 'https://example/logo.png' }] },
      has_brand_manifest: true,
      edit_summary: 'Logo manifest rebuilt after review',
      editor_user_id: 'system:logo-service',
    });

    const updateCall = findUpdateCall(client.query.mock.calls);
    expect(updateCall).toBeDefined();
    const sql = updateCall![0] as string;
    expect(sql).not.toMatch(/source_type = \$/);
  });

  it('does NOT promote enriched → community on an audit-only revision (no manifest change)', async () => {
    const client = makeClient({
      domain: 'enriched.example',
      source_type: 'enriched',
      review_status: 'approved',
      brand_manifest: { name: 'Brandfetch Data' },
      brand_names: '[]',
      discovered_at: new Date(),
    });
    mocks.getClient.mockResolvedValueOnce(client);

    // The route-level logo upload writes this kind of audit-only revision
    // to record provenance — no brand content fields change.
    await db.editDiscoveredBrand('enriched.example', {
      edit_summary: 'Logo uploaded by alice@example.com (community — pending review)',
      editor_user_id: 'user_alice',
      editor_email: 'alice@example.com',
    });

    const updateCall = findUpdateCall(client.query.mock.calls);
    // No content changed and source_type wasn't promoted → early-return path
    // means no UPDATE at all.
    expect(updateCall).toBeUndefined();
  });
});
