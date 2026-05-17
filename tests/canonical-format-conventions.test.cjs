#!/usr/bin/env node
/**
 * Canonical Formats convention lint
 *
 * Catches drift in format-declaration fixtures and schemas:
 *
 *   1. v1_format_ref.agent_url MUST follow the AAO-hosted convention:
 *      - IAB-standard formats → https://creative.adcontextprotocol.org
 *      - Platform-adopted     → platform's adopted agent_url (we don't validate which platforms have adopted)
 *      - Platform-unadopted   → https://creative.adcontextprotocol.org/translated/<platform>
 *      - Seller-bespoke       → seller's own agent_url (no constraint)
 *
 *      Disallowed: bare `<platform>.example` URIs for known-unadopted platforms (meta, google,
 *      openai, tiktok, snap, pinterest). Use the community-mirror path instead so all sellers
 *      converge on the same v1 namespace.
 *
 *   2. platform_extensions[].uri MUST follow the same rule (extensions ARE owned by the agent
 *      identified by the URI base, so the same hosting convention applies).
 *
 *   3. canonical_formats_only and v1_format_ref are mutually exclusive (also enforced at schema
 *      layer, doubled here so a test failure surfaces a clear narrative diagnostic).
 *
 *   4. format_kind: "custom" requires canonical_formats_only:true OR v1_format_ref (per
 *      schema if/then; the test also surfaces the rule by name).
 *
 *   5. Slot-param consistency: when a format declaration's params include `cta_values` or
 *      `*_max_chars` for a content type, the canonical's default slots OR the product's
 *      override slots SHOULD declare a matching slot. Soft-warn (does not fail) until the
 *      canonicals are updated to add default slots for cta and primary_text.
 *
 * Run: node tests/canonical-format-conventions.test.cjs
 */

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.resolve(__dirname, '../static/examples/products/canonical');
const ADAGENTS_FIXTURES = path.resolve(__dirname, '../static/examples/adagents');
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';

const UNADOPTED_PLATFORMS = ['meta', 'google', 'openai', 'tiktok', 'snap', 'pinterest', 'youtube'];
const AAO_CATALOG = 'creative.adcontextprotocol.org';
const CANONICAL_DIR = path.resolve(__dirname, '../static/schemas/source/formats/canonical');

// Load default slot ids per canonical format_kind from the canonical schemas.
const CANONICAL_DEFAULT_SLOTS = (() => {
  const out = {};
  for (const f of fs.readdirSync(CANONICAL_DIR)) {
    if (!f.endsWith('.json') || f === '_base.json') continue;
    const kind = f.replace(/\.json$/, '');
    try {
      const s = JSON.parse(fs.readFileSync(path.join(CANONICAL_DIR, f), 'utf8'));
      const def = s.properties && s.properties.slots && s.properties.slots.default;
      out[kind] = new Set((def || []).map(slot => slot.asset_group_id));
    } catch (_) { out[kind] = new Set(); }
  }
  return out;
})();

let errors = 0;
let warnings = 0;

function fail(file, msg) {
  console.log(`  ${RED}✗${RESET} ${file}: ${msg}`);
  errors++;
}
function warn(file, msg) {
  console.log(`  ${YELLOW}⚠${RESET} ${file}: ${msg}`);
  warnings++;
}
function pass(file, msg) {
  console.log(`  ${GREEN}✓${RESET} ${file}${msg ? ': ' + msg : ''}`);
}

function isUnadoptedPlatformDotExample(url) {
  const m = url.match(/^https?:\/\/([a-z0-9-]+)\.example(\/|$)/);
  return m && UNADOPTED_PLATFORMS.includes(m[1]);
}

function checkAgentUrlConvention(url, ctx, file) {
  if (isUnadoptedPlatformDotExample(url)) {
    const platform = url.match(/^https?:\/\/([a-z0-9-]+)\.example/)[1];
    fail(file, `${ctx} uses unadopted-platform placeholder ${url} — use the community mirror at https://${AAO_CATALOG}/translated/${platform}/ instead`);
    return false;
  }
  return true;
}

