const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const pins = require('./helpers/reference-definition-pin.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const vectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'static/compliance/source/test-vectors/definition-pins/vectors.json'), 'utf8'),
);
const rules = vectors.projection_rules;

function loadSchemas() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
      }
    }
  };
  walk(SCHEMAS);
  return ajv;
}

const ajv = loadSchemas();
const validatePin = ajv.getSchema('/schemas/core/definition-pin.json');
const validateTerms = ajv.getSchema('/schemas/media-buy/commercial-terms.json');


// adagents.json declares formats[] under its authoritative-file object; find it
// without hard-coding the surrounding oneOf/allOf nesting.
function findFormatsItems(node) {
  if (node && typeof node === 'object') {
    if (node.formats && node.formats.items && node.formats.items.allOf) return node.formats.items;
    for (const value of Object.values(node)) {
      const found = findFormatsItems(value);
      if (found) return found;
    }
  }
  return undefined;
}

test('projection rules cover exactly the pinnable kinds', () => {
  const kindEnum = JSON.parse(
    fs.readFileSync(path.join(SCHEMAS, 'enums/definition-pin-ref-kind.json'), 'utf8'),
  ).enum;
  assert.deepEqual(Object.keys(rules).sort(), [...kindEnum].sort());
  for (const [kind, rule] of Object.entries(rules)) {
    assert.deepEqual([...rule.exclude].sort(), rule.exclude, `${kind} exclude is sorted`);
    assert.ok(rule.exclude.includes('ext'), `${kind} excludes ext`);
    assert.deepEqual([...rule.set_arrays].sort(), rule.set_arrays, `${kind} set_arrays is sorted`);
    for (const nested of Object.values(rule.nested || {})) assert.ok(rules[nested]);
  }
});

for (const vector of vectors.projection_vectors) {
  test(`projection vector ${vector.id}`, () => {
    const result = pins.contentDigest(vector.published_entry, vector.ref_kind, rules);
    assert.deepEqual(result.projection, vector.expected.projection);
    assert.equal(result.jcs_bytes, vector.expected.jcs_bytes);
    assert.equal(result.content_digest, vector.expected.content_digest);
    assert.match(result.content_digest, /^[a-f0-9]{64}$/);
  });
}

for (const vector of vectors.equivalence_vectors) {
  test(`equivalence vector ${vector.id}`, () => {
    const a = pins.contentDigest(vector.entry_a, vector.ref_kind, rules).content_digest;
    const b = pins.contentDigest(vector.entry_b, vector.ref_kind, rules).content_digest;
    assert.equal(a, vector.expected.content_digest_a);
    assert.equal(b, vector.expected.content_digest_b);
    assert.equal(a === b, vector.expected.same_content_digest);
  });
}

test('the exclusion lists name only members the source schemas define', () => {
  const sources = {
    publisher_format_option: 'core/product-format-declaration.json',
    publisher_placement: 'core/placement-definition.json',
    publisher_collection: 'core/collection.json',
    data_provider_signal: 'core/signal-definition.json',
  };
  // adagents.json formats[] extends the declaration with property scope and registry members.
  const catalogFormat = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'adagents.json'), 'utf8'));
  const formatItems = findFormatsItems(catalogFormat);
  const extra = {
    publisher_format_option: Object.keys(formatItems.allOf[1].properties),
  };
  for (const [kind, file] of Object.entries(sources)) {
    const known = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(SCHEMAS, file), 'utf8')).properties));
    known.add('ext'); // open objects: ext is the universal extension point
    if (kind !== 'data_provider_signal') known.add('publisher_domain'); // origin-dependent, absent from some definitions
    for (const key of extra[kind] || []) known.add(key);
    for (const key of [...rules[kind].exclude, ...rules[kind].set_arrays]) {
      assert.ok(known.has(key), `${kind}: ${key} is not a member of ${file}`);
    }
  }
});

for (const vector of vectors.non_ijson_vectors) {
  test(`non-I-JSON vector ${vector.id}`, () => {
    if (vector.expected.resolvable) {
      assert.ok(pins.parsePublishedEntry(vector.published_entry_raw));
    } else {
      assert.throws(() => pins.parsePublishedEntry(vector.published_entry_raw));
    }
  });
}

test('definition_pins[] ordering vector', () => {
  const { input, expected_order: expected } = vectors.pin_ordering_vector;
  const ordered = [...input].sort(pins.comparePins).map(({ ref_kind, reference }) => ({ ref_kind, reference }));
  assert.deepEqual(ordered, expected);
  for (const pin of input) assert.ok(validatePin(pin), JSON.stringify(validatePin.errors));
  const keys = input.map(pin => pins.jcs({ k: pin.ref_kind, r: pin.reference }));
  assert.equal(new Set(keys).size, keys.length, 'pins are unique by (ref_kind, reference)');
});

test('collection mutation: terms_digest verifies while the pin fails', () => {
  const v = vectors.collection_mutation_vector;
  assert.ok(validateTerms(v.commercial_terms), JSON.stringify(validateTerms.errors));
  assert.equal(pins.termsDigest(v.commercial_terms), v.terms_digest);
  assert.equal(pins.termsDigest(v.commercial_terms), v.expected.terms_digest_after_mutation);

  const pin = v.commercial_terms.definition_pins.find(p => p.ref_kind === 'publisher_collection');
  const atPinTime = pins.contentDigest(v.definition_at_pin_time.published_entry, 'publisher_collection', rules);
  const after = pins.contentDigest(v.definition_after_mutation.published_entry, 'publisher_collection', rules);
  assert.equal(pin.content_digest, atPinTime.content_digest);
  assert.equal(pin.content_digest, v.expected.pin_content_digest);
  assert.equal(after.content_digest, v.expected.current_content_digest);
  assert.notEqual(after.content_digest, pin.content_digest);
  assert.equal(v.expected.pin_still_verifies, false);
  assert.equal(
    v.expected.error_field,
    `commercial_terms.definition_pins[${v.commercial_terms.definition_pins.indexOf(pin)}]`,
  );
});

