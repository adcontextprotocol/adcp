// Delegation-chain vectors (L2 Grants in trust records): a reference evaluator of the one rule asserts every vector.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static/schemas/source');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../static/test-vectors/delegation-chains.json'), 'utf8'));

// null means unrestricted: a global grant, or an unbounded end of the window.
const intersect = (a, b) => (a && b ? a.filter((x) => b.includes(x)) : a ?? b);
const pick = (prefer) => (a, b) => (a && b ? (prefer(Date.parse(a), Date.parse(b)) ? a : b) : a ?? b);

/** A grant covers the claim when its brands, countries, scope, window, and agents[] all cover it. */
function covers(grant, { brand, scope, check_time: now, signer }) {
  const brands = grant.profiles?.adcp?.brands;
  const t = Date.parse(now);
  return grant.scopes.includes(scope)
    && (!brands || brands.includes('*') || (brand.brand_id !== undefined && brands.includes(brand.brand_id)))
    && (!grant.countries || (brand.countries !== undefined && brand.countries.every((c) => grant.countries.includes(c))))
    && (!grant.valid_from || Date.parse(grant.valid_from) <= t)
    && (!grant.valid_until || t < Date.parse(grant.valid_until))
    && (!grant.agents || grant.agents.some((agent) => new URL(agent.url).origin === signer.origin));
}

/** The one rule: at most two grants from the parent organization to the signer's operator. */
function evaluate(input) {
  const { brand, account_operator: operator, signer } = input;
  const parent = input.parent_organization ?? brand.domain;
  const self = [brand.domain, parent];
  if (self.includes(operator) && self.includes(signer.operator)) return { outcome: 'implicit' };

  const record = (domain) => input.trust_records[domain] ?? { grants: [] };
  for (const first of record(parent).grants.filter((g) => covers(g, input))) {
    if (![...self, first.grantee].includes(operator)) continue;
    const second = record(first.grantee).grants.find((g) => g.grantee === signer.operator && covers(g, input));
    const chain = first.grantee === signer.operator ? [first] : second && [first, second];
    if (chain) return authorized(chain);
  }
  return { outcome: 'grant_absent' };
}

function authorized(chain) {
  return {
    outcome: 'authorized',
    effective: {
      scopes: chain.map((g) => g.scopes).reduce(intersect).sort(),
      countries: chain.map((g) => g.countries ?? null).reduce(intersect)?.sort() ?? null,
      valid_from: chain.map((g) => g.valid_from ?? null).reduce(pick((a, b) => a > b)),
      valid_until: chain.map((g) => g.valid_until ?? null).reduce(pick((a, b) => a < b)),
    },
  };
}

test('vector ids are unique', () => {
  const ids = fixture.vectors.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every trust record in the vectors is a valid trust.json', async () => {
  const loadSchema = async (uri) => JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  addFormats(ajv);
  const validate = await ajv.compileAsync(await loadSchema('/schemas/trust/v1/trust.json'));
  for (const v of fixture.vectors) {
    for (const [domain, record] of Object.entries(v.input.trust_records)) {
      assert.equal(validate(record), true, `${v.id} ${domain}: ${JSON.stringify(validate.errors)}`);
    }
  }
});

for (const v of fixture.vectors) {
  test(`${v.id}: ${v.expected.outcome}`, () => {
    assert.deepEqual(evaluate(v.input), v.expected);
  });
}
