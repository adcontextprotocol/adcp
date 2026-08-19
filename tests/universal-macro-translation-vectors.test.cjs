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
  'ordinary-bracketed-values-not-suspect',
  'privacy-value-mappings-are-encoded-and-reported',
  'bare-query-normalized-away',
];

const REQUIRED_REJECTION_CASES = [
  'native-c0-null-rejected',
  'native-c0-unit-separator-rejected',
  'native-del-rejected',
];

describe('universal macro translation compliance fixture', () => {
  it('is a schema-valid 3.2 fixture', () => {
    const validate = new Ajv({ allErrors: true, strict: false }).compile(fixtureSchema);
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    assert.equal(fixture.version, '3.2');
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
});
