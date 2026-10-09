import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { verifySupplyPath, parseInventoryPartnerDomains, supplyPathAdsTxtPolicy, combineInventoryPartnerDomains } from '../../../src/services/supply-path-verifier.js';

const corpus = JSON.parse(readFileSync(new URL('../../../../static/compliance/source/test-vectors/supply-path/vectors.json', import.meta.url), 'utf8'));
// The normative projection includes every leg's boolean and failure code.
// Human diagnostics and ancillary evidence are intentionally additive.
function project(result: ReturnType<typeof verifySupplyPath>) {
  return { ...(result.resolved_collection_id ? { resolved_collection_id: result.resolved_collection_id } : {}), semantics_version: result.semantics_version, state: result.state, legs: Object.fromEntries(Object.entries(result.legs).map(([key, leg]) => [key, { ok: leg.ok, ...(leg.failure ? { failure: leg.failure } : {}) }])) };
}
describe('canonical shared supply-path vectors', () => {
  for (const vector of corpus.ads_txt_policy_vectors) it(vector.id, () => expect(supplyPathAdsTxtPolicy(vector.input)).toEqual(vector.expected));
  for (const vector of corpus.inventory_partner_combination_vectors) it(vector.id, () => expect(combineInventoryPartnerDomains(vector.contents, vector.requireAll)).toEqual(vector.expected));
  for (const vector of corpus.vectors) it(vector.id, () => expect(project(verifySupplyPath(vector.input))).toEqual(vector.expected));
  for (const vector of corpus.inventory_partner_domain_vectors) it(vector.id, () => expect(parseInventoryPartnerDomains(vector.text)).toEqual(vector.expected));
});
