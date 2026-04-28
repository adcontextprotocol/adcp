#!/usr/bin/env node
/**
 * v2 Reference Fixture Validation Test
 *
 * Validates the reference Product fixtures at static/examples/products/v2/*.json
 * against /schemas/core/product.json. These fixtures are the "does it really
 * work?" check for the v2 RFC (#3305) — concrete fully-valid Product objects
 * that adopters and tooling can validate against.
 *
 * Run: npm run test:v2-fixtures
 */

const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;
const fs = require('fs');
const path = require('path');

const SCHEMAS_DIR = path.resolve(__dirname, '../static/schemas/source');
const FIXTURES_DIR = path.resolve(__dirname, '../static/examples/products/v2');
const RESPONSE_FIXTURES_DIR = path.resolve(__dirname, '../static/examples/get_products_responses/v2');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

function loadAllSchemas(ajv) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.json')) {
        try {
          const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (schema.$id) {
            try {
              ajv.addSchema(schema, schema.$id);
            } catch (e) {
              // already added
            }
          }
        } catch (e) {
          // skip non-schema or malformed JSON
        }
      }
    }
  }
  walk(SCHEMAS_DIR);
}

function main() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
  });
  addFormats(ajv);
  loadAllSchemas(ajv);

  const validate = ajv.getSchema('/schemas/core/product.json');
  if (!validate) {
    console.error(`${RED}ERROR:${RESET} could not load /schemas/core/product.json from ${SCHEMAS_DIR}`);
    process.exit(2);
  }

  if (!fs.existsSync(FIXTURES_DIR)) {
    console.error(`${RED}ERROR:${RESET} fixtures directory not found: ${FIXTURES_DIR}`);
    process.exit(2);
  }

  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (fixtures.length === 0) {
    console.error(`${RED}ERROR:${RESET} no fixtures found in ${FIXTURES_DIR}`);
    process.exit(2);
  }

  console.log('v2 Reference Fixture Validation');
  console.log('================================');
  console.log(`Schema: /schemas/core/product.json`);
  console.log(`Fixtures: ${FIXTURES_DIR}`);
  console.log('');

  let pass = 0;
  let fail = 0;

  for (const f of fixtures) {
    const full = path.join(FIXTURES_DIR, f);
    const fixture = JSON.parse(fs.readFileSync(full, 'utf8'));
    const valid = validate(fixture);
    if (valid) {
      console.log(`  ${GREEN}✓${RESET} ${f}`);
      pass++;
    } else {
      console.log(`  ${RED}✗${RESET} ${f}`);
      for (const err of (validate.errors || []).slice(0, 10)) {
        console.log(`      ${err.instancePath || '(root)'}: ${err.message}`);
      }
      fail++;
    }
  }

  // Validate get_products response fixtures (with bundled extensions) if present
  if (fs.existsSync(RESPONSE_FIXTURES_DIR)) {
    const responseValidate = ajv.getSchema('/schemas/media-buy/get-products-response.json');
    if (responseValidate) {
      const responseFixtures = fs
        .readdirSync(RESPONSE_FIXTURES_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort();
      if (responseFixtures.length > 0) {
        console.log('');
        console.log('get_products response fixtures:');
        for (const f of responseFixtures) {
          const full = path.join(RESPONSE_FIXTURES_DIR, f);
          const fixture = JSON.parse(fs.readFileSync(full, 'utf8'));
          const valid = responseValidate(fixture);
          if (valid) {
            console.log(`  ${GREEN}✓${RESET} ${f}`);
            pass++;
          } else {
            console.log(`  ${RED}✗${RESET} ${f}`);
            for (const err of (responseValidate.errors || []).slice(0, 10)) {
              console.log(`      ${err.instancePath || '(root)'}: ${err.message}`);
            }
            fail++;
          }
        }
      }
    }
  }

  console.log('');
  if (fail === 0) {
    console.log(`${GREEN}✅ All ${pass} v2 reference fixtures validate.${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}❌ ${fail} fixture(s) failed validation; ${pass} passed.${RESET}`);
    process.exit(1);
  }
}

main();
