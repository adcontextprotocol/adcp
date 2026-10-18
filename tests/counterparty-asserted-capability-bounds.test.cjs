/**
 * Contract test for the bounds on counterparty-asserted capability fields.
 *
 * Two fields on `get_adcp_capabilities` enumerate relationships a *counterparty*
 * asserts rather than ones the agent declares about itself:
 * `media_buy.portfolio.publisher_domains` and `signals.data_provider_domains`.
 * Both are populated from the counterparty's own `/.well-known/adagents.json`,
 * which any domain owner publishes unilaterally with no consent from the agent
 * it names. Unbounded, that let an unrelated third party inflate a victim's
 * capabilities document past `MAX_CAPABILITIES_BYTES`; because the signing-key
 * discovery path fetches that document unnarrowed, the victim lost signature
 * verification rather than merely discovery (#8197).
 *
 * Each assertion pins one part of the fix that closes a specific bypass:
 *
 *   - `maxItems` alone bounds nothing, because the item pattern matches a
 *     multi-megabyte single label — `maxLength` is the load-bearing bound.
 *   - `maxLength` alone bounds nothing, because the array is unbounded.
 *   - Without `uniqueItems` the cap is spent on duplicates.
 *   - A count bound cannot express bytes (a hundred 253-char domains are 13x a
 *     hundred ordinary ones), so the normative byte budget is what actually
 *     binds against an adversarial list.
 *   - Without the completeness flag, bounding the array silently turns a large
 *     legitimate network into a seller that looks unauthorized for most of its
 *     inventory, because a buyer reading the list as an allowlist denies
 *     everything the truncation dropped.
 *
 * Dropping any one of those re-opens the issue, so the suite fails on each
 * rather than only when the numbers move.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SECURITY = 'building/by-layer/L1/security.mdx';
const RESPONSE_SIZE = 'building/concepts/managing-response-size.mdx';
const CAPABILITIES_DOC = 'protocol/get_adcp_capabilities.mdx';
const AUTHORIZED_PROPERTIES = 'governance/property/authorized-properties.mdx';
const MIGRATION = 'reference/migration/3-2-to-3-3.mdx';
const VERSIONING = 'reference/versioning.mdx';

const MAX_CAPABILITIES_BYTES = 65_536;
/** Per-field and aggregate budgets for counterparty-asserted content. */
const PER_FIELD_BUDGET = MAX_CAPABILITIES_BYTES / 8;
const AGGREGATE_BUDGET = MAX_CAPABILITIES_BYTES / 4;
/** Longest presentation-form FQDN without the trailing dot. */
const MAX_DOMAIN_LENGTH = 253;
/** A realistic publisher domain, for checking the count bound is not stingy. */
const TYPICAL_DOMAIN_LENGTH = 18;

const read = (relative) => fs.readFileSync(path.join(DOCS, relative), 'utf8');

const schema = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'static/schemas/source/protocol/get-adcp-capabilities-response.json'),
    'utf8',
  ),
);

