/**
 * Security regression: Addie's upload_brand_logo MCP tool must respect the
 * same write-authority gate as the HTTP route (#4743).
 *
 * Before this PR, the tool hardcoded review_status='approved' and never
 * checked verified-owner state — making it a parallel door to the
 * route-level gate the PR adds. Pin:
 *
 *   1. Verified owner exists → tool refuses with verified_owner_required.
 *   2. No verified owner → upload queues as pending (never auto-approved).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDiscoveredBrandByDomain: vi.fn().mockResolvedValue(null),
  getHostedBrandByDomain: vi.fn(),
  insertBrandLogo: vi.fn(),
  countBrandLogos: vi.fn().mockResolvedValue(0),
  editDiscoveredBrand: vi.fn().mockResolvedValue({ brand: {}, revision_number: 1 }),
  createDiscoveredBrand: vi.fn().mockResolvedValue(undefined),
  upsertDiscoveredBrand: vi.fn().mockResolvedValue(undefined),
  listBrandLogos: vi.fn().mockResolvedValue([]),
  safeFetch: vi.fn(),
  detectContentType: vi.fn().mockResolvedValue('image/png'),
  sanitizeSvg: vi.fn(),
  computeSha256: vi.fn().mockReturnValue('sha256-stub'),
  extractDimensions: vi.fn().mockResolvedValue({ width: 64, height: 64 }),
  rebuildManifestLogos: vi.fn().mockResolvedValue(undefined),
  validateLogoTags: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock('../../src/db/brand-db.js', () => ({
  brandDb: {
    getDiscoveredBrandByDomain: mocks.getDiscoveredBrandByDomain,
    getHostedBrandByDomain: mocks.getHostedBrandByDomain,
    editDiscoveredBrand: mocks.editDiscoveredBrand,
    createDiscoveredBrand: mocks.createDiscoveredBrand,
    upsertDiscoveredBrand: mocks.upsertDiscoveredBrand,
  },
  BrandDatabase: class {
    getDiscoveredBrandByDomain = mocks.getDiscoveredBrandByDomain;
    getHostedBrandByDomain = mocks.getHostedBrandByDomain;
    editDiscoveredBrand = mocks.editDiscoveredBrand;
    createDiscoveredBrand = mocks.createDiscoveredBrand;
    upsertDiscoveredBrand = mocks.upsertDiscoveredBrand;
  },
}));

vi.mock('../../src/db/brand-logo-db.js', () => ({
  BrandLogoDatabase: class {
    insertBrandLogo = mocks.insertBrandLogo;
    countBrandLogos = mocks.countBrandLogos;
    listBrandLogos = mocks.listBrandLogos;
  },
}));

vi.mock('../../src/utils/url-security.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/url-security.js')>(
    '../../src/utils/url-security.js',
  );
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => mocks.safeFetch(...args),
  };
});

vi.mock('../../src/services/brand-logo-service.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/brand-logo-service.js')>(
    '../../src/services/brand-logo-service.js',
  );
  return {
    ...actual,
    detectContentType: mocks.detectContentType,
    sanitizeSvg: mocks.sanitizeSvg,
    computeSha256: mocks.computeSha256,
    extractDimensions: mocks.extractDimensions,
    rebuildManifestLogos: mocks.rebuildManifestLogos,
    validateLogoTags: mocks.validateLogoTags,
  };
});

import { createBrandToolHandlers } from '../../src/addie/mcp/brand-tools.js';

function fakeStreamResponse(buffer: Buffer) {
  let pulled = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (pulled) return { done: true, value: undefined };
          pulled = true;
          return { done: false, value: new Uint8Array(buffer) };
        },
        cancel: () => {},
      }),
    },
  };
}

describe('Addie upload_brand_logo write-authority gate', () => {
  let handlers: Map<string, (args: Record<string, unknown>) => Promise<string>>;
  let upload: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeFetch.mockResolvedValue(fakeStreamResponse(Buffer.from('fake-png-bytes')));
    mocks.countBrandLogos.mockResolvedValue(0);
    mocks.detectContentType.mockResolvedValue('image/png');
    mocks.validateLogoTags.mockReturnValue({ valid: true });
    mocks.insertBrandLogo.mockImplementation(async (input) => ({
      id: 'logo_addie_test',
      ...input,
    }));
    handlers = createBrandToolHandlers();
    upload = handlers.get('upload_brand_logo')!;
  });

  it('refuses with verified_owner_required when the brand has a verified DNS owner', async () => {
    mocks.getHostedBrandByDomain.mockResolvedValue({
      workos_organization_id: 'org_owner',
      domain_verified: true,
    });
    const result = await upload({
      domain: 'fandom.com',
      logo_url: 'https://example.com/fandom-logo.png',
      tags: ['primary'],
    });
    const parsed = JSON.parse(result);
    expect(parsed.code).toBe('verified_owner_required');
    expect(mocks.insertBrandLogo).not.toHaveBeenCalled();
  });

  it('queues uploads as pending when no verified owner exists', async () => {
    mocks.getHostedBrandByDomain.mockResolvedValue(null);
    const result = await upload({
      domain: 'unowned.example',
      logo_url: 'https://example.com/logo.png',
      tags: ['primary'],
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.review_status).toBe('pending');
    expect(mocks.insertBrandLogo).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'community',
        review_status: 'pending',
        uploaded_by_user_id: 'system:addie',
      }),
    );
  });

  it('queues uploads as pending when the brand exists but is not domain-verified', async () => {
    mocks.getHostedBrandByDomain.mockResolvedValue({
      workos_organization_id: 'org_someone',
      domain_verified: false,
    });
    const result = await upload({
      domain: 'pending.example',
      logo_url: 'https://example.com/logo.png',
      tags: ['primary'],
    });
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.review_status).toBe('pending');
  });
});
