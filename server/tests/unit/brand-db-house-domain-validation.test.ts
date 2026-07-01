/**
 * Regression test for issue #3467: validate `brands.house_domain` on the
 * write path to block adversarial parent claims.
 *
 * The auth path in `org-filters.ts` walks `brands.house_domain` to inherit
 * child-brand employees into a paying parent org's WorkOS membership,
 * gated on `brand_manifest->'classification'->>'confidence' = 'high'`.
 *
 * Pre-fix attack: a community editor (via the `save_brand` MCP tool or any
 * other community write path) submits
 *
 *   { domain: 'attacker.example',
 *     house_domain: 'paying-target.example',
 *     brand_manifest: { classification: { confidence: 'high' } } }
 *
 * then signs in from `@attacker.example`. The recursive org-chain join
 * matches `house_domain = paying-target.example` AND the JSONB confidence
 * gate, and (if the paying target opted into hierarchy auto-provisioning)
 * `autoLinkByVerifiedDomain` issues them a WorkOS membership in the paying
 * target org.
 *
 * This test pins:
 *   1. `classification.*` and `brand_context` keys are stripped from caller-supplied
 *      brand_manifest on every community write path (upsert/create/edit).
 *   2. `house_domain` self-references are rejected.
 *   3. Control characters (NUL/CR/LF) and malformed domains are rejected.
 *
 * The trusted classification path (used by `brand-enrichment.ts`) is
 * `UpsertDiscoveredBrandInput.classification` — a typed first-class field
 * — verified to round-trip into the persisted manifest.
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

function makeClient() {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    release: vi.fn(),
  };
}

describe('BrandDatabase: house_domain write-path validation (#3467)', () => {
  let db: BrandDatabase;

  beforeEach(() => {
    db = new BrandDatabase();
    mocks.query.mockReset();
    mocks.getClient.mockReset();
  });

  describe('upsertDiscoveredBrand', () => {
    it('strips caller-supplied classification.confidence and brand_context from brand_manifest', async () => {
      mocks.query.mockResolvedValueOnce({
        rows: [{ domain: 'attacker.example', brand_names: '[]', brand_manifest: null, discovered_at: new Date(), last_validated: new Date() }],
      });

      await db.upsertDiscoveredBrand({
        domain: 'attacker.example',
        brand_name: 'Attacker',
        brand_manifest: {
          name: 'Attacker',
          // Adversarial: try to inject the high-confidence trust signal directly.
          classification: { confidence: 'high', reasoning: 'forged' },
          brand_context: { voice: { summary: 'persist me' } },
        },
        source_type: 'community',
      });

      expect(mocks.query).toHaveBeenCalledTimes(1);
      const params = mocks.query.mock.calls[0][1] as unknown[];
      // brand_manifest is the 12th positional param ($12) in the INSERT.
      const persistedManifest = JSON.parse(params[11] as string);
      expect(persistedManifest).not.toHaveProperty('classification');
      expect(persistedManifest).not.toHaveProperty('brand_context');
      expect(persistedManifest.name).toBe('Attacker');
    });

    it('writes a trusted classification via input.classification (round-trip)', async () => {
      mocks.query.mockResolvedValueOnce({
        rows: [{ domain: 'attacker.example', brand_names: '[]', brand_manifest: null, discovered_at: new Date(), last_validated: new Date() }],
      });

      await db.upsertDiscoveredBrand({
        domain: 'attacker.example',
        brand_name: 'Attacker',
        brand_manifest: { name: 'Attacker' },
        classification: { confidence: 'high', reasoning: 'classifier verdict' },
        source_type: 'enriched',
      });

      const params = mocks.query.mock.calls[0][1] as unknown[];
      const persistedManifest = JSON.parse(params[11] as string);
      expect(persistedManifest.classification).toEqual({
        confidence: 'high',
        reasoning: 'classifier verdict',
      });
    });

    it('rejects house_domain self-reference', async () => {
      await expect(
        db.upsertDiscoveredBrand({
          domain: 'attacker.example',
          house_domain: 'attacker.example',
          brand_name: 'Attacker',
          source_type: 'community',
        }),
      ).rejects.toThrow(/self-reference/i);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('rejects house_domain with control characters', async () => {
      await expect(
        db.upsertDiscoveredBrand({
          domain: 'attacker.example',
          house_domain: 'paying-target.example\nfake-audit-line',
          brand_name: 'Attacker',
          source_type: 'community',
        }),
      ).rejects.toThrow(/control characters/i);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('rejects malformed house_domain', async () => {
      await expect(
        db.upsertDiscoveredBrand({
          domain: 'attacker.example',
          house_domain: 'not_a_domain',
          brand_name: 'Attacker',
          source_type: 'community',
        }),
      ).rejects.toThrow(/not a valid brand domain/i);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('canonicalizes a valid house_domain (lowercases, strips www)', async () => {
      mocks.query.mockResolvedValueOnce({
        rows: [{ domain: 'sub.example', brand_names: '[]', brand_manifest: null, discovered_at: new Date(), last_validated: new Date() }],
      });

      await db.upsertDiscoveredBrand({
        domain: 'sub.example',
        house_domain: 'Www.House.Example',
        brand_name: 'Sub',
        source_type: 'community',
      });

      const params = mocks.query.mock.calls[0][1] as unknown[];
      // house_domain is the 4th positional param ($4) in the INSERT.
      expect(params[3]).toBe('house.example');
    });
  });

  describe('createDiscoveredBrand', () => {
    it('strips caller-supplied classification.* and brand_context from brand_manifest', async () => {
      const client = makeClient();
      mocks.getClient.mockResolvedValueOnce(client);
      client.query
        // BEGIN
        .mockResolvedValueOnce(undefined)
        // INSERT into brands
        .mockResolvedValueOnce({
          rows: [{ domain: 'attacker.example', brand_names: '[]', brand_manifest: null, discovered_at: new Date() }],
        })
        // INSERT into brand_revisions
        .mockResolvedValueOnce(undefined)
        // COMMIT
        .mockResolvedValueOnce(undefined);

      await db.createDiscoveredBrand(
        {
          domain: 'attacker.example',
          brand_name: 'Attacker',
          brand_manifest: {
            classification: { confidence: 'high' },
            brand_context: { voice: { summary: 'persist me' } },
          },
          source_type: 'community',
        },
        { user_id: 'u1', email: 'a@b.c' },
      );

      // Find the INSERT into brands call.
      const insertCall = client.query.mock.calls.find(call =>
        typeof call[0] === 'string' && call[0].includes('INSERT INTO brands'),
      );
      expect(insertCall).toBeDefined();
      const manifestParam = (insertCall![1] as unknown[])[10] as string | null;
      // Caller submitted a manifest with only the adversarial key; after
      // stripping, the manifest is empty — JSON.stringify({}) is the
      // observable result. If the stripping logic erroneously dropped the
      // manifest to null, this would also catch it (we still want a
      // committed empty object so the row's manifest column reflects the
      // failed write attempt with the auth signal removed).
      const parsed = JSON.parse(manifestParam!);
      expect(parsed).not.toHaveProperty('classification');
      expect(parsed).not.toHaveProperty('brand_context');
    });

    it('rejects house_domain self-reference', async () => {
      mocks.getClient.mockResolvedValueOnce(makeClient());

      await expect(
        db.createDiscoveredBrand(
          {
            domain: 'attacker.example',
            house_domain: 'attacker.example',
            brand_name: 'Attacker',
            source_type: 'community',
          },
          { user_id: 'u1' },
        ),
      ).rejects.toThrow(/self-reference/i);
    });
  });

  describe('editDiscoveredBrand', () => {
    it('strips classification and brand_context from caller-supplied brand_manifest and preserves prior classification', async () => {
      const client = makeClient();
      mocks.getClient.mockResolvedValueOnce(client);
      // BEGIN
      client.query.mockResolvedValueOnce(undefined);
      // SELECT ... FOR UPDATE returns prior state with a trusted classification block
      client.query.mockResolvedValueOnce({
        rows: [{
          domain: 'attacker.example',
          source_type: 'community',
          review_status: 'approved',
          brand_manifest: { name: 'Old', classification: { confidence: 'high', reasoning: 'classifier verdict' } },
          brand_names: '[]',
          discovered_at: new Date(),
        }],
      });
      // SELECT next_rev
      client.query.mockResolvedValueOnce({ rows: [{ next_rev: 2 }] });
      // INSERT revision
      client.query.mockResolvedValueOnce(undefined);
      // UPDATE brands
      client.query.mockResolvedValueOnce({
        rows: [{ domain: 'attacker.example', brand_names: '[]', brand_manifest: null, discovered_at: new Date() }],
      });
      // COMMIT
      client.query.mockResolvedValueOnce(undefined);

      await db.editDiscoveredBrand('attacker.example', {
        brand_manifest: {
          name: 'New',
          // Adversarial: try to overwrite the high-confidence trust signal.
          classification: { confidence: 'low' },
          brand_context: { voice: { summary: 'persist me' } },
        },
        edit_summary: 'attacker edit',
        editor_user_id: 'u1',
      });

      const updateCall = client.query.mock.calls.find(call =>
        typeof call[0] === 'string' && (call[0] as string).startsWith('UPDATE brands SET'),
      );
      expect(updateCall).toBeDefined();
      const params = updateCall![1] as unknown[];
      // brand_manifest is the value at the brand_manifest update slot —
      // find it by scanning for the JSON string.
      const manifestJson = params.find(p => typeof p === 'string' && p.startsWith('{"')) as string;
      expect(manifestJson).toBeDefined();
      const persistedManifest = JSON.parse(manifestJson);
      expect(persistedManifest.name).toBe('New');
      expect(persistedManifest).not.toHaveProperty('brand_context');
      // Prior trusted classification is preserved (caller cannot demote it
      // by supplying a low-confidence override).
      expect(persistedManifest.classification).toEqual({
        confidence: 'high',
        reasoning: 'classifier verdict',
      });
    });

    it('rejects house_domain self-reference', async () => {
      mocks.getClient.mockResolvedValueOnce(makeClient());

      await expect(
        db.editDiscoveredBrand('attacker.example', {
          house_domain: 'attacker.example',
          edit_summary: 'attempt',
          editor_user_id: 'u1',
        }),
      ).rejects.toThrow(/self-reference/i);
    });
  });

  describe('rollbackBrand and revision reads', () => {
    it('strips brand_context and caller-supplied classification when restoring from a revision snapshot', async () => {
      const client = makeClient();
      mocks.getClient.mockResolvedValueOnce(client);
      client.query
        // BEGIN
        .mockResolvedValueOnce(undefined)
        // SELECT target revision
        .mockResolvedValueOnce({
          rows: [{
            snapshot: JSON.stringify({
              domain: 'attacker.example',
              brand_name: 'Attacker',
              brand_names: [],
              has_brand_manifest: true,
              brand_manifest: {
                name: 'Attacker',
                classification: { confidence: 'high', reasoning: 'forged old snapshot' },
                brand_context: { voice: { summary: 'legacy context' } },
              },
            }),
          }],
        })
        // SELECT current FOR UPDATE
        .mockResolvedValueOnce({
          rows: [{
            domain: 'attacker.example',
            brand_name: 'Current',
            brand_names: [],
            brand_manifest: {
              name: 'Current',
              brand_context: { voice: { summary: 'current context' } },
            },
          }],
        })
        // SELECT next revision
        .mockResolvedValueOnce({ rows: [{ next_rev: 4 }] })
        // INSERT rollback revision
        .mockResolvedValueOnce(undefined)
        // UPDATE brands
        .mockResolvedValueOnce({
          rows: [{ domain: 'attacker.example', brand_names: '[]', brand_manifest: null, discovered_at: new Date() }],
        })
        // COMMIT
        .mockResolvedValueOnce(undefined);

      await db.rollbackBrand('attacker.example', 2, { user_id: 'admin' });

      const updateCall = client.query.mock.calls.find(call =>
        typeof call[0] === 'string' && (call[0] as string).includes('UPDATE brands SET'),
      );
      expect(updateCall).toBeDefined();
      const params = updateCall![1] as unknown[];
      const restoredManifest = JSON.parse(params[10] as string);
      expect(restoredManifest).toEqual({ name: 'Attacker' });

      const insertRevisionCall = client.query.mock.calls.find(call =>
        typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO brand_revisions'),
      );
      const rollbackSnapshot = JSON.parse((insertRevisionCall![1] as unknown[])[2] as string);
      expect(rollbackSnapshot.brand_manifest).toEqual({ name: 'Current' });
    });

    it('redacts brand_context from returned revision snapshots', async () => {
      mocks.query.mockResolvedValueOnce({
        rows: [{
          id: 'rev-1',
          brand_domain: 'attacker.example',
          revision_number: 1,
          snapshot: JSON.stringify({
            domain: 'attacker.example',
            brand_manifest: {
              name: 'Attacker',
              classification: { confidence: 'high' },
              brand_context: { voice: { summary: 'legacy context' } },
            },
          }),
          created_at: new Date(),
        }],
      });

      const revision = await db.getBrandRevision('attacker.example', 1);

      expect(revision?.snapshot).toMatchObject({
        domain: 'attacker.example',
        brand_manifest: { name: 'Attacker' },
      });
      expect((revision?.snapshot as Record<string, unknown>).brand_manifest).not.toHaveProperty('classification');
      expect((revision?.snapshot as Record<string, unknown>).brand_manifest).not.toHaveProperty('brand_context');
    });
  });
});
