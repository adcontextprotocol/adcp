const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const Ajv = require('ajv');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'static', 'compliance', 'source', 'test-vectors', 'universal-macro-translation.json'),
  'utf8',
));
const fixtureSchema = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'static', 'compliance', 'source', 'test-vectors', 'universal-macro-translation.schema.json'),
  'utf8',
));

const EXPECTED_RESULT_KEYS = [
  'url',
  'dropped_params',
  'unmapped_macros',
  'dropped_consent_macros',
  'frozen_consent_macros',
  'suspect_native_values',
];

const REQUIRED_SUCCESS_CASES = [
  'value-reserved-characters',
  'value-unreserved-characters',
  'value-non-ascii-utf8',
  'native-token-forms-inserted-verbatim',
  'multiple-mapped-macros-in-one-parameter',
  'mapped-plus-unmapped-drops-whole-parameter',
  'repeated-keys-and-first-seen-report-order',
  'privacy-drops-and-deduplicated-order',
  'privacy-native-mappings-allowed',
  'literal-parameters-pass-through-byte-for-byte',
  'path-and-no-query-left-untouched',
  'fragment-left-untouched',
  'macro-in-key-left-untouched',
  'substitution-is-single-pass',
  'suspect-native-values-are-mapping-scoped-and-ordered',
  'embedded-percent-native-tokens-are-deduplicated',
  'embedded-double-brace-native-token-is-suspect',
  'embedded-dollar-brace-native-token-is-suspect',
  'embedded-upper-snake-bracket-native-token-is-suspect',
  'embedded-native-values-are-mapping-scoped-and-ordered',
  'ordinary-bracketed-values-not-suspect',
  'embedded-ordinary-bracketed-values-not-suspect',
  'privacy-value-mappings-are-encoded-and-reported',
  'bare-query-normalized-away',
  'additional-consent-native-with-tcf',
  'additional-consent-existing-native-pass-through',
  'additional-consent-unmapped-reported',
  'additional-consent-value-reported',
  'additional-consent-unavailable-empty',
  'vendor-scoped-consent-native-preserves-id',
  'vendor-scoped-consent-existing-native-pass-through',
  'vendor-scoped-consent-other-id-preserved',
  'vendor-scoped-consent-missing-vendor-id-empty',
  'vendor-scoped-consent-value-reported',
  'vendor-scoped-consent-unmapped-reported',
  'vendor-scoped-consent-unscoped-mapping-does-not-match',
  'vendor-scoped-consent-counted-after-parameter-dropping',
];

const REQUIRED_REJECTION_CASES = [
  'native-c0-null-rejected',
  'native-c0-unit-separator-rejected',
  'native-del-rejected',
];

