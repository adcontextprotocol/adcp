#!/usr/bin/env node
/**
 * Canonical Formats Negative-fixture regression tests
 *
 * Validates that the canonical-formats schemas REJECT specific malformed inputs.
 * Complements tests/canonical-fixture-validation.test.cjs (which validates that
 * valid fixtures pass) with the inverse: that the schema's `allOf` if/then/else,
 * oneOf discriminators, and required/not constraints actually reject the shapes
 * they're meant to reject.
 *
 * Filed against PR #3307 review comment R3 (composability of top-level
 * discriminator + allOf if/then/else + 12-branch oneOf on
 * product-format-declaration.json). Adopters and SDK authors will rely on
 * the schema's negative-side behavior; without these tests, regressions to
 * silent-pass on malformed declarations would slip through.
 *
 * Run: npm run test:canonical-negative
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

const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
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
        canonical_formats_only: true,
        params: { foo: 'bar' },
        format_shape: 'multi_placement_takeover',
        format_schema: { uri: 'https://x.example/s', digest: SHA },
      },
    },
    {
      label: 'format_kind=custom rejects missing canonical_formats_only',
      expected: false,
      doc: {
        format_kind: 'custom',
        params: { foo: 'bar' },
        format_shape: 'multi_placement_takeover',
        format_schema: { uri: 'https://x.example/s', digest: SHA },
      },
    },
    {
      label: 'format_kind=custom rejects canonical_formats_only=false',
      expected: false,
      doc: {
        format_kind: 'custom',
        canonical_formats_only: false,
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
    {
      label: 'format_kind=image with canonical_formats_only=true accepted (Track-B canonical without v1 mapping)',
      expected: true,
      doc: { format_kind: 'image', canonical_formats_only: true, params: { width: 300, height: 250 } },
    },
    {
      label: 'format_kind=image with canonical_formats_only=false accepted',
      expected: true,
      doc: { format_kind: 'image', canonical_formats_only: false, params: { width: 300, height: 250 } },
    },
    {
      label: 'format_kind=image with v1_format_ref accepted (Track-A canonical linking to v1 named format)',
      expected: true,
      doc: {
        format_kind: 'image',
        v1_format_ref: [{ agent_url: 'https://nytimes.example', id: 'mrec_300x250' }],
        params: { width: 300, height: 250 },
      },
    },
    {
      label: 'format_kind=custom with v1_format_ref accepted (custom format linked to a v1 named format)',
      expected: true,
      doc: {
        format_kind: 'custom',
        v1_format_ref: [{ agent_url: 'https://nytimes.example', id: 'homepage_takeover' }],
        format_shape: 'multi_placement_takeover',
        format_schema: { uri: 'https://x.example/s', digest: SHA },
        params: { foo: 'bar' },
      },
    },
    {
      label: 'canonical_formats_only=true AND v1_format_ref rejected (mutually exclusive)',
      expected: false,
      doc: {
        format_kind: 'image',
        canonical_formats_only: true,
        v1_format_ref: [{ agent_url: 'https://nytimes.example', id: 'mrec_300x250' }],
        params: { width: 300, height: 250 },
      },
    },
    {
      label: 'format_kind=custom with neither canonical_formats_only:true nor v1_format_ref rejected',
      expected: false,
      doc: {
        format_kind: 'custom',
        format_shape: 'multi_placement_takeover',
        format_schema: { uri: 'https://x.example/s', digest: SHA },
        params: { foo: 'bar' },
      },
    },
    {
      label: 'v1_format_ref multi-entry array accepted (multi-size fan-out)',
      expected: true,
      doc: {
        format_kind: 'image',
        v1_format_ref: [
          { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' },
          { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_728x90_image' },
          { agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_970x250_image' },
        ],
        params: {
          sizes: [
            { width: 300, height: 250 },
            { width: 728, height: 90 },
            { width: 970, height: 250 },
          ],
        },
      },
    },
  ],
  '/schemas/formats/canonical/image.json': [
    {
      label: 'size-mode mutex: width+height AND sizes[] rejected',
      expected: false,
      doc: { width: 300, height: 250, sizes: [{ width: 728, height: 90 }] },
    },
    {
      label: 'size-mode mutex: width+height AND min_width rejected',
      expected: false,
      doc: { width: 300, height: 250, min_width: 100 },
    },
    {
      label: 'size-mode mutex: sizes[] AND min_height rejected',
      expected: false,
      doc: { sizes: [{ width: 300, height: 250 }], min_height: 200 },
    },
    {
      label: 'fixed mode: width without height rejected',
      expected: false,
      doc: { width: 300 },
    },
    {
      label: 'fixed mode: width+height alone accepted',
      expected: true,
      doc: { width: 300, height: 250 },
    },
    {
      label: 'multi-size mode: sizes[] alone accepted',
      expected: true,
      doc: { sizes: [{ width: 300, height: 250 }, { width: 728, height: 90 }] },
    },
    {
      label: 'responsive mode: min/max range alone accepted',
      expected: true,
      doc: { min_width: 300, max_width: 970, min_height: 50, max_height: 250 },
    },
    {
      label: 'none mode: no size declared accepted (e.g., format-shape carrier)',
      expected: true,
      doc: {},
    },
  ],
  '/schemas/core/assets/pixel-tracker-asset.json': [
    {
      label: 'minimal valid pixel_tracker (impression / img)',
      expected: true,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'impression',
        method: 'img',
        url: 'https://measurement.example.com/imp?cb={CACHEBUSTER}',
      },
    },
    {
      label: 'valid pixel_tracker with method:js (impression jstracker)',
      expected: true,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'impression',
        method: 'js',
        url: 'https://measurement.example.com/jstracker.js?cid={CREATIVE_ID}',
      },
    },
    {
      label: 'valid pixel_tracker for viewable_mrc_50',
      expected: true,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'viewable_mrc_50',
        method: 'img',
        url: 'https://measurement.example.com/mrc50?cid={CREATIVE_ID}',
      },
    },
    {
      label: 'valid pixel_tracker for click',
      expected: true,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'click',
        method: 'img',
        url: 'https://measurement.example.com/click?cid={CREATIVE_ID}',
      },
    },
    {
      label: 'valid pixel_tracker for audible_video_complete (IAB event 500)',
      expected: true,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'audible_video_complete',
        method: 'img',
        url: 'https://measurement.example.com/audible_complete?cid={CREATIVE_ID}',
      },
    },
    {
      label: 'valid pixel_tracker for custom event with custom_event_name',
      expected: true,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'custom',
        custom_event_name: 'engagement_3s',
        method: 'img',
        url: 'https://measurement.example.com/engagement?cid={CREATIVE_ID}',
      },
    },
    {
      label: 'event=custom WITHOUT custom_event_name rejected',
      expected: false,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'custom',
        method: 'img',
        url: 'https://measurement.example.com/custom_no_name',
      },
    },
    {
      label: 'event=impression WITH custom_event_name rejected (only valid when event=custom)',
      expected: false,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'impression',
        custom_event_name: 'should_not_be_here',
        method: 'img',
        url: 'https://measurement.example.com/imp',
      },
    },
    {
      label: 'invalid event enum value rejected',
      expected: false,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'totally_made_up_event',
        method: 'img',
        url: 'https://measurement.example.com/x',
      },
    },
    {
      label: 'invalid method enum value rejected',
      expected: false,
      doc: {
        asset_type: 'pixel_tracker',
        event: 'impression',
        method: 'server',
        url: 'https://measurement.example.com/x',
      },
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
