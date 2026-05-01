#!/usr/bin/env node
/**
 * v2 Negative-fixture regression tests
 *
 * Validates that the v2 schemas REJECT specific malformed inputs. Complements
 * tests/v2-fixture-validation.test.cjs (which validates that valid fixtures
 * pass) with the inverse: that the schema's `allOf` if/then/else, oneOf
 * discriminators, and required/not constraints actually reject the shapes
 * they're meant to reject.
 *
 * Filed against PR #3307 review comment R3 (composability of top-level
 * discriminator + allOf if/then/else + 12-branch oneOf on
 * product-format-declaration.json). Adopters and SDK authors will rely on
 * the schema's negative-side behavior; without these tests, regressions to
 * silent-pass on malformed declarations would slip through.
 *
 * Run: npm run test:v2-negative
 */

const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const fs = require('fs');
const path = require('path');

const SCHEMAS_DIR = path.resolve(__dirname, '../static/schemas/source');
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function loadAllSchemas(ajv) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      let schema;
      try {
        schema = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (e) {
        console.error(`${RED}FAIL${RESET} parse error in ${full}: ${e.message}`);
        process.exit(1);
      }
      if (!schema.$id) continue;
      try {
        ajv.addSchema(schema, schema.$id);
      } catch (e) {
        if (!/already exists/.test(e.message)) throw e;
      }
    }
  }
  walk(SCHEMAS_DIR);
}

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addFormat('uri-template', true);
loadAllSchemas(ajv);

const SHA = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

const NEGATIVE_CASES = {
  '/schemas/core/product-format-declaration.json': [
    {
      label: 'format_kind=image rejects stray format_schema',
      expected: false,
      doc: {
        format_kind: 'image',
        params: { width: 300, height: 250 },
        format_schema: { uri: 'https://x.example/s', digest: SHA },
      },
    },
    {
      label: 'format_kind=image rejects stray format_shape',
      expected: false,
      doc: {
        format_kind: 'image',
        params: { width: 300, height: 250 },
        format_shape: 'multi_placement_takeover',
      },
    },
    {
      label: 'format_kind=custom rejects missing format_shape',
      expected: false,
      doc: {
        format_kind: 'custom',
        params: {},
        format_schema: { uri: 'https://x.example/s', digest: SHA },
      },
    },
    {
      label: 'format_kind=custom rejects missing format_schema',
      expected: false,
      doc: {
        format_kind: 'custom',
        params: {},
        format_shape: 'multi_placement_takeover',
      },
    },
    {
      label: 'bogus format_kind value rejected',
      expected: false,
      doc: { format_kind: 'banana', params: {} },
    },
    {
      label: 'format_kind=custom complete (positive control)',
      expected: true,
      doc: {
        format_kind: 'custom',
        params: { foo: 'bar' },
        format_shape: 'multi_placement_takeover',
        format_schema: { uri: 'https://x.example/s', digest: SHA },
      },
    },
    {
      label: 'format_kind=image clean (positive control)',
      expected: true,
      doc: { format_kind: 'image', params: { width: 300, height: 250 } },
    },
  ],
  '/schemas/creative/validate-input-result.json': [
    {
      label: 'validated_pass rejects violations',
      expected: false,
      doc: {
        target: { kind: 'canonical', id: 'image' },
        result_kind: 'validated_pass',
        violations: [{ rule: 'x', field: 'y' }],
      },
    },
    {
      label: 'unvalidatable_nondeterministic rejects violations',
      expected: false,
      doc: {
        target: { kind: 'product', id: 'p1' },
        result_kind: 'unvalidatable_nondeterministic',
        violations: [{ rule: 'x', field: 'y' }],
      },
    },
    {
      label: 'old shape with `ok` boolean rejected (no `result_kind`)',
      expected: false,
      doc: { target: { kind: 'canonical', id: 'image' }, ok: true },
    },
    {
      label: 'validated_fail with violations (positive control)',
      expected: true,
      doc: {
        target: { kind: 'product', id: 'p1' },
        result_kind: 'validated_fail',
        violations: [
          { rule: 'duration_ms_range', expected: '3000-90000', predicted: 95000, field: 'assets.video_main.duration_ms' },
        ],
      },
    },
  ],
};

let pass = 0;
let fail = 0;

for (const [schemaId, cases] of Object.entries(NEGATIVE_CASES)) {
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    console.error(`${RED}FAIL${RESET} schema ${schemaId} not loaded`);
    fail++;
    continue;
  }
  console.log(`\n${schemaId}`);
  for (const c of cases) {
    const got = validate(c.doc);
    if (got === c.expected) {
      console.log(`  ${GREEN}✓${RESET} ${c.label}`);
      pass++;
    } else {
      console.log(`  ${RED}✗${RESET} ${c.label} — got ${got}, want ${c.expected}`);
      if (validate.errors) {
        console.log(`    errors: ${JSON.stringify(validate.errors.slice(0, 2))}`);
      }
      fail++;
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(`${RED}❌ ${fail} negative-fixture regression(s)${RESET}`);
  process.exit(1);
}
console.log(`${GREEN}✅ All ${pass} negative fixtures behaved as expected.${RESET}`);
