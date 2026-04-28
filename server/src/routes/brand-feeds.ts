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
import Anthropic from '@anthropic-ai/sdk';
import { validateFetchUrl, safeFetch, sanitizeUrl } from '../utils/url-security.js';
import { ModelConfig } from '../config/models.js';
import { fetchFeed, slugify, suggestProduct, mergeInstallments } from '../services/collection-feed-sync.js';
import type { CollectionFromFeed } from '../services/collection-feed-sync.js';

const MAX_PROPERTIES = 500;
const MAX_COLLECTIONS = 200;
const MAX_PARSE_INPUT_CHARS = 50_000;
const MAX_PARSE_FETCH_BYTES = 1_000_000; // 1MB streaming cap

const logger = createLogger('brand-feeds');

const VALID_PROPERTY_TYPES = ['website', 'mobile_app', 'ctv_app', 'desktop_app', 'dooh', 'podcast', 'radio', 'streaming_audio'];
const VALID_COLLECTION_KINDS = ['series', 'publication', 'event_series', 'rotation'];

let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

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

      if (!input || typeof input !== 'string' || input.trim().length === 0) {
        return res.status(400).json({ error: 'input required' });
      }
      if (!['text', 'url'].includes(input_type ?? 'text')) {
        return res.status(400).json({ error: "input_type must be 'text' or 'url'" });
      }
      if (relationship !== undefined && !['owned', 'direct', 'delegated', 'ad_network'].includes(relationship)) {
        return res.status(400).json({ error: "relationship must be one of: owned, direct, delegated, ad_network" });
      }

      // Verify brand ownership before any outbound fetch or LLM spend.
      const check = await getBrandForEdit(domain, req.user!.id);
      if ('error' in check) return res.status(check.status!).json({ error: check.error });

      let rawText = input.trim();
      let truncated = false;

      if (input_type === 'url') {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(rawText);
        } catch {
          return res.status(400).json({ error: 'Invalid URL' });
        }
        // safeFetch re-validates internally; validate here first to return a clean 400
        // without revealing internal DNS error messages to the caller.
        try {
          await validateFetchUrl(parsedUrl);
        } catch {
          return res.status(400).json({ error: 'URL not allowed for security reasons' });
        }
        let fetchResponse;
        try {
          fetchResponse = await safeFetch(sanitizeUrl(parsedUrl), {
            headers: { 'User-Agent': 'AdCP Brand Builder/1.0' },
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          return res.status(400).json({ error: `Could not fetch URL: ${(err as Error).message}` });
        }
        if (!fetchResponse.ok) {
          return res.status(400).json({ error: `URL returned HTTP ${fetchResponse.status}` });
        }
        if (!fetchResponse.body) {
          return res.status(400).json({ error: 'URL returned no body' });
        }
        // Stream with a hard byte cap — Content-Length alone is not reliable for chunked responses.
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        let totalBytes = 0;
        const reader = fetchResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.length;
          chunks.push(decoder.decode(value, { stream: true }));
          if (totalBytes > MAX_PARSE_FETCH_BYTES) {
            void reader.cancel();
            break;
          }
        }
        chunks.push(decoder.decode()); // flush
        rawText = chunks.join('');
      }

      if (rawText.length > MAX_PARSE_INPUT_CHARS) {
        rawText = rawText.slice(0, MAX_PARSE_INPUT_CHARS);
        truncated = true;
      }

      const message = await getAnthropicClient().messages.create({
        model: ModelConfig.fast,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            // Content is wrapped in XML tags to reduce prompt-injection surface from
            // adversarial responses on the URL fetch path. Preview-only endpoint (no write).
            content: `Extract all publisher domains and app bundle IDs from the content below. Ignore ad tech infrastructure (ad networks, DSPs, SSPs, CDNs, measurement vendors).

For each entry return:
- "identifier": the bare domain (e.g. "example.com") or app bundle (e.g. "com.example.app")
- "type": one of: website, mobile_app, ctv_app, desktop_app, podcast, radio, streaming_audio, dooh

Return ONLY valid JSON with no explanation or markdown:
{"properties":[{"identifier":"...","type":"website"},...]}

If no identifiers found, return: {"properties":[]}

<content>
${rawText}
</content>`,
          },
        ],
      });

      const responseText =
        message.content[0].type === 'text' ? message.content[0].text.trim() : '';
      let parsed: { properties?: Array<{ identifier?: string; type?: string }> };
      try {
        parsed = JSON.parse(responseText);
      } catch {
        logger.warn({ domain }, 'Property parse: LLM returned non-JSON response');
        return res.json({ properties: [], count: 0, warning: 'Could not parse identifiers from input' });
      }

      const rel = relationship ?? 'delegated';

      const properties = (Array.isArray(parsed.properties) ? parsed.properties : [])
        .filter(
          (p) =>
            p.identifier &&
            typeof p.identifier === 'string' &&
            p.identifier.trim().length > 0 &&
            p.identifier.length <= 253 && // DNS max length
            VALID_PROPERTY_TYPES.includes(p.type ?? ''),
        )
        .map((p) => ({ identifier: p.identifier!.toLowerCase().trim(), type: p.type!, relationship: rel }))
        .slice(0, MAX_PROPERTIES);

      return res.json({ properties, count: properties.length, truncated: truncated || undefined });
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
      if (!Array.isArray(properties)) return res.status(400).json({ error: 'properties array required' });
      if (properties.length > MAX_PROPERTIES) return res.status(400).json({ error: `Maximum ${MAX_PROPERTIES} properties per request` });

      const check = await getBrandForEdit(domain, req.user!.id);
      if ('error' in check) return res.status(check.status!).json({ error: check.error });
      const { brand } = check;

      const manifest = (brand!.brand_manifest as Record<string, unknown>) || {};
      const existing = Array.isArray(manifest.properties)
        ? manifest.properties as Array<{ identifier: string; [k: string]: unknown }>
        : [];

      const byIdentifier = new Map(existing.map(p => [p.identifier, p]));
      let added = 0, updated = 0, skipped = 0;
      const errors: Array<{ row: number; error: string }> = [];

      for (let i = 0; i < properties.length; i++) {
        const p = properties[i];
        if (!p.identifier || typeof p.identifier !== 'string') {
          errors.push({ row: i, error: 'identifier required' }); skipped++; continue;
        }
        if (p.type && !VALID_PROPERTY_TYPES.includes(p.type)) {
          errors.push({ row: i, error: `invalid type: ${p.type}` }); skipped++; continue;
        }

        const key = p.identifier.toLowerCase();
        if (byIdentifier.has(key)) {
          byIdentifier.set(key, { ...byIdentifier.get(key), ...p, identifier: key });
          updated++;
        } else {
          byIdentifier.set(key, { ...p, identifier: key });
          added++;
        }
      }

      manifest.properties = Array.from(byIdentifier.values());
      await query(
        'UPDATE brands SET brand_manifest = $1::jsonb, updated_at = NOW() WHERE domain = $2',
        [JSON.stringify(manifest), domain]
      );

      return res.json({ added, updated, skipped, total: properties.length, errors: errors.length > 0 ? errors : undefined });
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
