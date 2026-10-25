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
    && (!brands || brands.includes('*') || brands.includes(brand.brand_id))
    && (!grant.countries || (brand.countries !== undefined && brand.countries.every((c) => grant.countries.includes(c))))
    && (!grant.valid_from || Date.parse(grant.valid_from) <= t)
    && (!grant.valid_until || t < Date.parse(grant.valid_until))
    && (!grant.agents || grant.agents.some((agent) => new URL(agent.url).origin === signer.origin));
}

/**
 * The one rule: at most two grants from the parent organization to the signer's operator.
 * An uncovered claim is `grant_absent` under an exclusive parent record, and `seller_discretion` otherwise.
 */
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
  return { outcome: record(parent).exclusive_grants === true ? 'grant_absent' : 'seller_discretion' };
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

// Single-fault proofs. Every vector can fail for one reason only, so an SDK that checks the premises in another
// order, or skips one, fails a vector. A negative vector names the one change that authorizes it. A positive vector
// names its only delegation chain, as grantor > grantee > grantee. An implicit vector has no delegation chain at all.
// A repair authorizes the claim, or gives implicit authority when the vector targets that.

const parentOf = (input) => input.parent_organization ?? input.brand.domain;

/** Every delegation chain that covers the claim. It enumerates candidates instead of stopping at the first. */
function coveringChains(input) {
  const parent = parentOf(input);
  const grantsOf = (domain) => (input.trust_records[domain]?.grants ?? []).map((grant, n) => ({ domain, n, grant }));
  return grantsOf(parent)
    .flatMap((first) => [[first], ...grantsOf(first.grant.grantee).map((second) => [first, second])])
    .filter((chain) => chain.at(-1).grant.grantee === input.signer.operator
      && chain.every(({ grant }) => covers(grant, input))
      && [input.brand.domain, parent, chain[0].grant.grantee].includes(input.account_operator));
}

const [PARENT, BRAND, AGENCY, PLATFORM] = ['nova-holdings', 'nova-motors', 'pinnacle-agency', 'orbit-platform'].map((d) => `${d}.example`);
const grant = (input, domain, n = 0) => input.trust_records[domain].grants[n];
const coverBrand = (i) => { grant(i, PARENT).profiles.adcp.brands = ['nova_motors']; };
const coverScope = (i) => { grant(i, PARENT).scopes = ['adcp:media_buying']; };
const IMPLICIT = { implicit: true };

const PROOFS = {
  'parent-grants-signer-operator': { chain: 'nova-holdings > pinnacle-agency' },
  'brand-operates-account-through-hosted-agent': { chain: 'nova-holdings > orbit-platform' },
  'agency-works-through-platform': { chain: 'nova-holdings > pinnacle-agency > orbit-platform' },
  'parent-operates-account-through-hosted-agent': { chain: 'nova-holdings > orbit-platform' },
  'parent-operates-account-on-two-grant-chain': { chain: 'nova-holdings > pinnacle-agency > orbit-platform' },
  'brand-operates-account-on-two-grant-chain': { chain: 'nova-holdings > pinnacle-agency > orbit-platform' },
  'implicit-authority-brand': IMPLICIT,
  'implicit-authority-parent': IMPLICIT,
  'agency-account-brand-signer-denied': { repair: (i) => { i.account_operator = BRAND; }, to: 'implicit' },
  'standalone-brand-record-authorizes': { chain: 'nova-motors > pinnacle-agency' },
  'three-grant-chain-denied': { repair: (i) => { grant(i, AGENCY).grantee = 'relay-exchange.example'; } },
  'account-operator-not-on-chain-denied': { repair: (i) => { i.account_operator = PLATFORM; } },
  'account-operator-is-second-grantee-denied': { repair: (i) => { i.account_operator = AGENCY; } },
  'first-grant-narrowed-to-agency-agents-denied': { repair: (i) => { delete grant(i, PARENT).agents; } },
  'countries-and-window-intersect': { chain: 'nova-holdings > pinnacle-agency > orbit-platform' },
  'window-intersect-first-grant-starts-later': { chain: 'nova-holdings > pinnacle-agency > orbit-platform' },
  'brand-country-outside-intersection-denied': { repair: (i) => { grant(i, AGENCY).countries.push('GB'); } },
  'brand-without-countries-needs-global-grant-denied': { repair: (i) => { delete grant(i, PARENT).countries; } },
  'check-time-outside-window-denied': { repair: (i) => { grant(i, PARENT).valid_until = '2027-12-31T00:00:00Z'; } },
  'check-time-before-second-grant-denied': { repair: (i) => { delete grant(i, AGENCY).valid_from; } },
  'brand-not-covered-denied': { repair: coverBrand },
  'wildcard-brands-grant-authorizes': { chain: 'nova-holdings > pinnacle-agency' },
  'scope-mismatch-denied': { repair: coverScope },
  'brand-record-ignored-when-parent-denies': { repair: (i) => { i.parent_organization = null; } },
  'brand-record-ignored-when-parent-grants': { chain: 'nova-holdings > orbit-platform' },
  'brand-record-supplies-second-grant': { chain: 'nova-holdings > nova-motors > orbit-platform' },
  'exclusive-no-grants-denied': { repair: (i) => { i.trust_records[PARENT].grants.push({ grantee: AGENCY, scopes: ['adcp:media_buying'] }); } },
  'nonexclusive-uncovered-seller-discretion': { repair: coverScope, twin: 'scope-mismatch-denied' },
  'nonexclusive-nonmatching-grant-seller-discretion': { repair: coverBrand, twin: 'brand-not-covered-denied' },
  'exclusive-brand-record-seller-discretion': { repair: coverBrand, twin: 'brand-not-covered-denied' },
};