function checkDeclaration(decl, ctx, file) {
  // Mutex: canonical_formats_only and v1_format_ref
  if (decl.canonical_formats_only === true && decl.v1_format_ref) {
    fail(file, `${ctx} has both canonical_formats_only:true AND v1_format_ref — mutually exclusive`);
  }

  // format_kind: custom requires canonical_formats_only:true OR v1_format_ref
  if (decl.format_kind === 'custom') {
    if (!decl.canonical_formats_only && !decl.v1_format_ref) {
      fail(file, `${ctx} format_kind:custom requires canonical_formats_only:true OR v1_format_ref`);
    }
  }

  // v1_format_ref.agent_url convention
  if (decl.v1_format_ref && decl.v1_format_ref.agent_url) {
    checkAgentUrlConvention(decl.v1_format_ref.agent_url, `${ctx}.v1_format_ref.agent_url`, file);
  }

  // platform_extensions[].uri convention
  const exts = (decl.params && decl.params.platform_extensions) || [];
  exts.forEach((ext, i) => {
    if (ext.uri) checkAgentUrlConvention(ext.uri, `${ctx}.params.platform_extensions[${i}].uri`, file);
  });

  // Slot-param consistency. A declaration that doesn't override `slots[]` inherits the
  // canonical's default slot set. Only warn when the declaration EITHER (a) overrides
  // slots[] and removes the slot the param references, or (b) the canonical itself
  // doesn't carry the slot as a default.
  const params = decl.params || {};
  const overrideSlots = params.slots;
  const inheritedDefaults = CANONICAL_DEFAULT_SLOTS[decl.format_kind] || new Set();
  const effectiveSlotIds = overrideSlots
    ? new Set(overrideSlots.map(s => s.asset_group_id))
    : inheritedDefaults;

  if (params.cta_values && !effectiveSlotIds.has('cta')) {
    warn(file, `${ctx} declares cta_values but effective slots[] has no 'cta' slot (canonical=${decl.format_kind})`);
  }
  if (params.primary_text_max_chars && !effectiveSlotIds.has('primary_text')) {
    warn(file, `${ctx} declares primary_text_max_chars but effective slots[] has no 'primary_text' slot (canonical=${decl.format_kind})`);
  }
}

function walkProductFixtures() {
  console.log(`\nProduct fixtures: ${FIXTURES_DIR}`);
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'));
    const opts = data.format_options || [];
    const localBefore = errors;
    opts.forEach((opt, i) => checkDeclaration(opt, `format_options[${i}]`, f));
    if (errors === localBefore) pass(f);
  }
}

function walkAdagentsFixtures() {
  if (!fs.existsSync(ADAGENTS_FIXTURES)) return;
  console.log(`\nadagents.json fixtures: ${ADAGENTS_FIXTURES}`);
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.json')) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const formats = data.formats || [];
      const localBefore = errors;
      formats.forEach((decl, i) => checkDeclaration(decl, `formats[${i}]`, path.relative(ADAGENTS_FIXTURES, p)));
      if (errors === localBefore) pass(path.relative(ADAGENTS_FIXTURES, p));
    }
  }
  walk(ADAGENTS_FIXTURES);
}

console.log('Canonical-Formats Convention Lint');
console.log('==================================');

walkProductFixtures();
walkAdagentsFixtures();

console.log('');
if (errors > 0) {
  console.log(`${RED}✗ ${errors} convention violations${RESET}${warnings ? `, ${YELLOW}${warnings} warnings${RESET}` : ''}`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`${GREEN}✓ no violations${RESET}, ${YELLOW}${warnings} warnings${RESET} (canonicals need cta/primary_text default slots — see canonical-formats.mdx)`);
  process.exit(0);
}
console.log(`${GREEN}✓ all conventions clean${RESET}`);
