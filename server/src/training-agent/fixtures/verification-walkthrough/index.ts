/**
 * Fixture documents for the seller-verification walkthrough at
 * `docs/verification/overview`. Three brand.json variants + one adagents.json
 * forming a mutual-assertion chain:
 *
 *   - Northwind Media (independent agency, standalone canonical brand doc)
 *   - StreamHaus (publisher, sub-brand of Sportshaus Holdings via house_domain)
 *   - StreamHaus's adagents.json (authorizes Northwind to sell with
 *     delegation_type: "delegated", names Northwind's signing key by kid)
 *   - Sportshaus Holdings (parent house, brand_refs[] points back at
 *     StreamHaus — completes the bilateral parent/sub-brand assertion)
 *
 * Schema-conformant per `static/schemas/source/{brand,adagents}.json`. The
 * documents are inlined as TS object literals so the build emits the data
 * directly and no filesystem reads happen at runtime — Fly's dist/ layout
 * doesn't copy sibling JSON, so a `readFileSync` here would crash the route
 * handler.
 */

export const NORTHWIND_BRAND_JSON = {
  $schema: '/schemas/brand.json',
  version: '1.0',
  id: 'northwind_media',
  names: [{ en_US: 'Northwind Media' }],
  url: 'https://northwind.example',
  keller_type: 'master',
  industries: ['advertising'],
  description:
    'Independent agency representing publisher inventory under delegated authority. Fixture for the seller-verification walkthrough (docs/verification/overview).',
  agents: [
    {
      type: 'sales',
      id: 'northwind_sales',
      url: 'https://northwind.example/mcp',
      jwks_uri: 'https://northwind.example/.well-known/jwks.json',
      description:
        'Northwind Media sales agent — sells StreamHaus CTV inventory under delegated authority.',
    },
  ],
  last_updated: '2026-04-12T10:00:00Z',
} as const;

export const STREAMHAUS_BRAND_JSON = {
  $schema: '/schemas/brand.json',
  version: '1.0',
  id: 'streamhaus',
  names: [{ en_US: 'StreamHaus' }],
  url: 'https://streamhaus.example',
  house_domain: 'sportshaus-holdings.example',
  keller_type: 'endorsed',
  industries: ['media', 'broadcasting'],
  description:
    'Sports CTV publisher; sub-brand of Sportshaus Holdings under an endorsed Keller-architecture relationship. Fixture for the seller-verification walkthrough.',
  agents: [
    {
      type: 'sales',
      id: 'streamhaus_sales',
      url: 'https://streamhaus.example/mcp',
      jwks_uri: 'https://streamhaus.example/.well-known/jwks.json',
      description:
        'StreamHaus internal sales agent — publisher-direct path. Most inventory routes through Northwind Media under delegated authority (see adagents.json).',
    },
  ],
  last_updated: '2026-04-12T10:00:00Z',
} as const;

export const STREAMHAUS_ADAGENTS_JSON = {
  $schema: '/schemas/adagents.json',
  contact: {
    name: 'StreamHaus Publishing',
    email: 'adops@streamhaus.example',
    domain: 'streamhaus.example',
  },
  properties: [
    {
      property_id: 'streamhaus_ctv',
      property_type: 'ctv_app',
      name: 'StreamHaus CTV App',
      publisher_domain: 'streamhaus.example',
      identifiers: [
        { type: 'roku_store_id', value: '12345' },
        { type: 'domain', value: 'streamhaus.example' },
      ],
    },
  ],
  authorized_agents: [
    {
      url: 'https://northwind.example/mcp',
      authorized_for: 'StreamHaus CTV inventory via delegated authority',
      authorization_type: 'property_ids',
      property_ids: ['streamhaus_ctv'],
      delegation_type: 'delegated',
      signing_keys: [
        {
          kid: 'northwind-sell-prod-2026',
          kty: 'OKP',
          alg: 'EdDSA',
          crv: 'Ed25519',
          x: 'Xe2lAKRJR_zr3FQRdSNwp3zsrv_IXnVCWJXDcWXwkLI',
          use: 'sig',
        },
      ],
    },
  ],
  last_updated: '2026-04-12T10:00:00Z',
} as const;

export const SPORTSHAUS_HOLDINGS_BRAND_JSON = {
  $schema: '/schemas/brand.json',
  version: '1.0',
  house: {
    domain: 'sportshaus-holdings.example',
    name: 'Sportshaus Holdings',
    architecture: 'house_of_brands',
  },
  brand_refs: [
    { domain: 'streamhaus.example', brand_id: 'streamhaus', effective_at: '2025-01-01T00:00:00Z' },
    { domain: 'courtsidehq.example', brand_id: 'courtsidehq' },
  ],
  // Buy-side operator authorization — who may represent these brands when
  // BUYING (agency-of-record, platforms, in-house teams). Distinct from the
  // sell-side agent delegation in StreamHaus's adagents.json (who may SELL
  // StreamHaus inventory). Third parties verify an operator by resolving its
  // domain against this list and checking brands[]/countries/scopes.
  authorized_operators: [
    // Agency-of-record for the whole portfolio (brands: ['*']).
    { domain: 'meridian-agency.example', brands: ['*'], scopes: ['media_buying', 'creative_generation', 'measurement'] },
    // Brand-scoped, US-only in-house operator — authorized for courtsidehq
    // only, so it is NOT authorized to buy for streamhaus.
    { domain: 'courtside-inhouse.example', brands: ['courtsidehq'], countries: ['US'], scopes: ['media_buying'] },
  ],
  contact: {
    name: 'Sportshaus Brand Operations',
    email: 'brands@sportshaus-holdings.example',
  },
  last_updated: '2026-04-12T10:00:00Z',
} as const;

/** Map of fixture-walkthrough role → served documents. Used by the HTTP
 *  mount in `index.ts` to expose each role's documents under
 *  `/fixtures/walkthrough/<role>/.well-known/<doc>`. */
export const WALKTHROUGH_FIXTURES = {
  northwind: {
    'brand.json': NORTHWIND_BRAND_JSON,
  },
  streamhaus: {
    'brand.json': STREAMHAUS_BRAND_JSON,
    'adagents.json': STREAMHAUS_ADAGENTS_JSON,
  },
  'sportshaus-holdings': {
    'brand.json': SPORTSHAUS_HOLDINGS_BRAND_JSON,
  },
} as const satisfies Record<string, Record<string, Record<string, unknown>>>;

export type WalkthroughRole = keyof typeof WALKTHROUGH_FIXTURES;
