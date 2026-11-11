import { describe, expect, it, vi } from 'vitest';
import { rebuildManifestLogos } from '../../src/services/brand-logo-service.js';
import type { BrandLogoDatabase } from '../../src/db/brand-logo-db.js';
import type { BrandDatabase } from '../../src/db/brand-db.js';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';
const ID_D = '44444444-4444-4444-4444-444444444444';

async function rebuild(rows: Array<Record<string, unknown>>) {
  const brandLogoDb = {
    listBrandLogos: vi.fn().mockResolvedValue(
      rows.map((r) => ({ domain: 'acme.example', content_type: 'image/svg+xml', source: 'brand_owner', ...r })),
    ),
  } as unknown as BrandLogoDatabase;
  const brandDb = {
    getDiscoveredBrandByDomain: vi.fn().mockResolvedValue({ domain: 'acme.example' }),
    editDiscoveredBrand: vi.fn().mockResolvedValue({ brand: {}, revision_number: 2 }),
  } as unknown as BrandDatabase;

  await rebuildManifestLogos('acme.example', brandLogoDb, brandDb);

  const call = vi.mocked(brandDb.editDiscoveredBrand).mock.calls[0];
  return (call[1] as { brand_manifest: { logos: Array<Record<string, unknown>> } }).brand_manifest.logos;
}

describe('rebuildManifestLogos background', () => {
  it('writes background from a background tag', async () => {
    const [logo] = await rebuild([{ id: ID_A, tags: ['primary', 'dark-bg'], derived_background: null }]);
    expect(logo.background).toBe('dark-bg');
  });

  it('writes transparent-bg from its tag', async () => {
    const [logo] = await rebuild([{ id: ID_A, tags: ['transparent-bg'], derived_background: 'dark-bg' }]);
    expect(logo.background).toBe('transparent-bg');
  });

  it('prefers the tag over derived_background', async () => {
    const [logo] = await rebuild([{ id: ID_A, tags: ['light-bg'], derived_background: 'dark-bg' }]);
    expect(logo.background).toBe('light-bg');
  });

  it('falls back to derived_background when there is no tag', async () => {
    const logos = await rebuild([
      { id: ID_A, tags: ['primary'], derived_background: 'dark-bg' },
      { id: ID_B, tags: [], derived_background: 'light-bg' },
    ]);
    expect(logos.map((l) => l.background)).toEqual(['dark-bg', 'light-bg']);
  });

  it('omits background when neither a tag nor derived_background exists', async () => {
    const logos = await rebuild([
      { id: ID_C, tags: ['primary'], derived_background: null },
      { id: ID_D, tags: ['primary'] },
    ]);
    for (const logo of logos) expect(logo).not.toHaveProperty('background');
  });
});