test('pin schema accepts canonical pins and rejects non-canonical ones', () => {
  const digest = 'a'.repeat(64);
  const good = {
    ref_kind: 'publisher_collection',
    reference: { publisher_domain: 'sports-network.example', collection_id: 'evening_news' },
    content_digest: digest,
    source_version: 'etag-7',
  };
  assert.ok(validatePin(good), JSON.stringify(validatePin.errors));
  const bad = {
    'uppercase hex': { ...good, content_digest: 'A'.repeat(64) },
    'algorithm prefix': { ...good, content_digest: `sha256:${digest}` },
    'extra reference member': { ...good, reference: { ...good.reference, ext: {} } },
    'kind/reference mismatch': { ...good, reference: { data_provider_domain: 'x.example', signal_id: 's' } },
    'pinnable kind only': { ...good, ref_kind: 'property_list' },
    'missing digest': { ref_kind: good.ref_kind, reference: good.reference },
  };
  for (const [name, pin] of Object.entries(bad)) assert.equal(validatePin(pin), false, name);
});

test('refine_proposals unable result requires drifted_pins for definition_changed', () => {
  const validate = ajv.getSchema('/schemas/media-buy/refine-proposals-response.json');
  const pin = {
    ref_kind: 'publisher_collection',
    reference: { publisher_domain: 'sports-network.example', collection_id: 'evening_news' },
    content_digest: 'a'.repeat(64),
  };
  const result = {
    source_proposal_id: 'prop_draft_1',
    outcome: 'unable',
    reason_code: 'definition_changed',
    reason: 'A pinned collection changed.',
  };
  const wrap = r => ({ status: 'completed', results: [r], products: [] });
  assert.equal(validate(wrap(result)), false);
  assert.ok(validate(wrap({ ...result, drifted_pins: [{ pin }] })), 'a withdrawn definition omits current_content_digest');
  assert.ok(
    validate(wrap({ ...result, drifted_pins: [{ pin, current_content_digest: 'b'.repeat(64) }] })),
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate(wrap({ ...result, reason_code: 'hold_unavailable', drifted_pins: [{ pin }] })),
    false,
    'drifted_pins is valid only with definition_changed',
  );
});

test('cancellation proposals carry no pins; update proposals may', () => {
  const validate = ajv.getSchema('/schemas/core/canonical-proposal.json');
  const terms = vectors.collection_mutation_vector.commercial_terms;
  const proposal = (kind, commercialTerms) => ({
    proposal_id: 'prop_amend_1',
    proposal_kind: kind,
    proposal_status: 'draft',
    parent_proposal_id: 'prop_accepted_1',
    media_buy_id: 'mb_1',
    base_media_buy_revision: 1,
    name: 'Amendment',
    commercial_terms: commercialTerms,
    terms_digest: pins.termsDigest(commercialTerms),
  });
  assert.ok(validate(proposal('media_buy_update', terms)), JSON.stringify(validate.errors));
  const cancellation = { ...terms, cancellation_terms: { effective_at: '2099-02-01T00:00:00Z' } };
  assert.equal(validate(proposal('media_buy_cancellation', cancellation)), false);
  const { definition_pins: _omitted, ...withoutPins } = cancellation;
  assert.ok(validate(proposal('media_buy_cancellation', withoutPins)), JSON.stringify(validate.errors));
});

test('REFERENCE_DEFINITION_CHANGED ships on both error-code surfaces', () => {
  const codes = JSON.parse(fs.readFileSync(path.join(SCHEMAS, 'enums/error-code.json'), 'utf8'));
  assert.ok(codes.enum.includes('REFERENCE_DEFINITION_CHANGED'));
  assert.match(codes.enumDescriptions.REFERENCE_DEFINITION_CHANGED, /Recovery: correctable/);
  assert.equal(codes.enumMetadata.REFERENCE_DEFINITION_CHANGED.recovery, 'correctable');
  const details = ajv.getSchema('/schemas/error-details/reference-definition-changed.json');
  assert.ok(details({ current_content_digest: 'c'.repeat(64) }));
  assert.ok(details({ ref_kind: 'publisher_collection', pin_index: 0 }), 'withdrawn definitions omit the digest');
  assert.equal(details({ current_content_digest: 'C'.repeat(64) }), false);
});

test('controller scenario definition_pin_probe requires its operation params', () => {
  const validate = ajv.getSchema('/schemas/compliance/comply-test-controller-request.json');
  const account = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };
  const ok = params => validate({ account, scenario: 'definition_pin_probe', params });
  assert.ok(ok({ operation: 'prepare', product_id: 'news_video' }), JSON.stringify(validate.errors));
  assert.ok(
    ok({ operation: 'mutate_definition', proposal_id: 'prop_1', ref_kind: 'publisher_collection', mutation: 'material' }),
    JSON.stringify(validate.errors),
  );
  assert.equal(ok({ operation: 'mutate_definition', proposal_id: 'prop_1', ref_kind: 'publisher_collection' }), false);
  assert.equal(ok({ operation: 'prepare' }), false);
});