describe('universal macro translation compliance fixture', () => {
  it('is a schema-valid 3.3 fixture', () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(fixtureSchema);
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    assert.equal(fixture.version, '3.3');
  });

  it('preserves vendor scope and keeps missing-vendor consent empty', () => {
    const vectorsByName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));
    const scoped = vectorsByName.get('vendor-scoped-consent-native-preserves-id');
    assert.equal(scoped.mapping['{GDPR_CONSENT_755}'].native, '${GDPR_CONSENT_755}');
    assert.equal(scoped.expected.url, 'https://pixel.example/i?gdpr=${GDPR}&gdpr_consent=${GDPR_CONSENT_755}');
    const missing = vectorsByName.get('vendor-scoped-consent-missing-vendor-id-empty');
    assert.equal(missing.mapping['{GDPR_CONSENT}'].value, '');
    assert.equal(missing.expected.url, 'https://pixel.example/i?gdpr=${GDPR}&gdpr_consent=');
    assert.deepEqual(missing.expected.frozen_consent_macros, ['{GDPR_CONSENT}']);
    assert.deepEqual(vectorsByName.get('vendor-scoped-consent-value-reported').expected.frozen_consent_macros,
      ['{GDPR_CONSENT_755}']);
    assert.deepEqual(vectorsByName.get('vendor-scoped-consent-unmapped-reported').expected.dropped_consent_macros,
      ['{GDPR_CONSENT_755}']);
    assert.deepEqual(vectorsByName.get('vendor-scoped-consent-unscoped-mapping-does-not-match').expected.unmapped_macros,
      ['{GDPR_CONSENT_755}']);
  });

  it('preserves Additional Consent alongside TCF and reports unavailable or frozen values', () => {
    const vectorsByName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));
    const native = vectorsByName.get('additional-consent-native-with-tcf');
    assert.equal(native.mapping['{ADDTL_CONSENT}'].native, '${ADDTL_CONSENT}');
    assert.equal(native.expected.url,
      'https://pixel.example/i?gdpr=${GDPR}&gdpr_consent=${GDPR_CONSENT_755}&addtl_consent=${ADDTL_CONSENT}');
    const existing = vectorsByName.get('additional-consent-existing-native-pass-through');
    assert.equal(existing.expected.url, existing.input_pixel_url);
    const unmapped = vectorsByName.get('additional-consent-unmapped-reported').expected;
    assert.deepEqual(unmapped.dropped_params, ['a', 'again']);
    assert.deepEqual(unmapped.unmapped_macros, ['{ADDTL_CONSENT}']);
    assert.deepEqual(unmapped.dropped_consent_macros, ['{ADDTL_CONSENT}']);
    assert.equal(unmapped.url, 'https://pixel.example/i?c=${GDPR_CONSENT_755}');
    const frozen = vectorsByName.get('additional-consent-value-reported');
    assert.equal(frozen.mapping['{ADDTL_CONSENT}'].value, '2~41.1.35~dv.21.9');
    assert.equal(frozen.expected.url,
      'https://pixel.example/i?c=${GDPR_CONSENT_755}&a=2~41.1.35~dv.21.9');
    assert.deepEqual(frozen.expected.frozen_consent_macros, ['{ADDTL_CONSENT}']);
    const unavailable = vectorsByName.get('additional-consent-unavailable-empty');
    assert.equal(unavailable.mapping['{ADDTL_CONSENT}'].value, '');
    assert.equal(unavailable.expected.url, 'https://pixel.example/i?c=${GDPR_CONSENT_755}&a=');
    assert.deepEqual(unavailable.expected.frozen_consent_macros, ['{ADDTL_CONSENT}']);
  });

  it('rejects multiple scoped occurrences, including existing and indirect native tokens', () => {
    const vectorsByName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));
    const cases = {
      'vendor-scoped-consent-repeated-occurrence-rejected': '{GDPR_CONSENT_755}',
      'vendor-scoped-consent-different-vendors-rejected': '{GDPR_CONSENT_42}',
      'vendor-scoped-consent-repeated-within-value-rejected': '{GDPR_CONSENT_755}',
      'vendor-scoped-consent-existing-native-occurrence-rejected': '{GDPR_CONSENT_755}',
      'vendor-scoped-consent-indirect-native-occurrence-rejected': '{GDPR_CONSENT_42}',
      'vendor-scoped-consent-alternate-native-duplicates-rejected': '{GDPR_CONSENT_755}',
      'vendor-scoped-consent-existing-native-duplicates-rejected': '{GDPR_CONSENT_42}',
    };
    for (const [name, macro] of Object.entries(cases)) {
      assert.deepEqual(vectorsByName.get(name)?.expected_error, {
        code: 'multiple_vendor_consent_macros', macro,
      }, name);
    }
    for (const vector of fixture.vectors.filter((vector) => vector.expected)) {
      assert.ok((vector.expected.url.match(/\$?\{GDPR_CONSENT_[1-9][0-9]*\}/g) || []).length <= 1,
        `${vector.name} must not emit multiple scoped consent macros`);
      assert.ok(!vector.expected.url.includes('GDPR_CONSENT_XXX'), vector.name);
    }
  });

  it('pins every ratified edge case and the complete successful result shape', () => {
    const vectorsByName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));
    assert.equal(vectorsByName.size, fixture.vectors.length, 'vector names must be unique');

    for (const name of REQUIRED_SUCCESS_CASES) {
      const vector = vectorsByName.get(name);
      assert.ok(vector, `missing required success vector: ${name}`);
      assert.deepEqual(Object.keys(vector.expected), EXPECTED_RESULT_KEYS, name);
    }

    for (const name of REQUIRED_REJECTION_CASES) {
      const vector = vectorsByName.get(name);
      assert.ok(vector, `missing required rejection vector: ${name}`);
      assert.deepEqual(vector.expected_error, {
        code: 'unsafe_native_mapping',
        macro: '{CACHEBUSTER}',
      });
    }
  });

  it('pins the ratified consent advisory and bare-query normalization', () => {
    const vectorsByName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));
    assert.deepEqual(
      vectorsByName.get('privacy-value-mappings-are-encoded-and-reported').expected.frozen_consent_macros,
      ['{GPP_STRING}', '{US_PRIVACY}'],
    );
    assert.equal(
      vectorsByName.get('bare-query-normalized-away').expected.url,
      'https://pixel.example/i',
    );
  });

  it('flags embedded native-token shapes without flagging ordinary bracketed text', () => {
    const vectorsByName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));
    const suspectNames = [
      'embedded-percent-native-tokens-are-deduplicated',
      'embedded-double-brace-native-token-is-suspect',
      'embedded-dollar-brace-native-token-is-suspect',
      'embedded-upper-snake-bracket-native-token-is-suspect',
    ];

    for (const name of suspectNames) {
      assert.deepEqual(vectorsByName.get(name).expected.suspect_native_values, ['{VALUE}'], name);
    }
    assert.deepEqual(
      vectorsByName.get('embedded-ordinary-bracketed-values-not-suspect').expected.suspect_native_values,
      [],
    );
    assert.deepEqual(
      vectorsByName.get('embedded-native-values-are-mapping-scoped-and-ordered').expected.suspect_native_values,
      ['{SECOND}', '{UNUSED}', '{FIRST}'],
    );
  });
});
