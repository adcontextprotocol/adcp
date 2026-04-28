#!/usr/bin/env node
/**
 * Platform-agnosticism lint
 *
 * Enforces the rule in docs/spec-guidelines.md#platform-agnosticism: normative
 * schema field names and enum/const values MUST NOT represent a specific
 * vendor's version of a general concept. Vendor-specific fields belong under
 * `ext.{vendor}`.
 *
 * Scans `static/schemas/source/` and flags:
 *   - Property names containing known vendor tokens (outside ext.*)
 *   - Enum/const values containing known vendor tokens (outside ext.*)
 *
 * Note: title/description text is intentionally excluded. Vendor names in
 * prose descriptions are permitted per spec-guidelines.md — e.g., explaining
 * that a field accepts Google Merchant Center format is legitimate context,
 * not platform lock-in.
 *
 * Exit codes:
 *   0 — no violations
 *   1 — violations found
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

// Vendor tokens that indicate platform-specific content when used in a property
// name or enum/const value. Matched on whole-token boundaries (_, start, end).
const VENDOR_TOKENS = [
  'gam', 'ttd',
  'google', 'amazon', 'apple', 'microsoft',
  'meta', 'facebook', 'instagram',
  'openai', 'anthropic',
  'nielsen', 'scope3', 'roku',
  'linkedin',
];

// Pre-compiled regexes for each vendor token (avoids recompiling per-value).
const VENDOR_REGEXES = new Map(
  VENDOR_TOKENS.map(t => [t, new RegExp(`(^|_)${t}(_|$)`)])
);

// Property names that contain a vendor token but are explicitly allowed
// because they reference a canonical external identifier space, not a
// vendor-specific version of a general concept.
// Add entries with justification as comments.
const FIELD_ALLOWLIST = new Set([
  'apple_podcast_id', // Apple Podcasts is the canonical podcast platform ID namespace.
  'apple_id',         // Apple App Store ID — the canonical identifier for App Store items.
  'nielsen_dma',      // Nielsen DMA is the industry-standard geographic division, not "Nielsen's version of geography".
]);

// Enum / const values that contain a vendor token but are explicitly allowed.
// Uses path-qualified entries: each entry must match BOTH value and the schema
// file path (path-suffix or exact match). Flat-value allowlisting is
// insufficient because the same token may be legitimate in one enum but a
// violation in another — e.g., "roku" is a valid genre taxonomy identifier in
// genre-taxonomy.json but would be a violation in a targeting-method enum.
//
// pathContains is matched as: relPath === e.pathContains OR
// relPath.endsWith('/' + e.pathContains). This is a path-separator-aware
// suffix check — it matches the exact relative path or a path ending with
// /<pathContains>, preventing substring collisions (e.g., 'subbrand.json'
// would NOT match a pathContains of 'brand.json').
//
// When adding an entry, include:
//   - value:       the exact enum/const string
//   - pathContains: exact relative path or path suffix (e.g., 'enums/identifier-types.json')
//   - comment:     one-line justification (inline below)
const ENUM_VALUE_ALLOWLIST = [
  // brand.json — store property: platform names ARE the canonical app-store
  // identifiers; no platform-neutral alternative name exists.
  { value: 'apple',  pathContains: 'brand.json' },
  { value: 'google', pathContains: 'brand.json' },
  { value: 'amazon', pathContains: 'brand.json' },
  { value: 'roku',   pathContains: 'brand.json' },

  // brand.json — feed_format: google_merchant_center and facebook_catalog are
  // widely-adopted open interchange formats implemented by many third parties.
  { value: 'google_merchant_center', pathContains: 'brand.json' },
  { value: 'facebook_catalog',       pathContains: 'brand.json' },
  // openai_product_feed is contested (see #3456): code-reviewer treats it as
  // a violation; protocol expert treats it as a canonical feed schema identifier
  // parallel to google_merchant_center. Allowlisted pending @bokelley decision.
  { value: 'openai_product_feed',    pathContains: 'brand.json' },

  // enums/demographic-system.json — Nielsen notation IS the industry-standard
  // demographic audience measurement vocabulary (parallel to Nielsen DMA).
  { value: 'nielsen', pathContains: 'enums/demographic-system.json' },

  // enums/device-platform.json — Roku OS is a distinct CTV operating system
  // name, same as tvos, fire_os, tizen, webos.
  { value: 'roku_os', pathContains: 'enums/device-platform.json' },

  // enums/distribution-identifier-type.json — canonical platform ID namespaces.
  { value: 'apple_podcast_id', pathContains: 'enums/distribution-identifier-type.json' },
  { value: 'amazon_music_id',  pathContains: 'enums/distribution-identifier-type.json' },
  { value: 'amazon_title_id',  pathContains: 'enums/distribution-identifier-type.json' },
  { value: 'roku_channel_id',  pathContains: 'enums/distribution-identifier-type.json' },

  // enums/feed-format.json — widely-adopted open interchange formats.
  { value: 'google_merchant_center', pathContains: 'enums/feed-format.json' },
  { value: 'facebook_catalog',       pathContains: 'enums/feed-format.json' },
  // linkedin_jobs names LinkedIn's job-listing feed format, the canonical format
  // for ATS/job-board integrations — parallel to google_merchant_center for retail.
  { value: 'linkedin_jobs', pathContains: 'enums/feed-format.json' },

  // enums/genre-taxonomy.json — platform taxonomy system identifiers, comparable
  // to gracenote and eidr. Note: bare 'roku' is inconsistent with the {vendor}_genres
  // pattern; rename to 'roku_genres' is a breaking change tracked in #3457.
  { value: 'apple_genres',  pathContains: 'enums/genre-taxonomy.json' },
  { value: 'google_genres', pathContains: 'enums/genre-taxonomy.json' },
  { value: 'amazon_genres', pathContains: 'enums/genre-taxonomy.json' },
  { value: 'roku',          pathContains: 'enums/genre-taxonomy.json' },

  // enums/identifier-types.json — canonical app-store and platform ID namespaces.
  { value: 'apple_app_store_id', pathContains: 'enums/identifier-types.json' },
  { value: 'google_play_id',     pathContains: 'enums/identifier-types.json' },
  { value: 'roku_store_id',      pathContains: 'enums/identifier-types.json' },
  { value: 'apple_tv_bundle',    pathContains: 'enums/identifier-types.json' },
  { value: 'apple_podcast_id',   pathContains: 'enums/identifier-types.json' },

  // enums/metro-system.json — Nielsen DMA is the industry-standard geographic
  // division (same justification as FIELD_ALLOWLIST entry).
  { value: 'nielsen_dma', pathContains: 'enums/metro-system.json' },
];

function findJSONFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJSONFiles(full));
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function containsVendorToken(name) {
  const lower = name.toLowerCase();
  for (const [token, re] of VENDOR_REGEXES) {
    if (re.test(lower)) return token;
  }
  return null;
}

function isEnumValueAllowed(value, relPath) {
  return ENUM_VALUE_ALLOWLIST.some(
    e => e.value === value &&
      (relPath === e.pathContains || relPath.endsWith('/' + e.pathContains))
  );
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

  // Enum and const value scanning.
  if (Array.isArray(node.enum)) {
    for (const v of node.enum) {
      if (typeof v === 'string') ctx.onEnumValue(v, ctx.path);
    }
  }
  if (typeof node.const === 'string') {
    ctx.onEnumValue(node.const, ctx.path);
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
  // Intentionally skip node.examples and node.default — example payloads and
  // default values are user-data samples, not normative value enumerations.
}

function lint() {
  const files = findJSONFiles(SCHEMA_BASE_DIR);
  const fieldViolations = [];
  const enumViolations = [];
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
        const token = containsVendorToken(name);
        if (!token) return;
        const key = `field:${rel}:${pathArr.join('.')}`;
        if (seen.has(key)) return;
        seen.add(key);
        fieldViolations.push({ file: rel, fieldPath: pathArr.join('.'), field: name, token });
      },
      onEnumValue: (value, pathArr) => {
        if (isEnumValueAllowed(value, rel)) return;
        const token = containsVendorToken(value);
        if (!token) return;
        const key = `enum:${rel}:${pathArr.join('.')}:${value}`;
        if (seen.has(key)) return;
        seen.add(key);
        enumViolations.push({ file: rel, fieldPath: pathArr.join('.'), value, token });
      },
    });
  }

  const cyan  = s => `\x1b[36m${s}\x1b[0m`;
  const red   = s => `\x1b[31m${s}\x1b[0m`;
  const green = s => `\x1b[32m${s}\x1b[0m`;

  console.log(cyan('🧪 Platform-agnosticism lint'));
  console.log(cyan('=============================='));
  console.log(`Scanned ${files.length} schema files.`);
  console.log(`Checked: property names, enum values, const values (${VENDOR_TOKENS.length} vendor tokens: ${VENDOR_TOKENS.join(', ')}).`);
  console.log(`Note: title/description text intentionally excluded — see docs/spec-guidelines.md.\n`);

  const total = fieldViolations.length + enumViolations.length;

  if (total === 0) {
    console.log(green(`✅ No violations.`));
    process.exit(0);
  }

  console.error(red(`\n❌ ${total} violation(s) found:\n`));
  for (const v of fieldViolations) {
    console.error(`  ${v.file}`);
    console.error(`    Property ${red(v.field)} (token: ${v.token}) at ${v.fieldPath}`);
    console.error(`    Fix: move to ext.${v.token} — see docs/spec-guidelines.md#platform-agnosticism\n`);
  }
  for (const v of enumViolations) {
    console.error(`  ${v.file}`);
    console.error(`    Enum/const value ${red(v.value)} (token: ${v.token}) near ${v.fieldPath || 'root'}`);
    console.error(`    Fix: use a vendor-neutral value or add to ENUM_VALUE_ALLOWLIST with`);
    console.error(`    a path-qualified justification — see docs/spec-guidelines.md#platform-agnosticism\n`);
  }
  process.exit(1);
}

lint();
