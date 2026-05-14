/**
 * Unit tests for the brand-canonical-document Addie tools (#4527).
 *
 * Coverage:
 *  1. publish_brand_canonical_document — validates against the real source
 *     schema in static/schemas/source/brand.json. Catches misshapen docs and
 *     surfaces schema errors instead of returning an invalid document.
 *  2. add_to_brand_refs — enforces the spec's cross-array uniqueness
 *     invariants (brand_id not in brands[]+brand_refs[], unique by domain
 *     and brand_id within brand_refs[]).
 *  3. check_mutual_assertion — classifies the four trust tiers + redirect
 *     following on the house side. Network fetches are mocked.
 *  4. notify_pending_verification — log-only (feature flag off, the
 *     default), rate-limited per {leaf, house} pair via a stubbed DB.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock safeFetch before importing the SUT so the import-time module graph
// picks up the mock for any network calls.
vi.mock('../../../src/utils/url-security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/url-security.js')>();
  return {
    ...actual,
    safeFetch: vi.fn(),
  };
});

// Stub the DB client — notify_pending_verification reaches into Postgres
// for rate-limit state; rebuild that surface in memory for the tests.
const dbState = new Map<string, { last_notified_at: Date; notification_count: number }>();

vi.mock('../../../src/db/client.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[]) => {
    // Parse the two statements the SUT issues. This is a thin behavioural
    // stub — we only need it to round-trip the cooldown logic. The test
    // file is the only caller of this mock so we don't need to handle
    // arbitrary SQL.
    if (sql.includes('INSERT INTO brand_assertion_notifications')) {
      const [leaf, house, now, threshold] = params as [string, string, Date, Date];
      const key = `${leaf}|${house}`;
      const existing = dbState.get(key);
      if (!existing) {
        dbState.set(key, { last_notified_at: now, notification_count: 1 });
        return { rowCount: 1, rows: [{ last_notified_at: now, inserted: true }] };
      }
      if (existing.last_notified_at < threshold) {
        existing.last_notified_at = now;
        existing.notification_count += 1;
        return { rowCount: 1, rows: [{ last_notified_at: now, inserted: false }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT last_notified_at FROM brand_assertion_notifications')) {
      const [leaf, house] = params as [string, string];
      const key = `${leaf}|${house}`;
      const existing = dbState.get(key);
      return {
        rowCount: existing ? 1 : 0,
        rows: existing ? [{ last_notified_at: existing.last_notified_at }] : [],
      };
    }
    throw new Error(`Unexpected SQL in test: ${sql.slice(0, 80)}`);
  }),
}));

import { safeFetch } from '../../../src/utils/url-security.js';
import {
  publishBrandCanonicalDocument,
  addToBrandRefs,
  checkMutualAssertion,
  notifyPendingVerification,
  BRAND_CANONICAL_TOOLS,
  createBrandCanonicalToolHandlers,
} from '../../../src/addie/mcp/brand-canonical-tools.js';

const mockedSafeFetch = vi.mocked(safeFetch);

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  mockedSafeFetch.mockReset();
  dbState.clear();
});

describe('publish_brand_canonical_document', () => {
  it('builds a schema-valid Brand Canonical Document for a sub-brand under a house', () => {
    const result = publishBrandCanonicalDocument({
      domain: 'converse.com',
      brand_id: 'converse',
      names: [{ en_US: 'Converse' }],
      house_domain: 'nikeinc.com',
      keller_type: 'sub_brand',
      tagline: 'Sneakers for the streets',
      logos: [{ url: 'https://converse.com/logo.svg', variant: 'primary' }],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
    expect(result.hosting_path).toBe('https://converse.com/.well-known/brand.json');
    expect(result.document).toMatchObject({
      id: 'converse',
      names: [{ en_US: 'Converse' }],
      house_domain: 'nikeinc.com',
      keller_type: 'sub_brand',
    });
  });

  it('builds a schema-valid standalone Brand Canonical Document when house_domain omitted', () => {
    const result = publishBrandCanonicalDocument({
      domain: 'patagonia.com',
      brand_id: 'patagonia',
      names: [{ en_US: 'Patagonia' }],
      keller_type: 'independent',
      tagline: "We're in business to save our home planet.",
    });

    expect(result.ok).toBe(true);
    expect(result.document?.house_domain).toBeUndefined();
  });

  it('rejects an invalid brand_id pattern', () => {
    const result = publishBrandCanonicalDocument({
      domain: 'example.com',
      brand_id: 'Has-Hyphen', // invalid: uppercase + hyphen
      names: [{ en: 'Example' }],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/brand_id/);
  });

  it('rejects when names is empty', () => {
    const result = publishBrandCanonicalDocument({
      domain: 'example.com',
      brand_id: 'example',
      names: [],
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/names/);
  });

  it('strips disallowed top-level fields from `extra`', () => {
    const result = publishBrandCanonicalDocument({
      domain: 'example.com',
      brand_id: 'example',
      names: [{ en: 'Example' }],
      extra: {
        house: { domain: 'evil.com', name: 'Evil' }, // forbidden on canonical doc
        brand_refs: [{ domain: 'other.com', brand_id: 'other' }], // forbidden
        tagline: 'From extra', // allowed
      } as Record<string, unknown>,
    });

    expect(result.ok).toBe(true);
    expect(result.document?.house).toBeUndefined();
    expect(result.document?.brand_refs).toBeUndefined();
    expect(result.document?.tagline).toBe('From extra');
  });

  it('normalizes domain inputs (strips protocol/path)', () => {
    const result = publishBrandCanonicalDocument({
      domain: 'https://converse.com/some/path',
      brand_id: 'converse',
      names: [{ en: 'Converse' }],
    });

    expect(result.ok).toBe(true);
    expect(result.hosting_path).toBe('https://converse.com/.well-known/brand.json');
  });
});

describe('add_to_brand_refs', () => {
  const baseHouseJson = {
    $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
    version: '1.0',
    house: {
      domain: 'nikeinc.com',
      name: 'Nike, Inc.',
    },
    brands: [
      {
        id: 'nike_sb',
        names: [{ en: 'Nike SB' }],
        keller_type: 'sub_brand',
      },
    ],
  };

  it('appends a new brand_refs entry to a portfolio with only inline brands', async () => {
    const result = await addToBrandRefs({
      house_brand_json: baseHouseJson,
      child_domain: 'converse.com',
      brand_id: 'converse',
      effective_at: '2026-05-14T00:00:00Z',
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined();
    const refs = result.brand_json?.brand_refs as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      domain: 'converse.com',
      brand_id: 'converse',
      effective_at: '2026-05-14T00:00:00Z',
    });
  });

  it('rejects when brand_id already appears in brands[] (cross-array uniqueness)', async () => {
    const result = await addToBrandRefs({
      house_brand_json: baseHouseJson,
      child_domain: 'nike-sb.com',
      brand_id: 'nike_sb', // conflicts with brands[].id
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/both brands\[\] and brand_refs\[\]/);
  });

  it('rejects when domain already appears in brand_refs[] (within-array uniqueness)', async () => {
    const withRefs = {
      ...baseHouseJson,
      brand_refs: [{ domain: 'converse.com', brand_id: 'converse' }],
    };
    const result = await addToBrandRefs({
      house_brand_json: withRefs,
      child_domain: 'converse.com',
      brand_id: 'converse_2',
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/domain.*unique/);
  });

  it('rejects when brand_id already appears in brand_refs[] (within-array uniqueness)', async () => {
    const withRefs = {
      ...baseHouseJson,
      brand_refs: [{ domain: 'converse.com', brand_id: 'converse' }],
    };
    const result = await addToBrandRefs({
      house_brand_json: withRefs,
      child_domain: 'converse-alt.com',
      brand_id: 'converse',
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/brand_id.*unique/);
  });

  it('rejects when house_brand_json is not a House Portfolio variant', async () => {
    const result = await addToBrandRefs({
      house_brand_json: { authoritative_location: 'https://example.com/brand.json' },
      child_domain: 'converse.com',
      brand_id: 'converse',
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/House Portfolio/);
  });

  it('rejects when neither house_brand_json nor house_domain provided', async () => {
    const result = await addToBrandRefs({
      child_domain: 'converse.com',
      brand_id: 'converse',
    });

    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toMatch(/Either house_brand_json or house_domain/);
  });

  it('fetches the house portfolio when house_domain is supplied', async () => {
    mockedSafeFetch.mockResolvedValueOnce(mockJsonResponse(baseHouseJson));

    const result = await addToBrandRefs({
      house_domain: 'nikeinc.com',
      child_domain: 'converse.com',
      brand_id: 'converse',
    });

    expect(result.ok).toBe(true);
    expect(mockedSafeFetch).toHaveBeenCalledWith(
      'https://nikeinc.com/.well-known/brand.json',
      expect.objectContaining({ maxRedirects: 3 }),
    );
  });
});

describe('check_mutual_assertion (trust-tier resolution)', () => {
  function canonicalDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
      version: '1.0',
      id: 'converse',
      names: [{ en_US: 'Converse' }],
      keller_type: 'sub_brand',
      ...overrides,
    };
  }

  function housePortfolio(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
      version: '1.0',
      house: { domain: 'nikeinc.com', name: 'Nike, Inc.' },
      contact: { name: 'Nike Brand Team', email: 'brand@nike.com' },
      brand_refs: [{ domain: 'converse.com', brand_id: 'converse' }],
      ...overrides,
    };
  }

  it('returns standalone when leaf has no house_domain (silence is dispositive)', async () => {
    mockedSafeFetch.mockResolvedValueOnce(mockJsonResponse(canonicalDoc({ house_domain: undefined })));

    const result = await checkMutualAssertion('patagonia.com');
    expect(result.tier).toBe('standalone');
    // Spec: standalone trumps third-party claim. We don't even fetch the house.
    expect(mockedSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('returns mutual when leaf claims house and house brand_refs[] reciprocates', async () => {
    mockedSafeFetch
      .mockResolvedValueOnce(mockJsonResponse(canonicalDoc({ house_domain: 'nikeinc.com' })))
      .mockResolvedValueOnce(mockJsonResponse(housePortfolio()));

    const result = await checkMutualAssertion('converse.com');
    expect(result.tier).toBe('mutual');
    expect(result.leaf_house_domain).toBe('nikeinc.com');
    expect(result.resolved_house_domain).toBe('nikeinc.com');
    expect(result.house_contact_email).toBe('brand@nike.com');
  });

  it('returns leaf_only when leaf claims house but house brand_refs[] is silent', async () => {
    mockedSafeFetch
      .mockResolvedValueOnce(mockJsonResponse(canonicalDoc({ house_domain: 'nikeinc.com' })))
      .mockResolvedValueOnce(mockJsonResponse(housePortfolio({ brand_refs: [] })));

    const result = await checkMutualAssertion('converse.com');
    expect(result.tier).toBe('leaf_only');
    expect(result.house_contact_email).toBe('brand@nike.com');
  });

  it('follows House Redirect on the house side (Conformance MUST)', async () => {
    mockedSafeFetch
      .mockResolvedValueOnce(mockJsonResponse(canonicalDoc({ house_domain: 'dentsu.com' })))
      // dentsu.com is now a House Redirect → wpp.com
      .mockResolvedValueOnce(mockJsonResponse({ house: 'wpp.com' }))
      // wpp.com is a portfolio that reciprocates converse.com
      .mockResolvedValueOnce(mockJsonResponse(housePortfolio({
        house: { domain: 'wpp.com', name: 'WPP plc' },
        brand_refs: [{ domain: 'converse.com', brand_id: 'converse' }],
      })));

    const result = await checkMutualAssertion('converse.com');
    expect(result.tier).toBe('mutual');
    expect(result.leaf_house_domain).toBe('dentsu.com');
    expect(result.resolved_house_domain).toBe('wpp.com');
    expect(result.redirect_chain).toEqual(['dentsu.com', 'wpp.com']);
  });

  it('returns unverifiable when the redirect chain exceeds 3 hops', async () => {
    mockedSafeFetch
      .mockResolvedValueOnce(mockJsonResponse(canonicalDoc({ house_domain: 'a.com' })))
      .mockResolvedValueOnce(mockJsonResponse({ house: 'b.com' }))
      .mockResolvedValueOnce(mockJsonResponse({ house: 'c.com' }))
      .mockResolvedValueOnce(mockJsonResponse({ house: 'd.com' }))
      .mockResolvedValueOnce(mockJsonResponse({ house: 'e.com' }));

    const result = await checkMutualAssertion('converse.com');
    expect(result.tier).toBe('unverifiable');
    expect(result.errors?.[0]).toMatch(/3-hop redirect limit/);
  });

  it('returns unverifiable when the leaf fetch fails', async () => {
    mockedSafeFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'not found',
    } as unknown as Response);

    const result = await checkMutualAssertion('converse.com');
    expect(result.tier).toBe('unverifiable');
    expect(result.errors?.[0]).toMatch(/leaf/);
  });

  it('returns unverifiable when the house fetch fails', async () => {
    mockedSafeFetch
      .mockResolvedValueOnce(mockJsonResponse(canonicalDoc({ house_domain: 'nikeinc.com' })))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await checkMutualAssertion('converse.com');
    expect(result.tier).toBe('unverifiable');
    expect(result.errors?.[0]).toMatch(/house/);
  });
});

describe('notify_pending_verification (rate-limit + log-only default)', () => {
  it('returns log_only on the first call when the feature flag is off (default)', async () => {
    const result = await notifyPendingVerification({
      leaf_domain: 'converse.com',
      house_domain: 'nikeinc.com',
      house_contact_email: 'brand@nike.com',
    });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('log_only');
  });

  it('rate-limits a second call within the 24h cooldown to the same {leaf, house}', async () => {
    await notifyPendingVerification({
      leaf_domain: 'converse.com',
      house_domain: 'nikeinc.com',
      house_contact_email: 'brand@nike.com',
    });
    const second = await notifyPendingVerification({
      leaf_domain: 'converse.com',
      house_domain: 'nikeinc.com',
      house_contact_email: 'brand@nike.com',
    });

    expect(second.ok).toBe(true);
    expect(second.sent).toBe(false);
    expect(second.reason).toBe('rate_limited');
    expect(second.next_eligible_at).toBeDefined();
  });

  it('allows a separate {leaf, house} pair through even when one is rate-limited', async () => {
    await notifyPendingVerification({
      leaf_domain: 'converse.com',
      house_domain: 'nikeinc.com',
      house_contact_email: 'brand@nike.com',
    });
    const otherLeaf = await notifyPendingVerification({
      leaf_domain: 'jordan.com',
      house_domain: 'nikeinc.com',
      house_contact_email: 'brand@nike.com',
    });

    expect(otherLeaf.reason).toBe('log_only');
  });

  it('rejects an invalid email address before touching the DB', async () => {
    const result = await notifyPendingVerification({
      leaf_domain: 'converse.com',
      house_domain: 'nikeinc.com',
      house_contact_email: 'not-an-email',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_email');
  });
});

describe('BRAND_CANONICAL_TOOLS schema surface', () => {
  it('exposes all four tools required by issue #4527', () => {
    const names = BRAND_CANONICAL_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_to_brand_refs',
      'check_mutual_assertion',
      'notify_pending_verification',
      'publish_brand_canonical_document',
    ]);
  });

  it('every tool declares input_schema with `type: object`', () => {
    for (const tool of BRAND_CANONICAL_TOOLS) {
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema.properties).toBeDefined();
    }
  });

  it('handler factory registers a handler for each tool', () => {
    const handlers = createBrandCanonicalToolHandlers();
    for (const tool of BRAND_CANONICAL_TOOLS) {
      expect(handlers.get(tool.name)).toBeTypeOf('function');
    }
  });
});

describe('handler surface (JSON contract)', () => {
  const handlers = createBrandCanonicalToolHandlers();

  it('publish_brand_canonical_document returns ok=true on a valid doc', async () => {
    const json = await handlers.get('publish_brand_canonical_document')!({
      domain: 'converse.com',
      brand_id: 'converse',
      names: [{ en_US: 'Converse' }],
    });
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.document.id).toBe('converse');
  });

  it('publish_brand_canonical_document returns validation_failed on bad input', async () => {
    const json = await handlers.get('publish_brand_canonical_document')!({
      domain: 'converse.com',
      brand_id: 'BAD ID',
      names: [{ en: 'Converse' }],
    });
    const parsed = JSON.parse(json);
    expect(parsed.error).toBe('validation_failed');
    expect(parsed.errors).toBeDefined();
  });

  it('check_mutual_assertion handler returns parsed tier from the resolver', async () => {
    mockedSafeFetch.mockResolvedValueOnce(
      mockJsonResponse({
        $schema: 'https://adcontextprotocol.org/schemas/latest/brand.json',
        id: 'patagonia',
        names: [{ en: 'Patagonia' }],
      }),
    );
    const json = await handlers.get('check_mutual_assertion')!({ leaf_domain: 'patagonia.com' });
    const parsed = JSON.parse(json);
    expect(parsed.tier).toBe('standalone');
  });
});