/** One change per covering condition. Each one makes the grant stop covering the claim. */
const BREAKS = {
  brands: (g) => { g.profiles = { adcp: { brands: ['another_brand'] } }; },
  countries: (g) => { g.countries = ['AQ']; },
  scopes: (g) => { g.scopes = ['adcp:another_scope']; },
  valid_from: (g, i) => { g.valid_from = new Date(Date.parse(i.check_time) + 1000).toISOString(); },
  valid_until: (g, i) => { g.valid_until = i.check_time; },
  agents: (g) => { g.agents = [{ url: 'https://elsewhere.example/mcp' }]; },
};

const variant = (input, change) => { const copy = structuredClone(input); change(copy); return copy; };
const chainPath = (chain) => [chain[0].domain, ...chain.map(({ grant: g }) => g.grantee)].map((d) => d.replace(/\.example$/, '')).join(' > ');
/** JSON paths where two inputs differ. Arrays of values compare whole, and an added or removed object is one path. */
function changedPaths(a, b, at = '$') {
  const isObject = (x) => x !== null && typeof x === 'object';
  const values = (x) => Array.isArray(x) && x.every((e) => !isObject(e));
  if (isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b) && !(values(a) && values(b))) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => changedPaths(a[k], b[k], `${at}.${k}`));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}
/** The input with every exclusive_grants removed; a record left with no grants is the same as no record. */
const withoutExclusivity = (input) => ({
  ...input,
  trust_records: Object.fromEntries(Object.entries(input.trust_records)
    .filter(([, record]) => record.grants.length > 0)
    .map(([domain, { exclusive_grants, ...record }]) => [domain, record])),
});

test('every vector has a single-fault proof', () => {
  assert.deepEqual(Object.keys(PROOFS).sort(), fixture.vectors.map((v) => v.id).sort());
});

// Only the parent organization's exclusive_grants counts. Another record sets it only in a vector that shows it's ignored.
const SHOWS_OTHER_EXCLUSIVITY_IGNORED = ['brand-record-ignored-when-parent-grants', 'exclusive-brand-record-seller-discretion'];
test('exclusive_grants outside the parent organization record appears only where a vector shows it is ignored', () => {
  for (const v of fixture.vectors) {
    const others = Object.keys(v.input.trust_records).filter((d) => d !== parentOf(v.input) && 'exclusive_grants' in v.input.trust_records[d]);
    assert.equal(others.length > 0, SHOWS_OTHER_EXCLUSIVITY_IGNORED.includes(v.id), v.id);
    const cleared = variant(v.input, (i) => others.forEach((d) => { delete i.trust_records[d].exclusive_grants; }));
    assert.deepEqual(evaluate(cleared), v.expected, v.id);
  }
});

for (const v of fixture.vectors) {
  test(`${v.id}: single fault`, () => {
    const proof = PROOFS[v.id];
    const chains = coveringChains(v.input);
    const { outcome } = v.expected;
    if (outcome === 'implicit') {
      assert.equal(proof, IMPLICIT);
      assert.deepEqual(chains, [], 'implicit authority must be the only reason the claim passes');
    } else if (outcome === 'authorized') {
      assert.deepEqual(chains.map(chainPath), [proof.chain], 'exactly one delegation chain covers the claim');
      assert.deepEqual(authorized(chains[0].map(({ grant: g }) => g)).effective, v.expected.effective);
      const denies = (change, why) => assert.notEqual(evaluate(variant(v.input, change)).outcome, 'authorized', why);
      denies((i) => { i.account_operator = 'elsewhere.example'; }, 'account.operator off the chain');
      for (const { domain, n } of chains[0]) {
        denies((i) => { i.trust_records[domain].grants.splice(n, 1); }, `without ${domain} grant ${n}`);
        for (const [name, breakIt] of Object.entries(BREAKS)) {
          denies((i) => breakIt(grant(i, domain, n), i), `${domain} grant ${n} with ${name} broken`);
        }
      }
    } else {
      assert.deepEqual(chains, []);
      assert.equal(typeof proof.repair, 'function', 'a negative vector names its repair');
      const repaired = variant(v.input, proof.repair);
      assert.equal(changedPaths(v.input, repaired).length, 1, 'the repair changes one premise');
      const to = proof.to ?? 'authorized';
      assert.equal(evaluate(repaired).outcome, to);
      assert.equal(coveringChains(repaired).length, to === 'authorized' ? 1 : 0);
      const flipped = variant(v.input, (i) => { i.trust_records[parentOf(i)].exclusive_grants = outcome === 'seller_discretion'; });
      assert.equal(evaluate(flipped).outcome, outcome === 'grant_absent' ? 'seller_discretion' : 'grant_absent');
      if (outcome === 'seller_discretion') {
        const twin = fixture.vectors.find((t) => t.id === proof.twin);
        assert.equal(twin?.expected.outcome, 'grant_absent', 'a grant_absent twin for the same uncovered claim');
        assert.deepEqual(withoutExclusivity(v.input), withoutExclusivity(twin.input), 'the twin differs only in exclusive_grants');
      }
    }
  });
}
