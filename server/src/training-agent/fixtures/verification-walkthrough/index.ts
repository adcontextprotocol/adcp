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
 * Schema-conformant per `static/schemas/source/{brand,adagents}.json`. JSON
 * documents are statically imported so the build emits the data inline and
 * no filesystem reads happen at runtime — Fly's dist/ layout doesn't copy
 * sibling JSON, so a `readFileSync` here would crash the route handler.
 */
import northwindBrand from './northwind-brand.json';
import streamhausBrand from './streamhaus-brand.json';
import streamhausAdagents from './streamhaus-adagents.json';
import sportshausHoldingsBrand from './sportshaus-holdings-brand.json';

export const NORTHWIND_BRAND_JSON = northwindBrand;
export const STREAMHAUS_BRAND_JSON = streamhausBrand;
export const STREAMHAUS_ADAGENTS_JSON = streamhausAdagents;
export const SPORTSHAUS_HOLDINGS_BRAND_JSON = sportshausHoldingsBrand;

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
