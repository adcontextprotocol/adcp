/**
 * Brand Feed Import Routes
 *
 * Endpoints for importing content into brand.json from RSS, YouTube,
 * and Spotify feeds, plus bulk property/collection merge via JSON API.
 */

import { Router } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { query, getPool } from '../db/client.js';
import { BrandDatabase } from '../db/brand-db.js';
import { resolvePrimaryOrganization } from '../db/users-db.js';
import { validateFetchUrl } from '../utils/url-security.js';
import { fetchFeed, slugify, suggestProduct, mergeInstallments } from '../services/collection-feed-sync.js';
import type { CollectionFromFeed } from '../services/collection-feed-sync.js';
import {
  parsePropertyInputForBrand,
  mergeBrandProperties,
  VALID_PROPERTY_TYPES,
  type Relationship,
} from '../services/brand-property-parse.js';

const MAX_COLLECTIONS = 200;
const VALID_COLLECTION_KINDS = ['series', 'publication', 'event_series', 'rotation'];

const logger = createLogger('brand-feeds');

export function createBrandFeedsRouter(config: { brandDb: BrandDatabase }) {
  const router = Router();
  const { brandDb } = config;

  // Helper: get brand and validate the user's org owns it
  async function getBrandForEdit(domain: string, userId: string) {
    const brand = await brandDb.getDiscoveredBrandByDomain(domain);
    if (!brand) return { error: 'Brand not found', status: 404 };
    if (brand.source_type === 'brand_json') return { error: 'Cannot edit self-hosted brand', status: 409 };
    // Orphaned brands are awaiting adoption — feed/property edits during this
    // window would write into the prior owner's manifest fields. Force the
    // caller through updateBrandIdentity (which atomically clears or adopts
    // the orphan state) before allowing further edits.
    if (brand.manifest_orphaned) return { error: 'This brand is awaiting adoption — claim it through the brand identity flow first', status: 409 };

    // Verify the user's org owns this brand (via primary_brand_domain or organization_domains)
    const orgId = await resolvePrimaryOrganization(userId);
    if (!orgId) {
      return { error: 'No organization associated with your account', status: 403 };
    }

    const orgDomains = await query<{ domain: string }>(
      'SELECT domain FROM organization_domains WHERE workos_organization_id = $1',
      [orgId]
    );
    const memberProfile = await query<{ primary_brand_domain: string | null }>(
      'SELECT primary_brand_domain FROM member_profiles WHERE workos_organization_id = $1',
      [orgId]
    );
    const ownedDomains = new Set([
      ...orgDomains.rows.map(r => r.domain.toLowerCase()),
      ...(memberProfile.rows[0]?.primary_brand_domain ? [memberProfile.rows[0].primary_brand_domain.toLowerCase()] : []),
    ]);
    if (!ownedDomains.has(domain.toLowerCase())) {
      return { error: 'You do not own this brand domain', status: 403 };
    }

    return { brand };
  }

  // ─── Feed endpoints ────────────────────────────────────────────────

  // POST /api/brands/:domain/feeds — Add a feed (auto-detect type)
  router.post('/brands/:domain/feeds', requireAuth, async (req, res) => {
    try {
      const domain = req.params.domain.toLowerCase();
      const { url } = req.body;
      if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });

      // SSRF protection — validate URL before fetching
      try {
        await validateFetchUrl(new URL(url));
      } catch (err) {
        return res.status(400).json({ error: 'Invalid feed URL' });
      }

      const check = await getBrandForEdit(domain, req.user!.id);
      if ('error' in check) return res.status(check.status!).json({ error: check.error });

      // Fetch and parse the feed
      const { result: feedResult, feedType } = await fetchFeed(url);

      // Build collection from feed
      const collectionId = slugify(feedResult.title);
      const collection: CollectionFromFeed = {
        collection_id: collectionId,
        name: feedResult.title,
        kind: 'series',
        feed_url: url,
        feed_type: feedType,
        description: feedResult.description,
        artwork_url: feedResult.artwork_url,
        cadence: feedResult.cadence,
        language: feedResult.language,
        genre: feedResult.genre,
        content_rating: feedResult.content_rating,
        talent: feedResult.talent,
        installments: feedResult.installments,
        last_synced_at: new Date().toISOString(),
      };

      // Lock row, merge, write — prevents concurrent overwrites
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ brand_manifest: Record<string, unknown> }>(
          'SELECT brand_manifest FROM brands WHERE domain = $1 FOR UPDATE',
          [domain]
        );
        const manifest = (locked.rows[0]?.brand_manifest as Record<string, unknown>) || {};

        // Merge collections
        const collections = Array.isArray(manifest.collections) ? manifest.collections as CollectionFromFeed[] : [];
        const filtered = collections.filter(c => c.collection_id !== collectionId && c.feed_url !== url);
        filtered.push(collection);
        manifest.collections = filtered;

        // Auto-create a property for this feed (a collection IS a property you own)
        const feedTypeToPropertyType: Record<string, string> = { rss: 'podcast', youtube: 'website', spotify: 'podcast' };
        try {
          const feedHost = new URL(url).hostname;
          const properties = Array.isArray(manifest.properties)
            ? manifest.properties as Array<{ identifier: string; [k: string]: unknown }>
            : [];
          if (!properties.some(p => p.identifier === feedHost)) {
            properties.push({ type: feedTypeToPropertyType[feedType] || 'website', identifier: feedHost, feed_url: url });
            manifest.properties = properties;
          }
        } catch { /* invalid URL — skip property creation */ }

        await client.query(
          'UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2',
          [JSON.stringify(manifest), domain]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Suggest a default product for this collection
      const product_suggestion = suggestProduct(collection);

      return res.json({
        collection_id: collectionId,
        name: feedResult.title,
        feed_type: feedType,
        installment_count: feedResult.installments.length,
        genre: feedResult.genre,
        content_rating: feedResult.content_rating,
        language: feedResult.language,
        talent: feedResult.talent,
        collection,
        product_suggestion,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to import feed');
      return res.status(500).json({ error: 'Failed to import feed' });
    }
  });

  // GET /api/brands/:domain/feeds — List feeds
  router.get('/brands/:domain/feeds', requireAuth, async (req, res) => {
    try {
      const domain = req.params.domain.toLowerCase();
      const brand = await brandDb.getDiscoveredBrandByDomain(domain);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });

      const manifest = (brand.brand_manifest as Record<string, unknown>) || {};
      const collections = Array.isArray(manifest.collections)
        ? (manifest.collections as CollectionFromFeed[]).filter(c => c.feed_url)
        : [];

      return res.json({
        feeds: collections.map(c => ({
          collection_id: c.collection_id,
          name: c.name,
          feed_url: c.feed_url,
          feed_type: c.feed_type,
          installment_count: c.installments?.length || 0,
          last_synced_at: c.last_synced_at,
          last_sync_status: c.last_sync_status,
          last_sync_error: c.last_sync_error,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list feeds');
      return res.status(500).json({ error: 'Failed to list feeds' });
    }
  });

  // POST /api/brands/:domain/feeds/:collection_id/sync — Re-sync a feed
  router.post('/brands/:domain/feeds/:collection_id/sync', requireAuth, async (req, res) => {
    try {
      const domain = req.params.domain.toLowerCase();
      const collectionId = req.params.collection_id;

      const check = await getBrandForEdit(domain, req.user!.id);
      if ('error' in check) return res.status(check.status!).json({ error: check.error });
      const { brand } = check;

      const manifest = (brand!.brand_manifest as Record<string, unknown>) || {};
      const collections = Array.isArray(manifest.collections) ? manifest.collections as CollectionFromFeed[] : [];
      const collection = collections.find(c => c.collection_id === collectionId);
      if (!collection?.feed_url) return res.status(404).json({ error: 'Feed not found' });

      // Re-fetch and merge with removal detection + cap
      const { result: feedResult } = await fetchFeed(collection.feed_url);
      collection.installments = mergeInstallments(collection.installments || [], feedResult.installments);
      collection.last_synced_at = new Date().toISOString();
      collection.last_sync_status = 'ok';
      collection.last_sync_error = undefined;

      manifest.collections = collections;
      await query(
        'UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2',
        [JSON.stringify(manifest), domain]
      );

      return res.json({
        collection_id: collectionId,
        installment_count: collection.installments.length,
        last_synced_at: collection.last_synced_at,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to sync feed');
      return res.status(500).json({ error: 'Failed to sync feed' });
    }
  });

  // DELETE /api/brands/:domain/feeds/:collection_id — Remove a feed
  router.delete('/brands/:domain/feeds/:collection_id', requireAuth, async (req, res) => {
    try {
      const domain = req.params.domain.toLowerCase();
      const collectionId = req.params.collection_id;

      const check = await getBrandForEdit(domain, req.user!.id);
      if ('error' in check) return res.status(check.status!).json({ error: check.error });
      const { brand } = check;

      const manifest = (brand!.brand_manifest as Record<string, unknown>) || {};
      const collections = Array.isArray(manifest.collections) ? manifest.collections as CollectionFromFeed[] : [];
      manifest.collections = collections.filter(c => c.collection_id !== collectionId);

      await query(
        'UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2',
        [JSON.stringify(manifest), domain]
      );

      return res.json({ removed: collectionId });
    } catch (err) {
      logger.error({ err }, 'Failed to remove feed');
      return res.status(500).json({ error: 'Failed to remove feed' });
    }
  });

  // ─── Bulk merge endpoints ──────────────────────────────────────────

  // POST /api/brands/:domain/properties/parse — AI-powered property list parsing
  router.post('/brands/:domain/properties/parse', requireAuth, async (req, res) => {
    try {
      const domain = req.params.domain.toLowerCase();
      const { input, input_type, relationship } = req.body as {
        input?: string;
        input_type?: string;
        relationship?: string;
      };

      const result = await parsePropertyInputForBrand({
        brandDb,
        domain,
        userId: req.user!.id,
        input: input ?? '',
        inputType: (input_type ?? 'text') as 'text' | 'url',
        relationship: relationship as Relationship | undefined,
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }

      return res.json({
        properties: result.properties,
        count: result.count,
        truncated: result.truncated || undefined,
        warning: result.warning,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to parse property list');
      return res.status(500).json({ error: 'Failed to parse property list' });
    }
  });

  // POST /api/brands/:domain/properties — Merge properties by identifier
  router.post('/brands/:domain/properties', requireAuth, async (req, res) => {
    try {
      const domain = req.params.domain.toLowerCase();
      const { properties } = req.body;

      const result = await mergeBrandProperties({
        brandDb,
        domain,
        userId: req.user!.id,
        properties,
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      return res.json(result.report);
    } catch (err) {
      logger.error({ err }, 'Failed to merge properties');
      return res.status(500).json({ error: 'Failed to merge properties' });
    }
  });

  // POST /api/brands/:domain/collections — Merge collections by collection_id
  router.post('/brands/:domain/collections', requireAuth, async (req, res) => {
    try {
      const domain = req.params.domain.toLowerCase();
      const { collections } = req.body;
      if (!Array.isArray(collections)) return res.status(400).json({ error: 'collections array required' });
      if (collections.length > MAX_COLLECTIONS) return res.status(400).json({ error: `Maximum ${MAX_COLLECTIONS} collections per request` });

      const check = await getBrandForEdit(domain, req.user!.id);
      if ('error' in check) return res.status(check.status!).json({ error: check.error });
      const { brand } = check;

      const manifest = (brand!.brand_manifest as Record<string, unknown>) || {};
      const existing = Array.isArray(manifest.collections)
        ? manifest.collections as Array<{ collection_id: string; [k: string]: unknown }>
        : [];

      const byId = new Map(existing.map(c => [c.collection_id, c]));
      let added = 0, updated = 0, skipped = 0;
      const errors: Array<{ row: number; error: string }> = [];

      for (let i = 0; i < collections.length; i++) {
        const c = collections[i];
        if (!c.collection_id || typeof c.collection_id !== 'string') {
          errors.push({ row: i, error: 'collection_id required' }); skipped++; continue;
        }
        if (!c.name || typeof c.name !== 'string') {
          errors.push({ row: i, error: 'name required' }); skipped++; continue;
        }
        if (c.kind && !VALID_COLLECTION_KINDS.includes(c.kind)) {
          errors.push({ row: i, error: `invalid kind: ${c.kind}` }); skipped++; continue;
        }

        if (byId.has(c.collection_id)) {
          byId.set(c.collection_id, { ...byId.get(c.collection_id), ...c });
          updated++;
        } else {
          byId.set(c.collection_id, c);
          added++;
        }
      }

      manifest.collections = Array.from(byId.values());
      await query(
        'UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2',
        [JSON.stringify(manifest), domain]
      );

      return res.json({ added, updated, skipped, total: collections.length, errors: errors.length > 0 ? errors : undefined });
    } catch (err) {
      logger.error({ err }, 'Failed to merge collections');
      return res.status(500).json({ error: 'Failed to merge collections' });
    }
  });

  return router;
}

// Re-export VALID_PROPERTY_TYPES so existing imports keep working.
export { VALID_PROPERTY_TYPES };