/** Body of the section with the given heading, up to the next heading of the same or higher level. */
function section(content, heading) {
  const level = heading.match(/^#+/)[0].length;
  const start = content.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const rest = content.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The two counterparty-asserted arrays, their completeness flags, and the
 * object each lives on. Adding a third such field means adding it here.
 */
const COUNTERPARTY_ASSERTED = [
  {
    label: 'media_buy.portfolio.publisher_domains',
    container: () => schema.properties.media_buy.properties.portfolio.properties,
    field: 'publisher_domains',
    flag: 'publisher_domains_complete',
  },
  {
    label: 'signals.data_provider_domains',
    container: () => schema.properties.signals.properties,
    field: 'data_provider_domains',
    flag: 'data_provider_domains_complete',
  },
];

describe('counterparty-asserted capability arrays are bounded', () => {
  for (const { label, container, field, flag } of COUNTERPARTY_ASSERTED) {
    describe(label, () => {
      const node = () => container()[field];

      it('declares the structural bounds a third party could otherwise blow past', () => {
        const bounds = node()['x-adcp-validation'].advisory_bounds;
        assert.ok(bounds, `${label} must declare advisory_bounds`);
        assert.equal(bounds.item_max_length, MAX_DOMAIN_LENGTH);
        assert.equal(bounds.unique_items, true);
        assert.equal(bounds.max_serialized_bytes, PER_FIELD_BUDGET);
        // The count binds the legitimate case. At a realistic ~18-byte domain
        // the cap must be reached long before the byte budget is, or it would
        // report honest lists the budget would have allowed.
        assert.ok(
          bounds.max_items * (TYPICAL_DOMAIN_LENGTH + 3) <= PER_FIELD_BUDGET,
          `${label}: ${bounds.max_items} typical domains must fit the ${PER_FIELD_BUDGET}B budget`,
        );
        // And it must still bound the adversarial case to something the
        // document can survive, even though the byte budget is what rejects it.
        const worstCase = bounds.max_items * (MAX_DOMAIN_LENGTH + 3);
        assert.ok(
          worstCase < MAX_CAPABILITIES_BYTES / 2,
          `${label} worst case ${worstCase}B must stay under half of MAX_CAPABILITIES_BYTES`,
        );
      });

      it('keeps the bounds out of the schema so no 3.2 document is invalidated', () => {
        // The fix is a conformance rule, not a wire break. A 3.2 seller with a
        // 150-publisher network emitted a valid document; it stays valid and is
        // graded, not rejected. Reintroducing any of these as a hard constraint
        // turns an additive minor into a breaking change.
        const n = node();
        assert.equal(n.maxItems, undefined, `${label} must not carry a schema maxItems in 3.x`);
        assert.equal(n.uniqueItems, undefined, `${label} must not carry schema uniqueItems in 3.x`);
        assert.equal(
          n.items.maxLength,
          undefined,
          `${label} items must not carry a schema maxLength in 3.x`,
        );
        const validation = n['x-adcp-validation'];
        assert.equal(validation.enforced_in_3_x, 'storyboard');
        assert.equal(validation.schema_enforced_in, '4.0');
      });

      it('is honest that the structural ceiling exceeds the byte budget', () => {
        // The count x length ceiling is deliberately looser than the 8,192-byte
        // MUST: a count cannot express bytes, so the two layers catch different
        // cases. Anyone reading only the bounds would otherwise conclude that a
        // within-bounds list is a conformant one, which at 100 x 253 it is not.
        const bounds = node()['x-adcp-validation'].advisory_bounds;
        const worstCase = bounds.max_items * (MAX_DOMAIN_LENGTH + 3);
        assert.ok(
          worstCase > PER_FIELD_BUDGET,
          'if the ceiling ever fits the budget, drop this test and the caveat it pins',
        );
        assert.match(node().description, /deliberately looser than the byte budget/i);
      });

      it('is marked counterparty-asserted and points at its completeness flag', () => {
        const validation = node()['x-adcp-validation'];
        assert.ok(validation, `${label} must carry x-adcp-validation`);
        assert.equal(validation.counterparty_asserted, true);
        assert.equal(validation.completeness_flag, flag);
      });

      it('says in its own description that it is not an allowlist', () => {
        // A consumer reading only the schema must not conclude that absence
        // from the list denies authorization.
        const { description } = node();
        assert.match(description, /NOT exhaustive/i, `${label} must say it is non-exhaustive`);
        assert.match(description, /MUST NOT/, `${label} must forbid reading absence as denial`);
        assert.match(description, /adagents\.json/);
        assert.match(description, new RegExp(flag));
      });

      it('ships a completeness flag so truncation cannot masquerade as a full list', () => {
        const node_ = container()[flag];
        assert.ok(node_, `${label} must ship ${flag}`);
        assert.equal(node_.type, 'boolean');
        // Default true: an agent whose list is already complete changes nothing.
        assert.equal(node_.default, true, `${flag} must default to true`);
        assert.equal(node_['x-added-in'], '3.3.0');
      });
    });
  }

  it('covers every counterparty-asserted array in the response schema', () => {
    // Guards against a third such field landing unbounded. Domain-shaped
    // arrays are the shape the vector takes: an open-valued list of
    // counterparty identifiers, as opposed to a closed enum vocabulary.
    //
    // Two known limits, neither live today: the walk is ref-local, so a
    // domain-valued array arriving through a `$ref` into core/ or governance/
    // is invisible to it; and the heuristic is shape-based, so a
    // counterparty-asserted list of URLs or opaque IDs would not match. Both
    // were checked by hand when this landed. Widen the heuristic rather than
    // trusting it if a future field is counterparty-asserted but not
    // domain-shaped.
    const found = [];
    const walk = (node, pointer) => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${pointer}/${i}`));
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (node.type === 'array' && node.items && typeof node.items === 'object') {
        const pattern = node.items.pattern || '';
        // The domain pattern shared by both known instances.
        if (pattern.includes('[a-z0-9-]*[a-z0-9]') && pattern.includes('\\.')) {
          found.push(pointer);
        }
      }
      for (const [key, value] of Object.entries(node)) walk(value, `${pointer}/${key}`);
    };
    walk(schema.properties, '');

    for (const pointer of found) {
      const node = pointer
        .split('/')
        .filter(Boolean)
        .reduce((acc, key) => acc[key], schema.properties);
      const bounds = node['x-adcp-validation'] && node['x-adcp-validation'].advisory_bounds;
      assert.ok(
        bounds,
        `domain-valued array at ${pointer} declares no bounds. If it is counterparty-asserted, add it to COUNTERPARTY_ASSERTED above; if it is self-declared, bound it here and widen this guard to say so.`,
      );
      assert.equal(bounds.item_max_length, MAX_DOMAIN_LENGTH, `${pointer} needs an item length bound`);
      assert.equal(bounds.unique_items, true, `${pointer} needs a uniqueness bound`);
    }

    assert.equal(found.length, COUNTERPARTY_ASSERTED.length, `expected exactly ${COUNTERPARTY_ASSERTED.length} domain-valued arrays, found ${found.length}: ${found.join(', ')}`);
  });
});

describe('normative byte budget (security.mdx)', () => {
  const body = section(read(SECURITY), '### Response Size Bounds');

  it('states the per-field and aggregate budgets with their byte counts', () => {
    // The schema bound is a count; only a byte budget binds a list of
    // adversarially long domains, so the prose carries the real limit.
    assert.match(body, new RegExp(`${PER_FIELD_BUDGET.toLocaleString('en-US')} bytes`));
    assert.match(body, new RegExp(`${AGGREGATE_BUDGET.toLocaleString('en-US')}`));
  });

  it('names both counterparty-asserted fields', () => {
    assert.match(body, /media_buy\.portfolio\.publisher_domains/);
    assert.match(body, /signals\.data_provider_domains/);
  });

  it('explains why a third party can write them at all', () => {
    assert.match(body, /adagents\.json/);
    assert.match(body, /unilaterally/i);
    assert.match(body, /without the named agent's consent/i);
  });

  it('ties the inflation to signature verification, not just discovery', () => {
    assert.match(body, /MAX_CAPABILITIES_BYTES/);
    assert.match(body, /signature verification/i);
  });

  it('requires truncate-and-flag rather than exceeding or omitting', () => {
    assert.match(body, /MUST NOT.{0,80}unbounded/is);
    assert.match(body, /publisher_domains_complete: false/);
    assert.match(body, /data_provider_domains_complete: false/);
    assert.match(body, /MUST NOT.{0,60}serve a\s+truncated list as complete/is);
  });

  it('forbids reading either list as an authorization allowlist', () => {
    assert.match(body, /MUST NOT.{0,60}treat either list as an\s+authorization allowlist/is);
    // The prohibition must not be conditioned on the completeness flag, or the
    // contrapositive ("a complete list MAY bound authorization") reinstates
    // absence-as-denial for every seller whose list happens to fit.
    assert.match(body, /whether or not it is marked complete/i);
    assert.match(body, /absence from the\s+list is not a denial/is);
  });

  it('states the budget as a sub-cap rather than an allowance', () => {
    // Without this, an agent reads "a quarter for those two fields" as
    // "three quarters for mine" and busts MAX_CAPABILITIES_BYTES itself.
    assert.match(body, /sub-caps, not an allowance/i);
    assert.match(body, /not an entitlement/i);
    assert.match(body, /self-inflicted rather than attacker-inflicted/i);
  });

  it('pins the measurement unit so the budget is testable', () => {
    // "as served" alone lets a producer claim conformance on gzipped bytes
    // while the verifier aborts on decoded ones.
    assert.match(body, /uncompressed\s+serialized JSON/is);
    assert.match(body, /decoded\s+bytes/is);
  });

  it('is honest that a schema bound is not a runtime control', () => {
    // Without this, readers assume the schema stops an inflated response.
    assert.match(body, /conformance statement, not a runtime control/i);
  });
});

describe('adopter-facing guidance', () => {
  it('managing-response-size tells agents not to mirror what asserts them', () => {
    const body = section(read(RESPONSE_SIZE), '## Discovery responses stay small');
    assert.match(body, /publisher_domains/);
    assert.match(body, /data_provider_domains/);
    assert.match(body, /8,192 bytes/);
    assert.match(body, /publisher_domains_complete: false/);
  });

  it('the capabilities reference warns on both fields', () => {
    const content = read(CAPABILITIES_DOC);
    assert.match(content, /counterparty-asserted and non-exhaustive/i);
    assert.match(content, /publisher_domains_complete/);
    assert.match(content, /data_provider_domains_complete/);
    assert.match(content, /absence from this list is \*\*not\*\* a denial/i);
  });

  it('the buyer workflow resolves on cache miss instead of denying', () => {
    // The published example previously did `if (!adagents) return false` against
    // a cache warmed only from publisher_domains, so any truncated list made a
    // buyer reject legitimate inventory.
    const content = read(AUTHORIZED_PROPERTIES);
    assert.match(content, /warm-up hint, not an allowlist/i);
    assert.match(content, /never "not authorized"/);
    assert.doesNotMatch(
      content,
      /const adagents = authorizationCache\[domain\];\n\n  if \(!adagents\) return false;/,
      'the deny-on-cache-miss example must not come back',
    );
  });

  it('bounds the on-demand resolve the buyer workflow now performs', () => {
    // Resolving on miss is right, but `products[]` and `publisher_properties[]`
    // are both seller-sized, so an unguarded per-property fetch lets the seller
    // choose the buyer's fan-out — a worse amplification than the one closed.
    const content = read(AUTHORIZED_PROPERTIES);
    assert.match(content, /MAX_RESOLVED_DOMAINS/, 'the resolve set must be capped');
    assert.match(content, /RESOLVE_CONCURRENCY/, 'concurrent fetches must be bounded');
    assert.match(content, /ssrfSafeFetch/, 'counterparty-supplied URLs need the SSRF profile');
    assert.match(content, /redirect: 'error'/, 'a publisher 302 must not be chased');
    assert.match(content, /retryAfter/, 'failures must be negative-cached with a TTL');
    // A failed fetch must not become a permanent denial: that is the
    // deny-on-miss bug relocated from "never looked up" to "looked up once".
    assert.match(content, /if \(loaded\[j\]\.ok\) authorizationCache\[domain\]/);
    assert.match(content, /unproven, not denied/i);
    assert.match(content, /if \(!res\.ok\) throw/, 'a 404 body is not a catalog');
    assert.match(content, /dotless labels like `localhost`/i);
    assert.doesNotMatch(
      content,
      /await fetch\(`https:\/\/\$\{domain\}/,
      'the example must not teach a bare fetch of a counterparty domain',
    );
  });

  it('the normative narrowing is recorded as a 3.3 compatibility exception', () => {
    // A rule that makes a previously-conformant producer non-conformant is a
    // narrowing. The repo ships those in a minor only when they are recorded
    // here with a basis; an unrecorded one is the thing this test prevents.
    const body = section(
      read(VERSIONING),
      '### 3.3 exceptions to 3.x compatibility (beta)',
    );
    assert.match(body, /^\| Counterparty-asserted lists are bounded \|/m);
    assert.match(body, /publisher_domains/);
    assert.match(body, /data_provider_domains/);
    assert.match(body, /8,192 bytes/);
    // And it must say the schemas did not change, which is what keeps this
    // classifiable as minor rather than major.
    assert.match(body, /\*\*Schemas are unchanged\*\*/);
    assert.match(body, /8197/);
  });

  it('the migration guide carries the narrowing and both audiences', () => {
    const body = section(read(MIGRATION), '### Counterparty-asserted domain lists are bounded');
    // The narrowing is in conformance, not in what validates. Saying "tightens
    // the schema" would misclassify an additive minor as a breaking change.
    assert.match(body, /schemas are unchanged/i);
    assert.match(body, /graded by the conformance storyboard/i);
    assert.match(body, /stays\s+schema-valid/is);
    assert.match(body, /publisher_domains_complete: false/);
    assert.match(body, /\*\*not\*\* evidence the seller is\s+unauthorized/is);
    // The recorded exception is what makes the narrowing ratified, not silent.
    assert.match(body, /3-3-exceptions-to-3-x-compatibility/);
    assert.match(
      read(MIGRATION),
      /\|[^|]*\|[^|]*\|[^|]*publisher_domains[^|]*data_provider_domains[^|]*\|/,
      'upgrade checklist needs a row for the new bounds',
    );
  });
});
