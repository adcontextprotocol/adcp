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
 * fixture lives in code (TypeScript module) and on disk (sibling `.json`
 * files) — `.json` shape is what gets served at the HTTP endpoints; the
 * module export gives in-process consumers (storyboards, conformance tests)
 * a typed surface.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

function load(filename: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, filename), 'utf8'));
}

export const NORTHWIND_BRAND_JSON = load('northwind-brand.json');
export const STREAMHAUS_BRAND_JSON = load('streamhaus-brand.json');
export const STREAMHAUS_ADAGENTS_JSON = load('streamhaus-adagents.json');
export const SPORTSHAUS_HOLDINGS_BRAND_JSON = load('sportshaus-holdings-brand.json');

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
