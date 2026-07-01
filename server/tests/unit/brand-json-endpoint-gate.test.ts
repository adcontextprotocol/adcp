/**
 * Unit tests for GET /brands/:domain/brand.json gate behavior.
 *
 * Pins the gate's source_type acceptance set and provenance signaling.
 * The endpoint serves brand_json, community, and enriched rows; consumers
 * tell them apart via the X-AAO-Source response header. The JSON body itself
 * stays free of non-spec fields so it round-trips as a valid brand.json.
 *
 * History: the original shape-based gate (#3529) was tightened to a source_type
 * allowlist that excluded enriched, which then made the "Community brand.json"
 * link in the viewer 404 for every Brandfetch-derived row (sbs.com.au, etc.).
 * Enriched is now served with X-AAO-Source: enriched so agents can decide
 * how much trust to place in it.
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// The endpoint is registered inside HTTPServer.start, but the handler logic is
// what we want to pin — re-register it on a bare router with a stubbed brandDb.
function mountGate(brandDb: {
  getDiscoveredBrandByDomain: (domain: string) => Promise<unknown>;
}) {
  const app = express();
  app.get('/brands/:domain/brand.json', async (req, res) => {
    const domain = req.params.domain.toLowerCase();
    const brand: any = await brandDb.getDiscoveredBrandByDomain(domain);
    if (!brand || brand.is_public === false) return res.status(404).json({ error: 'Brand not found' });
    const ALLOWED_SOURCE_TYPES = new Set(['brand_json', 'community', 'enriched']);
    if (!ALLOWED_SOURCE_TYPES.has(brand.source_type)) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    const manifest = brand.brand_manifest as Record<string, unknown> | undefined;
    if (!manifest) return res.status(404).json({ error: 'Brand not found' });
    if (brand.source_type === 'community' && brand.review_status === 'pending') {
      return res.status(404).json({ error: 'Brand not found' });
    }
    const schemaUrl = 'https://adcontextprotocol.org/schemas/v3/brand.json';
    const brandJson: Record<string, unknown> =
      typeof manifest.$schema === 'string' && manifest.$schema.startsWith('https://')
        ? { ...manifest }
        : { $schema: schemaUrl, ...manifest };
    res.setHeader('X-AAO-Source', brand.source_type);
    return res.json(brandJson);
  });
  return app;
}

describe('GET /brands/:domain/brand.json gate', () => {
  it('404s when no brand row exists', async () => {
    const app = mountGate({ getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null) });
    const res = await request(app).get('/brands/missing.example/brand.json');
    expect(res.status).toBe(404);
  });

  it('serves enriched (Brandfetch) rows with X-AAO-Source: enriched so agents can tell unattested data apart from brand-attested', async () => {
    const app = mountGate({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        is_public: true,
        source_type: 'enriched',
        brand_manifest: { name: 'SBS Australia', url: 'https://sbs.com.au', logos: [], colors: { accent: '#FCB502' } },
      }),
    });
    const res = await request(app).get('/brands/sbs.com.au/brand.json');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('SBS Australia');
    expect(res.headers['x-aao-source']).toBe('enriched');
  });

  it('404s unknown source_types (e.g. hosted) — only the explicit allowlist is served', async () => {
    const app = mountGate({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        is_public: true,
        source_type: 'hosted',
        brand_manifest: { name: 'Hosted' },
      }),
    });
    const res = await request(app).get('/brands/hosted.example/brand.json');
    expect(res.status).toBe(404);
  });

  it('serves community brands with a flat manifest (the shape our edit UI writes)', async () => {
    const app = mountGate({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        is_public: true,
        source_type: 'community',
        review_status: 'approved',
        brand_manifest: {
          name: 'Scope3',
          url: 'https://scope3.com',
          logos: [{ url: 'https://cdn.example/logo.svg' }],
          colors: { accent: '#dcfc01' },
          description: 'Scope3 powers agentic advertising.',
        },
      }),
    });
    const res = await request(app).get('/brands/scope3.com/brand.json');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Scope3');
    expect(res.body.colors.accent).toBe('#dcfc01');
    expect(res.body.$schema).toBe('https://adcontextprotocol.org/schemas/v3/brand.json');
    expect(res.headers['x-aao-source']).toBe('community');
  });

  it('serves brand_json source rows untouched', async () => {
    const app = mountGate({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        is_public: true,
        source_type: 'brand_json',
        brand_manifest: { house: { name: 'Acme', domain: 'acme.com' }, brands: [] },
      }),
    });
    const res = await request(app).get('/brands/acme.com/brand.json');
    expect(res.status).toBe(200);
    expect(res.body.house.domain).toBe('acme.com');
    expect(res.headers['x-aao-source']).toBe('brand_json');
  });

  it('404s community brands still pending review', async () => {
    const app = mountGate({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        is_public: true,
        source_type: 'community',
        review_status: 'pending',
        brand_manifest: { name: 'Pending' },
      }),
    });
    const res = await request(app).get('/brands/pending.example/brand.json');
    expect(res.status).toBe(404);
  });

  it('404s rows with is_public=false', async () => {
    const app = mountGate({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        is_public: false,
        source_type: 'community',
        brand_manifest: { name: 'Private' },
      }),
    });
    const res = await request(app).get('/brands/private.example/brand.json');
    expect(res.status).toBe(404);
  });

  it('passes through caller-supplied $schema when present and HTTPS', async () => {
    const app = mountGate({
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        is_public: true,
        source_type: 'community',
        review_status: 'approved',
        brand_manifest: {
          $schema: 'https://adcontextprotocol.org/schemas/v3/brand.json#draft',
          name: 'Custom',
        },
      }),
    });
    const res = await request(app).get('/brands/custom.example/brand.json');
    expect(res.status).toBe(200);
    expect(res.body.$schema).toBe('https://adcontextprotocol.org/schemas/v3/brand.json#draft');
  });
});
