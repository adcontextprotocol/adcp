import { describe, expect, it, vi } from 'vitest';
import { rebuildManifestLogos } from '../../src/services/brand-logo-service.js';
import type { BrandLogoDatabase } from '../../src/db/brand-logo-db.js';
import type { BrandDatabase } from '../../src/db/brand-db.js';

describe('brand asset public URLs', () => {
  it('writes approved logo assets to brand.json with /assets/brands URLs including extension', async () => {
    const brandLogoDb = {
      listBrandLogos: vi.fn().mockResolvedValue([
        {
          id: '11111111-1111-1111-1111-111111111111',
          domain: 'acme.example',
          content_type: 'image/png',
          tags: ['primary'],
          width: 512,
          height: 128,
          source: 'brand_owner',
        },
      ]),
    } as unknown as BrandLogoDatabase;
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        domain: 'acme.example',
      }),
      editDiscoveredBrand: vi.fn().mockResolvedValue({ brand: {}, revision_number: 2 }),
    } as unknown as BrandDatabase;

    await rebuildManifestLogos('acme.example', brandLogoDb, brandDb);

    expect(brandDb.editDiscoveredBrand).toHaveBeenCalledWith(
      'acme.example',
      expect.objectContaining({
        brand_manifest: {
          logos: [
            {
              url: expect.stringMatching(/\/assets\/brands\/acme\.example\/11111111-1111-1111-1111-111111111111\.png$/),
              tags: ['primary'],
              width: 512,
              height: 128,
            },
          ],
        },
      }),
    );
  });

  it('publishes a pending community brand when rebuilding approved logo assets', async () => {
    const brandLogoDb = {
      listBrandLogos: vi.fn().mockResolvedValue([
        {
          id: '22222222-2222-2222-2222-222222222222',
          domain: 'pending.example',
          content_type: 'image/svg+xml',
          tags: ['primary'],
          source: 'community',
        },
      ]),
    } as unknown as BrandLogoDatabase;
    const brandDb = {
      getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({
        domain: 'pending.example',
        source_type: 'community',
        review_status: 'pending',
        brand_name: 'Pending Example',
        brand_manifest: {
          name: 'Pending Example',
          contact: { email: 'brand@example.com' },
        },
      }),
      upsertDiscoveredBrand: vi.fn(),
      approveBrand: vi.fn().mockResolvedValue(true),
      editDiscoveredBrand: vi.fn().mockResolvedValue({ brand: {}, revision_number: 2 }),
    } as unknown as BrandDatabase;

    await rebuildManifestLogos('pending.example', brandLogoDb, brandDb);

    expect(brandDb.approveBrand).toHaveBeenCalledWith('pending.example');
    expect(brandDb.editDiscoveredBrand).toHaveBeenCalledWith(
      'pending.example',
      expect.objectContaining({
        has_brand_manifest: true,
        brand_manifest: {
          name: 'Pending Example',
          contact: { email: 'brand@example.com' },
          logos: [
            {
              url: expect.stringMatching(/\/assets\/brands\/pending\.example\/22222222-2222-2222-2222-222222222222\.svg$/),
              tags: ['primary'],
            },
          ],
        },
      }),
    );
    expect(brandDb.upsertDiscoveredBrand).not.toHaveBeenCalled();
  });
});
