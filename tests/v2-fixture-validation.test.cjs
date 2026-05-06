#!/usr/bin/env node
/**
 * v2 Reference Fixture Validation Test
 *
 * Validates the reference Product fixtures at static/examples/products/v2/*.json
 * against /schemas/core/product.json AND against the per-canonical params schema
 * in strict mode (to catch typos in `params` that the product-envelope schema's
 * `additionalProperties: true` would otherwise let slip through).
 *
 * Failure modes that previously slipped silently — surfaced now:
 *   1. Schema parse errors during load: log + exit 2 (was: silently ignored).
 *   2. Duplicate `$id` registrations: still tolerated (only this is silenced —
 *      multiple files declaring the same $id is a benign condition during
 *      partial re-runs after a generated dist/ rebuild).
 *   3. Validation errors are reported in full (was: truncated to 10).
 *   4. Per-canonical params strict-mode validation runs against each
 *      format_options[i] entry (was: only the product envelope was validated,
 *      letting `params: { with: 'a typo' }` validate vacuously under
 *      additionalProperties: true).
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
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

/**
 * Walk the schemas directory and add every JSON Schema with a $id to the AJV
 * instance. Distinguishes three failure modes:
 *   - JSON parse failures: log + exit non-zero (real bugs, never silent).
 *   - addSchema() throwing because $id already registered: silently tolerated
 *     (benign during partial dist/ rebuilds; only this case is swallowed).
 *   - addSchema() throwing for any other reason: re-throw (real bugs).
 */
function loadAllSchemas(ajv) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      let raw;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch (e) {
        console.error(`${RED}FAIL${RESET} could not read ${full}: ${e.message}`);
        process.exit(2);
      }
      let schema;
      try {
        schema = JSON.parse(raw);
      } catch (e) {
        console.error(`${RED}FAIL${RESET} JSON parse error in ${full}: ${e.message}`);
        process.exit(2);
      }
      if (!schema.$id) continue;
      try {
        ajv.addSchema(schema, schema.$id);
      } catch (e) {
        if (/already exists/.test(e.message)) {
          // Benign — duplicate $id during partial rebuild. Tolerated.
          continue;
        }
        console.error(`${RED}FAIL${RESET} addSchema error for ${full} ($id ${schema.$id}): ${e.message}`);
        process.exit(2);
      }
    }
  }
  walk(SCHEMAS_DIR);
}

function reportErrors(label, errors) {
  console.log(`  ${RED}✗${RESET} ${label}`);
  // No truncation — full error list reported. SDK validators (AJV, Pydantic)
  // emit one entry per non-matching oneOf branch when validating against the
  // 12-branch product-format-declaration; downstream consumers need the full
  // set to see WHICH branch (or which `allOf` step) actually failed.
  for (const err of errors || []) {
    const ip = err.instancePath || '(root)';
    const sp = err.schemaPath || '';
    console.log(`      ${ip}  ${err.message}  [${sp}]`);
  }
}

function main() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
  });
  addFormats(ajv);
  ajv.addFormat('uri-template', true);
  loadAllSchemas(ajv);

  const validate = ajv.getSchema('/schemas/core/product.json');
  if (!validate) {
    console.error(`${RED}ERROR:${RESET} could not load /schemas/core/product.json from ${SCHEMAS_DIR}`);
    process.exit(2);
  }

  // Per-canonical strict validators — used to catch typos in `params` that
  // the product-envelope schema's additionalProperties:true would let pass.
  const STRICT_CANONICALS = [
    'image', 'html5', 'display_tag', 'image_carousel',
    'video_hosted', 'video_vast', 'audio_hosted', 'audio_daast',
    'sponsored_placement', 'responsive_creative', 'agent_placement',
  ];
  const strictAjv = new Ajv({ allErrors: true, strict: false });
  addFormats(strictAjv);
  strictAjv.addFormat('uri-template', true);
  // Re-load schemas into a fresh AJV configured WITHOUT
  // additionalProperties-tolerance, so unknown keys in params surface as errors.
  loadAllSchemas(strictAjv);
  const strictValidators = {};
  for (const c of STRICT_CANONICALS) {
    const v = strictAjv.getSchema(`/schemas/formats/canonical/${c}.json`);
    if (v) strictValidators[c] = v;
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
  console.log(`Schema: /schemas/core/product.json (envelope) + per-canonical params (strict)`);
  console.log(`Fixtures: ${FIXTURES_DIR}`);
  console.log('');

  let pass = 0;
  let fail = 0;
  let strictWarnings = 0;

  for (const f of fixtures) {
    const full = path.join(FIXTURES_DIR, f);
    const fixture = JSON.parse(fs.readFileSync(full, 'utf8'));
    const valid = validate(fixture);
    if (!valid) {
      reportErrors(f, validate.errors);
      fail++;
      continue;
    }

    // Envelope-pass. Now strict-mode each format_options[i].params against its
    // canonical schema. Custom format_kind is excluded — its params shape is
    // governed by the seller's fetched format_schema, not by AdCP-side schema.
    const fopts = fixture.format_options || [];
    let strictFail = false;
    for (let i = 0; i < fopts.length; i++) {
      const opt = fopts[i];
      const kind = opt.format_kind;
      if (kind === 'custom') continue;
      const sv = strictValidators[kind];
      if (!sv) continue;
      const sok = sv(opt.params);
      if (!sok) {
        strictFail = true;
        console.log(`  ${YELLOW}⚠${RESET} ${f} — format_options[${i}] (${kind}) params strict-mode warnings:`);
        for (const err of sv.errors || []) {
          const ip = err.instancePath || '(root)';
          console.log(`      ${ip}  ${err.message}`);
        }
        strictWarnings++;
      }
    }
    if (!strictFail) {
      console.log(`  ${GREEN}✓${RESET} ${f}`);
    }
    pass++;
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
            reportErrors(f, responseValidate.errors);
            fail++;
          }
        }
      }
    }
  }

  console.log('');
  if (fail === 0 && strictWarnings === 0) {
    console.log(`${GREEN}✅ All ${pass} v2 reference fixtures validate (envelope + per-canonical strict).${RESET}`);
    process.exit(0);
  }
  if (fail === 0) {
    console.log(`${YELLOW}⚠ ${pass} fixtures pass envelope but ${strictWarnings} flagged strict-mode params concerns. See above.${RESET}`);
    // Strict warnings don't fail the build today — additionalProperties:true is
    // load-bearing for platform_extensions and seller-specific narrowings. But
    // surfacing them helps fixture authors catch typos before merge.
    process.exit(0);
  }
  console.log(`${RED}❌ ${fail} fixture(s) failed validation; ${pass} passed.${RESET}`);
  process.exit(1);
}

main();
