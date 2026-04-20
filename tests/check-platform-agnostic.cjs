#!/usr/bin/env node
/**
 * Platform-agnosticism lint
 *
 * Enforces the rule in docs/spec-guidelines.md#platform-agnosticism: normative
 * schema field names MUST NOT represent a specific vendor's version of a
 * general concept. Vendor-specific fields belong under `ext.{vendor}`.
 *
 * This lint walks `static/schemas/source/` and flags property names containing
 * known vendor tokens. It does NOT flag enum values — values naming external
 * systems / formats / identifier spaces (e.g., `nielsen_dma`, `roku_channel_id`,
 * `google_merchant_center`) are legitimate per the spec guideline.
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

// Vendor tokens that indicate a platform-specific field when used in a property
// name. Matched on whole-token boundaries (start of string, _, or end of string).
const VENDOR_TOKENS = [
  'gam', 'ttd',
  'google', 'amazon', 'apple', 'microsoft',
  'meta', 'facebook', 'instagram',
  'openai', 'anthropic',
  'nielsen', 'scope3', 'roku',
];

// Property names that contain a vendor token but are explicitly allowed
// because they reference a canonical external identifier space, not a
// vendor-specific version of a general concept.
// Add entries with justification as comments.
const FIELD_ALLOWLIST = new Set([
  'apple_podcast_id', // Apple Podcasts is the canonical podcast platform ID namespace.
  'apple_id',         // Apple App Store ID — the canonical identifier for App Store items.
  'nielsen_dma',      // Nielsen DMA is the industry-standard geographic division, not "Nielsen's version of geography".
]);

function findJSONFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJSONFiles(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function fieldNameContainsVendorToken(name) {
  const lower = name.toLowerCase();
  for (const token of VENDOR_TOKENS) {
    const re = new RegExp(`(^|_)${token}(_|$)`);
    if (re.test(lower)) return token;
  }
  return null;
}

function walkSchema(node, ctx) {
  if (!node || typeof node !== 'object') return;

  if (node.properties && typeof node.properties === 'object') {
    for (const [key, sub] of Object.entries(node.properties)) {
      ctx.onPropertyName(key, ctx.path.concat(key));
      // Do not recurse into ext — the ext namespace is explicitly vendor-scoped.
      if (key === 'ext') continue;
      walkSchema(sub, { ...ctx, path: ctx.path.concat(key) });
    }
  }

  for (const k of ['items', 'additionalProperties', 'then', 'else', 'if', 'not']) {
    if (node[k] && typeof node[k] === 'object') walkSchema(node[k], ctx);
  }
  for (const k of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[k])) {
      for (const item of node[k]) walkSchema(item, ctx);
    }
  }
  if (node.patternProperties && typeof node.patternProperties === 'object') {
    for (const sub of Object.values(node.patternProperties)) walkSchema(sub, ctx);
  }
  for (const defsKey of ['$defs', 'definitions']) {
    if (node[defsKey] && typeof node[defsKey] === 'object') {
      for (const def of Object.values(node[defsKey])) walkSchema(def, ctx);
    }
  }
}

function lint() {
  const files = findJSONFiles(SCHEMA_BASE_DIR);
  const violations = [];
  const seen = new Set();

  for (const file of files) {
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`Skipping ${path.relative(SCHEMA_BASE_DIR, file)}: ${e.message}`);
      continue;
    }
    const rel = path.relative(SCHEMA_BASE_DIR, file);
    walkSchema(schema, {
      path: [],
      onPropertyName: (name, pathArr) => {
        if (FIELD_ALLOWLIST.has(name)) return;
        const token = fieldNameContainsVendorToken(name);
        if (!token) return;
        const key = `${rel}:${pathArr.join('.')}`;
        if (seen.has(key)) return;
        seen.add(key);
        violations.push({ file: rel, fieldPath: pathArr.join('.'), field: name, token });
      },
    });
  }

  const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
  const red = (s) => `\x1b[31m${s}\x1b[0m`;
  const green = (s) => `\x1b[32m${s}\x1b[0m`;

  console.log(cyan('🧪 Platform-agnosticism lint'));
  console.log(cyan('=============================='));
  console.log(`Scanned ${files.length} schema files for vendor tokens in property names.`);

  if (violations.length === 0) {
    console.log(green(`✅ No violations (${VENDOR_TOKENS.length} vendor tokens checked: ${VENDOR_TOKENS.join(', ')}).`));
    process.exit(0);
  }

  console.error(red(`\n❌ ${violations.length} violation(s) found:\n`));
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    Field ${red(v.field)} (token: ${v.token}) at ${v.fieldPath}`);
    console.error(`    Fix: move to ext.${v.token} — see docs/spec-guidelines.md#platform-agnosticism\n`);
  }
  process.exit(1);
}

lint();
