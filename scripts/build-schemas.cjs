#!/usr/bin/env node

/**
 * Build script for AdCP schema versioning
 *
 * This script has two modes:
 *
 * 1. Development build (default): `npm run build:schemas`
 *    - Rebuilds only dist/schemas/latest/ with current source schemas
 *    - Preserves existing released version directories (e.g., 2.5.0/)
 *    - Updates symlinks to point to appropriate versions
 *
 * 2. Release build: `npm run build:schemas -- --release`
 *    - Creates a new versioned directory (e.g., dist/schemas/2.6.0/)
 *    - Updates major/minor symlinks to point to new release
 *    - Also updates latest/ to match the release
 *
 * Schema paths:
 * - /schemas/latest/     - Current development schemas (rebuilt on every build)
 * - /schemas/{version}/  - Released versions (only created with --release)
 * - /schemas/v{major}/   - Points to latest release of that major version
 * - /schemas/v{major}.{minor}/ - Points to latest release of that minor version
 *
 * Extension handling:
 * - Extensions are auto-discovered from static/schemas/source/extensions/
 * - Each extension has valid_from/valid_until to specify compatible AdCP versions
 * - The build generates extensions/index.json with extensions valid for the target version
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCE_DIR = path.join(__dirname, '../static/schemas/source');
const DIST_DIR = path.join(__dirname, '../dist/schemas');
const PACKAGE_JSON = path.join(__dirname, '../package.json');
const SKILLS_DIR = path.join(__dirname, '../skills');

// Parse command line arguments
const args = process.argv.slice(2);
const isRelease = args.includes('--release');

function getVersion() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return pkg.version;
}

/**
 * Get all released version directories in dist/schemas/
 * Returns array sorted by semver (descending)
 */
function getAllReleasedVersions() {
  if (!fs.existsSync(DIST_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(DIST_DIR, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
    .map(e => e.name)
    .sort((a, b) => {
      // Sort by semver (descending)
      const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
      const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
      if (aMajor !== bMajor) return bMajor - aMajor;
      if (aMinor !== bMinor) return bMinor - aMinor;
      return bPatch - aPatch;
    });
}

/**
 * Find the latest released version directory in dist/schemas/
 * Returns null if no released versions exist
 */
function findLatestReleasedVersion() {
  const versions = getAllReleasedVersions();
  return versions[0] || null;
}

/**
 * Get the latest patch version for each minor version series
 * e.g., for [2.6.0, 2.5.1, 2.5.0], returns { '2.6': '2.6.0', '2.5': '2.5.1' }
 */
function getLatestPatchPerMinor() {
  const versions = getAllReleasedVersions();
  const latestPerMinor = {};

  for (const version of versions) {
    const minor = getMinorVersion(version);
    // Since versions are sorted descending, first one wins
    if (!latestPerMinor[minor]) {
      latestPerMinor[minor] = version;
    }
  }

  return latestPerMinor;
}

function getMajorVersion(version) {
  return version.split('.')[0];
}

function getMinorVersion(version) {
  const parts = version.split('.');
  if (parts.length < 2) {
    throw new Error(`Invalid semantic version: ${version}. Expected format: major.minor.patch`);
  }
  return `${parts[0]}.${parts[1]}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Mutating-request idempotency lint ───────────────────────────────
//
// Every mutating AdCP request MUST declare `idempotency_key` in its
// top-level `required` array, per v3-readiness.mdx §"idempotency_key
// required on all mutating requests," release-notes.mdx 3.0 entry, and
// adcontextprotocol/adcp#2315. This is enforced at the storyboard layer
// by scripts/build-compliance.cjs (see #2372). This complementary lint
// enforces it at the *schema* layer — so a new mutating request schema
// can't ship without the required field, which would silently bypass the
// storyboard lint (the storyboard lint only fails when a storyboard
// declares sample_request but omits the key; if the schema never
// required it, the storyboard lint sees the task as non-mutating and
// passes).
//
// A request schema is considered non-mutating if:
//   1. Its basename matches a read-only verb pattern
//      (`get-`, `list-`, `check-`, `validate-`, `preview-`, optionally
//      prefixed by a domain like `si-get-*`), OR
//   2. It's one of a short allowlist of core/utility request types that
//      don't represent operations (pagination, package, tasks-*,
//      comply-test-controller, context-match, identity-match), OR
//   3. Its `$comment` or `description` contains the phrase
//      "naturally idempotent" (case-insensitive) — the explicit exemption
//      pattern documented in sponsored-intelligence/si-terminate-session-request.json.
//
// Otherwise the schema's top-level `required` array MUST include
// `idempotency_key`.

// Read-only verb pattern. Anchored to the start so tools like
// `create-collection-list-request.json` aren't mis-classified as read-only
// because they happen to contain `-list-` mid-name. An optional single-word
// domain prefix (e.g., `si-get-`, `tasks-list-`) is allowed; the prefix MUST
// be a single hyphen-free token, ruling out compound names like
// `create-collection-list-`.
const READ_ONLY_VERB_PATTERN = /^(?:[a-z]+-)?(get|list|check|validate|preview|search)-/;
const NON_OPERATION_ALLOWLIST = new Set([
  // Embedded input types / utility request shapes that aren't operations
  // themselves — they're referenced via $ref from operation schemas.
  'pagination-request.json',
  'package-request.json',
  // Read-only evaluation operations (TMP matching — no state mutation).
  'context-match-request.json',
  'identity-match-request.json',
]);
// Note: tasks-get-request.json and tasks-list-request.json are matched by
// READ_ONLY_VERB_PATTERN via the "-get-" / "-list-" fragments — no
// explicit allowlist entry needed.
//
// Note: comply-test-controller-request.json IS mutating (force_*_status,
// simulate_*) but carries an explicit "naturally idempotent" marker in
// its description — replays converge to the same observable state because
// the target state is part of the payload. It passes the lint via the
// hasNaturallyIdempotentMarker path, not the allowlist.

function isNonMutatingRequestBasename(basename) {
  if (READ_ONLY_VERB_PATTERN.test(basename)) return true;
  if (NON_OPERATION_ALLOWLIST.has(basename)) return true;
  return false;
}

function hasNaturallyIdempotentMarker(schema) {
  const haystack = String(schema.$comment || '') + ' ' + String(schema.description || '');
  return /naturally idempotent/i.test(haystack);
}

// Classify a request schema as mutating or non-mutating using the same rules
// the lint enforces. Returns true if the operation mutates state.
//
// Read-only verb basenames (get-/list-/check-/validate-/preview-) and the
// NON_OPERATION_ALLOWLIST entries are non-mutating utility shapes.
// Anything else is a state-changing operation: it MUST either declare
// idempotency_key in `required` or carry a "naturally idempotent" marker
// (which means it uses a different idempotency key like session_id).
// Both forms are mutating; the lint above guarantees one of them is present.
//
// Used by both lintMutatingRequestsRequireIdempotencyKey and the manifest
// generator — single source of truth for "is this a mutating tool?".
function classifyRequestMutating(filePath) {
  return !isNonMutatingRequestBasename(path.basename(filePath));
}

function lintMutatingRequestsRequireIdempotencyKey(sourceDir) {
  const violations = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        // Skip extensions/ and bundled/ — extension schemas manage their
        // own idempotency semantics per the extension registry, and
        // bundled/ is generated output.
        if (entry.name === 'extensions' || entry.name === 'bundled') continue;
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('-request.json')) continue;
      if (isNonMutatingRequestBasename(entry.name)) continue;
      let schema;
      try { schema = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch { continue; }
      const required = Array.isArray(schema.required) ? schema.required : [];
      if (required.includes('idempotency_key')) continue;
      if (hasNaturallyIdempotentMarker(schema)) continue;
      violations.push(path.relative(sourceDir, p));
    }
  }
  walk(sourceDir);

  if (violations.length > 0) {
    const lines = violations.map(v =>
      `  ${v}: mutating request schema does not declare idempotency_key in required[], and does not carry a "naturally idempotent" exemption marker.`
    );
    throw new Error(
      `Schema idempotency lint: ${violations.length} request schema(s) appear to represent mutating operations without requiring idempotency_key.\n\n` +
      lines.join('\n') +
      `\n\nFix options:\n` +
      `  A) Add "idempotency_key" to the top-level "required" array (the common case — any create/update/delete/sync/activate/submit operation).\n` +
      `  B) If the operation is genuinely read-only, rename the schema file to start with get-/list-/check-/validate-/preview- (or add it to NON_OPERATION_ALLOWLIST in scripts/build-schemas.cjs if it's a core utility).\n` +
      `  C) If the operation is naturally idempotent by some other key (e.g., session_id), add the phrase "naturally idempotent" to the schema's description or $comment, matching the pattern in sponsored-intelligence/si-terminate-session-request.json.`
    );
  }
}

// ── Error code enumMetadata coverage lint ─────────────────────────────────
//
// Every value in enums/error-code.json `enum` MUST have a structured
// `enumMetadata[code]` entry with `recovery` (one of correctable/transient/
// terminal) and `suggestion` (string remediation hint). This lint stops the
// recovery-classification drift that bit the TS SDK (adcp-client#1135 — 17
// missing codes, 3 wrong recovery values that ran for over a year because
// SDKs were hand-curating from `enumDescriptions` prose).
//
// We also cross-check that the structured `recovery` matches the prose
// `Recovery: X` in `enumDescriptions` — if either side drifts, the build
// fails. SDKs MUST consume `enumMetadata` going forward; `enumDescriptions`
// remains the human-readable narrative.
//
// See adcp#3725 for the full proposal and rationale.

const VALID_RECOVERY_VALUES = new Set(['correctable', 'transient', 'terminal']);
const RECOVERY_PROSE_PATTERN = /Recovery:\s*(correctable|transient|terminal)\b/i;

function lintErrorCodeEnumMetadata(sourceDir) {
  const errorCodePath = path.join(sourceDir, 'enums', 'error-code.json');
  const schema = JSON.parse(fs.readFileSync(errorCodePath, 'utf8'));
  const violations = [];

  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    throw new Error(`Schema enumMetadata lint: enums/error-code.json has no \`enum\` array.`);
  }
  if (!schema.enumMetadata || typeof schema.enumMetadata !== 'object') {
    throw new Error(
      `Schema enumMetadata lint: enums/error-code.json is missing the \`enumMetadata\` block.\n` +
      `Add an enumMetadata object with one entry per code: { "<CODE>": { "recovery": "...", "suggestion": "..." } }.`
    );
  }

  const enumCodes = new Set(schema.enum);
  const metaCodes = new Set(
    Object.keys(schema.enumMetadata).filter(k => !k.startsWith('$'))
  );

  for (const code of enumCodes) {
    const meta = schema.enumMetadata[code];
    if (!meta || typeof meta !== 'object') {
      violations.push(`  ${code}: missing enumMetadata entry`);
      continue;
    }
    if (!VALID_RECOVERY_VALUES.has(meta.recovery)) {
      violations.push(`  ${code}: enumMetadata.recovery="${meta.recovery}" — must be correctable | transient | terminal`);
    }
    if (typeof meta.suggestion !== 'string' || meta.suggestion.length === 0) {
      violations.push(`  ${code}: enumMetadata.suggestion missing or empty`);
    }

    // Cross-check structured recovery against the prose in enumDescriptions.
    // If they disagree, one of them is wrong — bail and let the author fix it.
    const prose = schema.enumDescriptions && schema.enumDescriptions[code];
    if (typeof prose === 'string') {
      const m = prose.match(RECOVERY_PROSE_PATTERN);
      if (m && m[1].toLowerCase() !== meta.recovery) {
        violations.push(
          `  ${code}: enumMetadata.recovery="${meta.recovery}" disagrees with prose "Recovery: ${m[1]}" in enumDescriptions`
        );
      }
    }
  }

  for (const code of metaCodes) {
    if (!enumCodes.has(code)) {
      violations.push(`  ${code}: enumMetadata entry has no matching enum value (typo or stale entry?)`);
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Schema enumMetadata lint: ${violations.length} issue(s) in enums/error-code.json.\n\n` +
      violations.join('\n') +
      `\n\nSee adcp#3725. SDKs depend on enumMetadata to classify error recovery — drift here ships ` +
      `as recovery bugs in every downstream SDK.`
    );
  }
}

// ── Vendor metric semantic uniqueness lint ────────────────────────────────
//
// The reporting-capabilities.json `vendor_metrics` array and the
// delivery-metrics.json `vendor_metric_values` array both carry a semantic
// uniqueness key `(vendor.domain, vendor.brand_id, metric_id)`. JSON Schema
// `uniqueItems` was deliberately omitted because BrandRef carries optional
// fields whose absence/presence defeats deep-equal (e.g., `{domain:"x"}` and
// `{domain:"x",brand_id:"y"}` are structurally different objects even if they
// describe the same brand). This lint enforces the MUST constraint by
// normalizing the semantic tuple and checking for duplicates.
//
// Key normalization: use `|`-delimited string `domain|brand_id|metric_id`.
// The `|` separator is safe because domain (`[a-z0-9.-]`), brand_id
// (`[a-z0-9_]`), and metric_id (`[a-z][a-z0-9_]*`) cannot contain `|`. Absent
// brand_id normalizes to "" (empty string) — the empty string is distinct from
// any valid brand_id so `{domain:"x"}` and `{domain:"x",brand_id:""}` cannot
// collide with each other. This normalization is documented so the storyboard
// runner's future `field_unique_by_keys` implementation must match it.
//
// Scan surfaces:
//   1. `examples` arrays inside JSON schema files (at any depth).
//   2. TypeScript training-agent fixtures (`server/src/training-agent/**/*.ts`)
//      are explicitly called out in issue #3502 but currently contain no vendor
//      metric data. TS scanning would require a parser — deferred until a
//      fixture adds vendor metrics, at which point build failures will surface
//      the gap. See #3502 item 1 for the tracking comment.

/**
 * Recursively collect all `examples` values that contain vendor metric arrays.
 * Returns an array of { schemaPath, arrayField, tuples[] } objects.
 */
function collectVendorMetricExamples(obj, schemaPath, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectVendorMetricExamples(item, schemaPath, out);
    return out;
  }
  // If this object has vendor_metric_values or vendor_metrics, scan them.
  for (const field of ['vendor_metric_values', 'vendor_metrics']) {
    const arr = obj[field];
    if (!Array.isArray(arr) || arr.length < 2) continue;
    const tuples = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object' || !entry.vendor) continue;
      const domain = typeof entry.vendor.domain === 'string' ? entry.vendor.domain : '';
      const brandId = typeof entry.vendor.brand_id === 'string' ? entry.vendor.brand_id : '';
      const metricId = typeof entry.metric_id === 'string' ? entry.metric_id : '';
      tuples.push(`${domain}|${brandId}|${metricId}`);
    }
    if (tuples.length > 0) out.push({ schemaPath, arrayField: field, tuples });
  }
  // Recurse into all object values (handles nested examples inside `examples` arrays, etc.).
  for (const val of Object.values(obj)) collectVendorMetricExamples(val, schemaPath, out);
  return out;
}

function lintVendorMetricSemanticUniqueness(sourceDir) {
  const violations = [];

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'extensions' || entry.name === 'bundled') continue;
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      let schema;
      try { schema = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch { continue; }
      // Collect from top-level `examples` array and from any nested examples.
      const exampleValues = collectVendorMetricExamples(schema, path.relative(sourceDir, p));
      for (const { schemaPath, arrayField, tuples } of exampleValues) {
        const seen = new Set();
        for (const tuple of tuples) {
          if (seen.has(tuple)) {
            violations.push({ schemaPath, arrayField, tuple });
          }
          seen.add(tuple);
        }
      }
    }
  }

  walk(sourceDir);

  if (violations.length > 0) {
    const lines = violations.map(v =>
      `  ${v.schemaPath} — ${v.arrayField}: duplicate tuple "${v.tuple}" (key: domain|brand_id|metric_id)`
    );
    throw new Error(
      `Vendor metric uniqueness lint: ${violations.length} duplicate tuple(s) found in schema examples.\n\n` +
      lines.join('\n') +
      `\n\nFix: each (vendor.domain, vendor.brand_id, metric_id) tuple MUST appear at most once per array.\n` +
      `See static/schemas/source/core/reporting-capabilities.json and delivery-metrics.json for the\n` +
      `normative uniqueness constraint. Issue: adcontextprotocol/adcp#3502.`
    );
  }
}

/**
 * Compare two minor versions (e.g., "2.5" vs "2.6")
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
function compareMinorVersions(a, b) {
  const [aMajor, aMinor] = a.split('.').map(Number);
  const [bMajor, bMinor] = b.split('.').map(Number);
  if (aMajor !== bMajor) return aMajor - bMajor;
  return aMinor - bMinor;
}

/**
 * Reserved namespaces that cannot be used for typed extensions
 * These could cause confusion with core AdCP concepts
 */
const RESERVED_NAMESPACES = ['adcp', 'core', 'protocol', 'schema', 'meta', 'ext', 'context'];

/**
 * Validate that an extension namespace is not reserved
 * @param {string} namespace - Extension namespace to validate
 * @throws {Error} If namespace is reserved
 */
function validateExtensionNamespace(namespace) {
  if (RESERVED_NAMESPACES.includes(namespace.toLowerCase())) {
    throw new Error(`Namespace "${namespace}" is reserved and cannot be used for extensions`);
  }
}

/**
 * Discover extension files from the extensions directory
 * Returns array of { namespace, schema, path } objects
 */
function discoverExtensions(extensionsDir) {
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  const extensions = [];
  const files = fs.readdirSync(extensionsDir);

  for (const file of files) {
    // Skip non-JSON files and special files
    if (!file.endsWith('.json')) continue;
    if (file === 'index.json' || file === 'extension-meta.json') continue;

    const filePath = path.join(extensionsDir, file);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Extract namespace from $id (e.g., /schemas/extensions/sustainability.json -> sustainability)
      const namespace = file.replace('.json', '');

      // Validate namespace is not reserved
      validateExtensionNamespace(namespace);

      extensions.push({
        namespace,
        schema: content,
        path: filePath
      });
    } catch (error) {
      console.warn(`   ⚠️  Failed to parse extension ${file}: ${error.message}`);
    }
  }

  return extensions;
}

/**
 * Filter extensions to those valid for a given AdCP version
 * @param {Array} extensions - Array of extension objects from discoverExtensions
 * @param {string} targetVersion - Target AdCP version (e.g., "2.5.0" or "2.5")
 * @returns {Array} Extensions valid for the target version
 */
function filterExtensionsForVersion(extensions, targetVersion) {
  // Normalize to minor version for comparison
  const targetMinor = getMinorVersion(targetVersion);

  return extensions.filter(ext => {
    const { valid_from, valid_until } = ext.schema;

    // Must have valid_from
    if (!valid_from) {
      console.warn(`   ⚠️  Extension ${ext.namespace} missing valid_from, skipping`);
      return false;
    }

    // Check valid_from <= targetVersion
    if (compareMinorVersions(valid_from, targetMinor) > 0) {
      return false; // Extension requires newer version
    }

    // Check valid_until >= targetVersion (if specified)
    if (valid_until && compareMinorVersions(valid_until, targetMinor) < 0) {
      return false; // Extension no longer valid for this version
    }

    return true;
  });
}

/**
 * Generate the extensions/index.json registry for a target version
 * @param {Array} extensions - Array of valid extension objects
 * @param {string} targetVersion - Target version string for $id paths
 * @returns {Object} The generated registry object
 */
function generateExtensionRegistry(extensions, targetVersion) {
  const registry = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `/schemas/${targetVersion}/extensions/index.json`,
    title: 'AdCP Extension Registry',
    description: 'Auto-generated registry of formal AdCP extensions. Extensions provide typed schemas for vendor-specific or domain-specific data within the ext field. Agents declare which extensions they support in their agent card.',
    _generated: true,
    _generatedAt: new Date().toISOString(),
    extensions: {}
  };

  for (const ext of extensions) {
    registry.extensions[ext.namespace] = {
      $ref: `/schemas/${targetVersion}/extensions/${ext.namespace}.json`,
      title: ext.schema.title,
      description: ext.schema.description,
      valid_from: ext.schema.valid_from
    };

    // Include valid_until if specified
    if (ext.schema.valid_until) {
      registry.extensions[ext.namespace].valid_until = ext.schema.valid_until;
    }

    // Include docs_url if specified
    if (ext.schema.docs_url) {
      registry.extensions[ext.namespace].docs_url = ext.schema.docs_url;
    }
  }

  return registry;
}

/**
 * Build extensions for a target directory
 * - Discovers all extensions from source
 * - Filters to those valid for target version
 * - Copies valid extension schemas
 * - Generates the index.json registry
 */
function buildExtensions(sourceDir, targetDir, version) {
  const sourceExtensionsDir = path.join(sourceDir, 'extensions');
  const targetExtensionsDir = path.join(targetDir, 'extensions');

  // Always ensure extensions directory exists
  ensureDir(targetExtensionsDir);

  // Discover all extensions
  const allExtensions = discoverExtensions(sourceExtensionsDir);

  if (allExtensions.length === 0) {
    // No extensions yet - just copy the meta schema and generate empty registry
    const metaSchemaPath = path.join(sourceExtensionsDir, 'extension-meta.json');
    if (fs.existsSync(metaSchemaPath)) {
      let content = fs.readFileSync(metaSchemaPath, 'utf8');
      // Update $id to include version
      content = content.replace(
        /"\$id":\s*"\/schemas\//g,
        `"$id": "/schemas/${version}/`
      );
      fs.writeFileSync(path.join(targetExtensionsDir, 'extension-meta.json'), content);
    }

    // Generate empty registry
    const registry = generateExtensionRegistry([], version);
    fs.writeFileSync(
      path.join(targetExtensionsDir, 'index.json'),
      JSON.stringify(registry, null, 2)
    );

    return { total: 0, included: 0 };
  }

  // Filter extensions valid for this version
  const validExtensions = filterExtensionsForVersion(allExtensions, version);

  // Copy extension-meta.json (with version transform)
  const metaSchemaPath = path.join(sourceExtensionsDir, 'extension-meta.json');
  if (fs.existsSync(metaSchemaPath)) {
    let content = fs.readFileSync(metaSchemaPath, 'utf8');
    content = content.replace(
      /"\$id":\s*"\/schemas\//g,
      `"$id": "/schemas/${version}/`
    );
    fs.writeFileSync(path.join(targetExtensionsDir, 'extension-meta.json'), content);
  }

  // Copy each valid extension schema (with version transform)
  for (const ext of validExtensions) {
    let content = JSON.stringify(ext.schema, null, 2);
    // Update $id to include version
    content = content.replace(
      /"\$id":\s*"\/schemas\//g,
      `"$id": "/schemas/${version}/`
    );
    fs.writeFileSync(
      path.join(targetExtensionsDir, `${ext.namespace}.json`),
      content
    );
  }

  // Generate the registry index
  const registry = generateExtensionRegistry(validExtensions, version);
  fs.writeFileSync(
    path.join(targetExtensionsDir, 'index.json'),
    JSON.stringify(registry, null, 2)
  );

  return {
    total: allExtensions.length,
    included: validExtensions.length,
    extensions: validExtensions.map(e => e.namespace)
  };
}

// ── Manifest generation (adcp#3725) ───────────────────────────────────────
//
// Emit a single manifest.json artifact per version that gives SDKs a
// machine-readable view of every tool, error code, and specialism — the
// metadata each SDK currently hand-rolls and drifts on.
//
// Tool name derivation: the basename `<name>-request.json` → tool name
// `<name>` with hyphens converted to underscores. The matching response
// is `<name>-response.json`; async variants follow the same prefix.
//
// Protocol derivation: the source directory name. Tools at the source
// root (none today, but reserved) are intentionally excluded — every tool
// must live under a protocol directory.
//
// `mutating`: classifyRequestMutating() — same logic the idempotency-key
// lint enforces, so manifest and lint can never disagree.
//
// `error_codes`: derived from enums/error-code.json's enum + enumMetadata
// + enumDescriptions. The lint above guarantees these are in sync.
//
// `specialisms`: derived from static/compliance/source/specialisms/*/
// index.yaml. Each specialism contributes:
//   - entry_point_tools: the curated `required_tools` from index.yaml — the
//     minimal contract the spec asserts implementers MUST ship.
//   - exercised_tools: the full set of tools called across the specialism's
//     own phases[].steps[].task plus every scenario in requires_scenarios
//     (resolved via scenario.id from the compliance source tree).
// SDKs use entry_point_tools to gate "did I declare the right specialism?"
// and exercised_tools to gate "does my agent answer every call the
// conformance kit will make?". The two sets are usually distinct;
// shipping only entry_point_tools (#3725 review feedback) was misleading.
// Inverse mapping (tool → specialisms[]) is folded back onto each tool
// based on exercised_tools, since that's the surface SDK authors care about.

// Keep this set in sync with the `protocol` enum in
// static/schemas/source/manifest.schema.json. Adding a protocol surface
// requires updating both — the script enum gates which directories are
// scanned for tools; the meta-schema enum gates which protocol values are
// valid in the emitted manifest.
const MANIFEST_PROTOCOLS = new Set([
  'media-buy', 'signals', 'governance', 'account', 'creative',
  'brand', 'content-standards', 'property', 'collection',
  'sponsored-intelligence', 'protocol', 'compliance', 'tmp', 'a2ui'
]);

// Strip the `Recovery: <verdict>(...).` sentence from an error-code
// description. The structured `recovery` and `suggestion` fields carry the
// same semantic — emitting the prose verbatim in the manifest would force
// SDKs to choose between two surfaces.
//
// Three patterns occur in the corpus:
//   1) `Recovery: <verdict>.`              — bare verdict + period
//   2) `Recovery: <verdict> (...).`         — parenthetical suggestion + period
//   3) `Recovery: <verdict> <clause>.`      — clause continuation to end of string
//
// (1) and (2) preserve any content after the Recovery sentence (e.g.
// REFERENCE_NOT_FOUND's uniform-response MUST summary that follows
// `Recovery: correctable.`). (3) only ever runs to end of string in the
// corpus; no description has additional sentences after a clause-style
// Recovery continuation.
function stripRecoveryProse(desc) {
  if (typeof desc !== 'string') return desc;
  // Patterns 1+2: verdict optionally followed by a balanced (single-level)
  // parenthetical, then a period. The parenthetical may contain dotted
  // identifiers — match `[^)]*` to consume everything up to the closing
  // paren regardless of internal periods.
  const verdictThenPeriod = /\s*Recovery:\s*(?:correctable|transient|terminal)(?:\s*\([^)]*\))?\.\s*/;
  if (verdictThenPeriod.test(desc)) {
    return desc.replace(verdictThenPeriod, ' ').replace(/\s{2,}/g, ' ').trim();
  }
  // Pattern 3: clause continuation. Strip from `Recovery:` to end of string.
  const clauseToEnd = /\s*Recovery:\s*(?:correctable|transient|terminal)\b[\s\S]+$/;
  return desc.replace(clauseToEnd, '').replace(/\s{2,}/g, ' ').trim();
}

// Build a Map<scenarioId, Set<task>> by walking the entire compliance source
// tree. Mirrors the resolution model used by lint-storyboard-branch-sets.cjs:
// a `requires_scenarios` entry names a scenario's `id` field (e.g.
// `media_buy_seller/refine_products`), and the runner finds the scenario by
// id, not by file path.
function indexScenarioTasks(repoRoot) {
  const yaml = require('js-yaml');
  const sourceRoot = path.join(repoRoot, 'static', 'compliance', 'source');
  const index = new Map();
  if (!fs.existsSync(sourceRoot)) return index;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith('.yaml')) continue;
      let doc;
      try { doc = yaml.load(fs.readFileSync(p, 'utf8')); }
      catch { continue; }
      if (!doc || typeof doc !== 'object' || typeof doc.id !== 'string') continue;
      if (!Array.isArray(doc.phases)) continue;
      index.set(doc.id, collectTasksFromPhases(doc.phases));
    }
  }
  walk(sourceRoot);
  return index;
}

// Walk a storyboard's phases and collect the tasks an agent MUST handle to
// pass conformance for that storyboard. Steps with `requires_tool: <X>` are
// conditional — the runner only executes them if the agent claims tool X —
// so they're optional surface and intentionally excluded here. Without that
// filter, optional test-harness tools (e.g. comply_test_controller, gated
// across many storyboards) would propagate to every specialism's
// exercised_tools and overstate the required surface.
function collectTasksFromPhases(phases) {
  const tasks = new Set();
  if (!Array.isArray(phases)) return tasks;
  for (const phase of phases) {
    if (!phase || !Array.isArray(phase.steps)) continue;
    for (const step of phase.steps) {
      if (!step || typeof step.task !== 'string' || step.task.length === 0) continue;
      if (step.requires_tool) continue;
      tasks.add(step.task);
    }
  }
  return tasks;
}

function loadSpecialisms(repoRoot) {
  const yaml = require('js-yaml');
  const specialismsDir = path.join(repoRoot, 'static', 'compliance', 'source', 'specialisms');
  if (!fs.existsSync(specialismsDir)) return [];

  const scenarioIndex = indexScenarioTasks(repoRoot);

  const out = [];
  for (const entry of fs.readdirSync(specialismsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(specialismsDir, entry.name, 'index.yaml');
    if (!fs.existsSync(indexPath)) continue;
    const doc = yaml.load(fs.readFileSync(indexPath, 'utf8'));
    if (!doc || typeof doc !== 'object') continue;

    const entryPointTools = Array.isArray(doc.required_tools) ? doc.required_tools : [];
    const exercised = new Set(entryPointTools);

    // Tools called directly by this specialism's own phases.
    for (const t of collectTasksFromPhases(doc.phases)) exercised.add(t);

    // Tools called by every linked scenario.
    if (Array.isArray(doc.requires_scenarios)) {
      for (const scenarioId of doc.requires_scenarios) {
        if (typeof scenarioId !== 'string') continue;
        const scenarioTasks = scenarioIndex.get(scenarioId);
        if (!scenarioTasks) {
          throw new Error(
            `Manifest generation: specialism "${doc.id || entry.name}" requires_scenarios entry ` +
            `"${scenarioId}" does not match any scenario id in the compliance source tree. ` +
            `Either fix the reference or add the missing scenario file.`
          );
        }
        for (const t of scenarioTasks) exercised.add(t);
      }
    }

    out.push({
      id: doc.id || entry.name,
      protocol: doc.protocol || null,
      title: doc.title || null,
      entry_point_tools: entryPointTools,
      exercised_tools: Array.from(exercised).sort()
    });
  }
  return out;
}

function discoverTools(sourceDir) {
  const tools = [];
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!MANIFEST_PROTOCOLS.has(entry.name)) continue;
    const protocol = entry.name;
    const protoDir = path.join(sourceDir, entry.name);
    const files = fs.readdirSync(protoDir, { withFileTypes: true });
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith('-request.json')) continue;
      // Skip embedded utility request shapes — they're not standalone tools.
      // Authors adding a new utility shape under a protocol directory MUST
      // add it to NON_OPERATION_ALLOWLIST or the manifest will emit it as
      // a tool name, which would surface in every SDK's generated client.
      if (NON_OPERATION_ALLOWLIST.has(f.name)) continue;
      const toolBase = f.name.replace(/-request\.json$/, '');
      const toolName = toolBase.replace(/-/g, '_');
      const requestPath = path.join(protoDir, f.name);
      const responseName = `${toolBase}-response.json`;
      const responsePath = path.join(protoDir, responseName);
      if (!fs.existsSync(responsePath)) {
        // A request with no matching response is a bug, not a tool — surface it.
        throw new Error(
          `Manifest generation: ${protocol}/${f.name} has no matching response schema (${responseName}). ` +
          `Either add the response file or move the request out of the protocol directory.`
        );
      }
      const mutating = classifyRequestMutating(requestPath);

      const asyncVariants = files
        .filter(g => g.isFile() && g.name.startsWith(`${toolBase}-async-response-`) && g.name.endsWith('.json'))
        .map(g => `${protocol}/${g.name}`)
        .sort();

      tools.push({
        name: toolName,
        protocol,
        mutating,
        request_schema: `${protocol}/${f.name}`,
        response_schema: `${protocol}/${responseName}`,
        async_response_schemas: asyncVariants
      });
    }
  }
  // Sort tools alphabetically by name for stable output.
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

function buildManifest(sourceDir, urlVersion, semverVersion, repoRoot) {
  // Tools.
  const tools = discoverTools(sourceDir);

  // Specialisms — and the inverse tool→specialisms[] map. The inverse uses
  // `exercised_tools` (the union of own phases + linked scenarios) because
  // that's the surface SDK authors care about: "if I'm implementing
  // sales_guaranteed, every tool the conformance kit will call".
  const specialismsRaw = loadSpecialisms(repoRoot);
  const toolToSpecialisms = new Map();
  for (const sp of specialismsRaw) {
    for (const t of sp.exercised_tools) {
      if (!toolToSpecialisms.has(t)) toolToSpecialisms.set(t, []);
      toolToSpecialisms.get(t).push(sp.id);
    }
  }
  for (const tool of tools) {
    const sp = toolToSpecialisms.get(tool.name);
    if (sp && sp.length > 0) tool.specialisms = sp.slice().sort();
  }

  // Error codes — pull from enums/error-code.json (enum + enumMetadata +
  // enumDescriptions). The lint guarantees these three are in sync; here
  // we just merge them into a per-code object for the manifest.
  //
  // The description is the enumDescriptions string with the trailing
  // `Recovery: X (suggestion)` prose stripped — that semantic now lives
  // structurally in `recovery` and `suggestion`, and we don't want SDK
  // consumers to see it twice.
  const errorCodeSchema = JSON.parse(
    fs.readFileSync(path.join(sourceDir, 'enums', 'error-code.json'), 'utf8')
  );
  const errorCodes = {};
  for (const code of errorCodeSchema.enum) {
    const meta = errorCodeSchema.enumMetadata[code];
    const desc = stripRecoveryProse(errorCodeSchema.enumDescriptions[code]);
    errorCodes[code] = {
      recovery: meta.recovery,
      description: desc,
      suggestion: meta.suggestion
    };
  }

  // Specialism block.
  const specialisms = {};
  for (const sp of specialismsRaw.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    specialisms[sp.id] = {
      protocol: sp.protocol,
      ...(sp.title ? { title: sp.title } : {}),
      entry_point_tools: sp.entry_point_tools.slice().sort(),
      exercised_tools: sp.exercised_tools.slice()
    };
  }

  // Tool block — keyed by tool name.
  const toolsObj = {};
  for (const t of tools) {
    toolsObj[t.name] = {
      protocol: t.protocol,
      mutating: t.mutating,
      request_schema: t.request_schema,
      response_schema: t.response_schema,
      async_response_schemas: t.async_response_schemas,
      ...(t.specialisms ? { specialisms: t.specialisms } : {})
    };
  }

  return {
    $schema: `/schemas/${urlVersion}/manifest.schema.json`,
    adcp_version: semverVersion,
    generated_at: new Date().toISOString(),
    tools: toolsObj,
    error_code_policy: {
      default_unknown_recovery: 'transient',
      note: "Sellers MAY return platform-specific codes that are not listed in error_codes. Agents MUST classify unknown codes as default_unknown_recovery and SHOULD retry with backoff before surfacing to the operator. Throwing on an unknown code is non-conformant client behavior."
    },
    error_codes: errorCodes,
    specialisms
  };
}

function writeManifest(sourceDir, targetDir, urlVersion, semverVersion, repoRoot) {
  const manifest = buildManifest(sourceDir, urlVersion, semverVersion, repoRoot);
  fs.writeFileSync(
    path.join(targetDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );
  const stats = {
    tools: Object.keys(manifest.tools).length,
    mutating: Object.values(manifest.tools).filter(t => t.mutating).length,
    error_codes: Object.keys(manifest.error_codes).length,
    specialisms: Object.keys(manifest.specialisms).length
  };
  return stats;
}

function copyAndTransformSchemas(sourceDir, targetDir, version) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      // Skip extensions directory - handled separately by buildExtensions()
      if (entry.name === 'extensions') {
        continue;
      }
      ensureDir(targetPath);
      copyAndTransformSchemas(sourcePath, targetPath, version);
    } else if (entry.name.endsWith('.json')) {
      let content = fs.readFileSync(sourcePath, 'utf8');

      // Update $id, $ref, and $schema fields to include version
      content = content.replace(
        /"\$id":\s*"\/schemas\//g,
        `"$id": "/schemas/${version}/`
      );
      content = content.replace(
        /"\$ref":\s*"\/schemas\//g,
        `"$ref": "/schemas/${version}/`
      );
      content = content.replace(
        /"\$schema":\s*"\/schemas\//g,
        `"$schema": "/schemas/${version}/`
      );

      // Update baseUrl and metadata in registry
      if (entry.name === 'index.json') {
        const schema = JSON.parse(content);
        schema.adcp_version = version;
        schema.lastUpdated = new Date().toISOString().split('T')[0];
        schema.baseUrl = `/schemas/${version}`;
        if (!schema.versioning) {
          schema.versioning = {};
        }
        schema.versioning.note = `AdCP uses build-time versioning. This directory contains schemas for AdCP ${version}. Full semantic versions are available at /schemas/{version}/ (e.g., /schemas/2.5.0/). Major version aliases point to the latest release: /schemas/v${getMajorVersion(version)}/ → /schemas/${version}/.`;
        content = JSON.stringify(schema, null, 2);
      }

      fs.writeFileSync(targetPath, content);
    }
  }
}

function updateSourceRegistry(version) {
  const registryPath = path.join(SOURCE_DIR, 'index.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  registry.adcp_version = version;
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log(`✏️  Updated source registry: ${registryPath}`);
}

/**
 * Find all JSON schema files in a directory (excluding index.json)
 */
function findSchemaFiles(dir, baseDir = dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSchemaFiles(fullPath, baseDir));
    } else if (entry.name.endsWith('.json') && entry.name !== 'index.json') {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Recursively resolve all $ref in a schema object
 * This is a simple implementation that handles our /schemas/ convention.
 *
 * The `ancestorRefs` parameter tracks the current resolution chain to detect
 * true circular references (A → B → A). This is different from multiple
 * references to the same schema from different locations, which should
 * all be resolved.
 */
function resolveRefs(schema, sourceDir, ancestorRefs = new Set()) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(item => resolveRefs(item, sourceDir, ancestorRefs));
  }

  const result = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('/schemas/')) {
      // Resolve the reference
      const refPath = path.join(sourceDir, value.replace('/schemas/', ''));

      // Prevent infinite recursion for true circular refs (A → B → A)
      // But allow the same schema to be referenced from different locations
      if (ancestorRefs.has(refPath)) {
        result[key] = value;  // Keep as-is for circular refs
        continue;
      }

      try {
        const refContent = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        // Create a new set including this ref for the recursive call
        const newAncestors = new Set(ancestorRefs);
        newAncestors.add(refPath);
        // Recursively resolve refs in the referenced schema
        const resolvedRef = resolveRefs(refContent, sourceDir, newAncestors);
        // Merge the resolved content (remove $id, $schema from merged content)
        const { $id, $schema, ...rest } = resolvedRef;
        Object.assign(result, rest);
      } catch (error) {
        // If we can't resolve, keep the original $ref
        result[key] = value;
      }
    } else {
      result[key] = resolveRefs(value, sourceDir, ancestorRefs);
    }
  }

  return result;
}

/**
 * Hoist nested `$defs` and `definitions` blocks to the document root.
 *
 * After `resolveRefs` inlines a referenced schema, any local pointers it
 * carried (e.g. `#/$defs/baseIndividualAsset` authored inside `format.json`)
 * land wherever the inlining landed — typically deep inside an array item.
 * The pointer is still `#/$defs/...` but the `$defs` block is no longer at
 * the document root, so draft-07 validators (Ajv) can't resolve it.
 *
 * This function moves every nested `$defs` / `definitions` block up to the
 * root, deleting it from its nested location. Identical entries across
 * copies are deduped; conflicting entries throw.
 *
 * Note: `$defs` is the draft 2019-09+ name and `definitions` is the
 * draft-07 name. Both conventions appear in our source schemas, and a
 * local `#/...` pointer targets whichever spelling the author used, so we
 * hoist each into its own root-level block (rather than merging them).
 */
function hoistNestedDefsToRoot(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  const rootDefs = { ...(schema.$defs || {}) };
  const rootDefinitions = { ...(schema.definitions || {}) };

  // Key-order-insensitive deep equality. Used to distinguish "same shape
  // authored twice" (safe to dedupe) from "two different shapes under the
  // same name" (a real conflict). A plain `JSON.stringify` comparison
  // would false-positive on identical objects authored with different
  // key order.
  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => { acc[k] = canonicalize(value[k]); return acc; }, {});
  }
  function sameDef(a, b) {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
  }

  // Reject reserved property names. Source schemas are trusted today, but
  // `JSON.parse` surfaces a literal `"__proto__"` key as an own enumerable
  // property, so a plain `target[key] = value` assignment would mutate the
  // resulting object's prototype. Defensive, not reactive.
  const RESERVED_DEF_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function mergeInto(target, key, value, originPath, blockName) {
    if (RESERVED_DEF_KEYS.has(key)) {
      throw new Error(
        `Refusing to hoist reserved key \`${blockName}.${key}\` (at ${originPath}). ` +
        `Source schemas may not use "__proto__", "constructor", or "prototype" as \`${blockName}\` entry names.`
      );
    }
    if (Object.prototype.hasOwnProperty.call(target, key) && !sameDef(target[key], value)) {
      throw new Error(
        `Conflicting \`${blockName}.${key}\` definitions encountered while hoisting nested defs (at ${originPath}). ` +
        `Two inlined schemas define different shapes under the same key.`
      );
    }
    target[key] = value;
  }

  // Assumes every `$defs` / `definitions` block encountered during the walk
  // is a JSON Schema keyword, not a property name in some schema-about-
  // schemas. True for every source schema in this repo — AdCP does not
  // author meta-schemas. Revisit if that changes: a correct disambiguation
  // would exempt the immediate child of `properties`, `patternProperties`,
  // and `dependentSchemas` from keyword treatment.
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }

    if (path !== '' && node.$defs && typeof node.$defs === 'object' && !Array.isArray(node.$defs)) {
      for (const [k, v] of Object.entries(node.$defs)) {
        mergeInto(rootDefs, k, v, `${path}.$defs.${k}`, '$defs');
      }
      delete node.$defs;
    }
    if (path !== '' && node.definitions && typeof node.definitions === 'object' && !Array.isArray(node.definitions)) {
      for (const [k, v] of Object.entries(node.definitions)) {
        mergeInto(rootDefinitions, k, v, `${path}.definitions.${k}`, 'definitions');
      }
      delete node.definitions;
    }

    for (const [k, v] of Object.entries(node)) {
      walk(v, `${path}.${k}`);
    }
  }

  walk(schema, '');

  if (Object.keys(rootDefs).length > 0) schema.$defs = rootDefs;
  if (Object.keys(rootDefinitions).length > 0) schema.definitions = rootDefinitions;

  return schema;
}

/**
 * After resolveRefs inlines every $ref, the same pure-enum schema can appear
 * at multiple paths in the bundled output. json-schema-to-typescript sees two
 * structurally identical inline shapes and emits both as Foo and Foo1, making
 * the generated type look like a versioned duplicate that doesn't exist.
 *
 * This function detects pure-enum schemas (type === 'string', has enum,
 * ≤ 4 top-level keys — allows title, description alongside type+enum) that
 * appear at 2+ distinct non-$defs locations, hoists each into root $defs, and
 * replaces every occurrence with a $ref pointer. Single-occurrence enums are
 * left inline — no change to those bundled schemas.
 *
 * Complex object schemas ($defs hoisting for objects) is intentionally out of
 * scope — see issue #3145 for the RFC on opt-in x-hoist markers.
 */
function hoistDuplicateInlineEnums(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  function isPureEnum(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    return (
      s.type === 'string' &&
      Array.isArray(s.enum) &&
      !Object.keys(s).some(k => ['properties', 'items', 'oneOf', 'anyOf', 'allOf', 'not', '$ref', 'patternProperties'].includes(k))
    );
  }

  function fingerprint(s) {
    // Preserve enum value order — order-different arrays are distinct schemas.
    // Include title so two enums with same values but different titles are NOT
    // collapsed into one $ref (would silently rename one of them).
    return JSON.stringify({ type: s.type, enum: s.enum, title: s.title || null });
  }

  // Pass 1: count occurrences of each pure-enum shape, excluding $defs blocks.
  // Check array elements directly (symmetry with Pass 2's array branch).
  const seen = new Map(); // fingerprint -> { schema, count }

  function track(s) {
    const fp = fingerprint(s);
    const entry = seen.get(fp);
    if (entry) { entry.count++; } else { seen.set(fp, { schema: s, count: 1 }); }
  }

  function collect(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isPureEnum(item)) track(item);
        collect(item);
      }
      return;
    }
    for (const [key, val] of Object.entries(node)) {
      if (key === '$defs' || key === 'definitions') continue;
      if (isPureEnum(val)) track(val);
      collect(val);
    }
  }

  collect(schema);

  // Build fingerprint → defName map for titled enums that appear 2+ times.
  // Untitled enums are left inline — we can't derive a meaningful type name
  // for them, and a generic "InlineEnumN" is worse than the status quo.
  const hoistMap = new Map();
  const usedNames = new Set(Object.keys(schema.$defs || {}));

  for (const [fp, { schema: s, count }] of seen) {
    if (count < 2 || !s.title) continue;
    let name = s.title.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
    name = name.charAt(0).toUpperCase() + name.slice(1);
    if (!name) continue; // skip titles that sanitize to empty string
    let safeName = name;
    let idx = 2;
    while (usedNames.has(safeName)) { safeName = name + idx++; }
    usedNames.add(safeName);
    hoistMap.set(fp, safeName);
  }

  if (hoistMap.size === 0) return schema;

  const rootDefs = { ...(schema.$defs || {}) };
  // Pre-populate $defs with all hoisted definitions before the replace pass.
  for (const [fp, defName] of hoistMap) {
    rootDefs[defName] = seen.get(fp).schema;
  }

  // Pass 2: replace duplicate inline occurrences with $ref pointers.
  function replace(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (isPureEnum(node[i])) {
          const fp = fingerprint(node[i]);
          if (hoistMap.has(fp)) { node[i] = { $ref: `#/$defs/${hoistMap.get(fp)}` }; continue; }
        }
        replace(node[i]);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === '$defs' || key === 'definitions') continue;
      const val = node[key];
      if (isPureEnum(val)) {
        const fp = fingerprint(val);
        if (hoistMap.has(fp)) { node[key] = { $ref: `#/$defs/${hoistMap.get(fp)}` }; continue; }
      }
      replace(val);
    }
  }

  replace(schema);
  schema.$defs = rootDefs;
  return schema;
}

/**
 * Generate bundled (dereferenced) schemas
 * These have all $ref resolved inline for tools that can't handle references
 */
async function generateBundledSchemas(sourceDir, bundledDir, version) {
  ensureDir(bundledDir);

  const schemaFiles = findSchemaFiles(sourceDir);
  let successCount = 0;
  let errorCount = 0;

  // Only bundle request/response schemas - these are the "root" schemas
  // that tools actually validate against. Core objects like product.json
  // are already embedded inside response schemas when bundled.
  const bundlePatterns = [
    /media-buy\/.*-request\.json$/,
    /media-buy\/.*-response\.json$/,
    /signals\/.*-request\.json$/,
    /signals\/.*-response\.json$/,
    /creative\/.*-request\.json$/,
    /creative\/.*-response\.json$/,
    /property\/.*-request\.json$/,
    /property\/.*-response\.json$/,
    /content-standards\/.*-request\.json$/,
    /content-standards\/.*-response\.json$/,
    /sponsored-intelligence\/.*-request\.json$/,
    /sponsored-intelligence\/.*-response\.json$/,
    /protocol\/.*-request\.json$/,
    /protocol\/.*-response\.json$/,
    /core\/tasks-.*-request\.json$/,
    /core\/tasks-.*-response\.json$/,
  ];

  for (const schemaPath of schemaFiles) {
    const relativePath = path.relative(sourceDir, schemaPath);

    // Only bundle schemas matching our patterns
    const shouldBundle = bundlePatterns.some(pattern => pattern.test(relativePath));
    if (!shouldBundle) continue;

    try {
      // Read the schema
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

      // Resolve all $refs
      const dereferenced = resolveRefs(schema, sourceDir, new Set([schemaPath]));

      // After inlining, referenced schemas that carried local `#/$defs/...`
      // pointers leave their `$defs` nested wherever they were inlined —
      // which breaks draft-07 validators that expect root-level `$defs`.
      // Hoist every nested `$defs` / `definitions` block to the root so
      // those pointers resolve. See #2648.
      hoistNestedDefsToRoot(dereferenced);

      // Hoist pure-enum schemas that were inlined 2+ times to $defs and
      // replace duplicates with $ref pointers. Eliminates the Foo / Foo1
      // numbered-suffix codegen artifact. See #3145.
      hoistDuplicateInlineEnums(dereferenced);

      // Update $id to indicate this is a bundled schema
      if (dereferenced.$id) {
        dereferenced.$id = dereferenced.$id.replace('/schemas/', `/schemas/${version}/bundled/`);
      }

      // Add metadata indicating this is bundled
      dereferenced._bundled = {
        generatedAt: new Date().toISOString(),
        note: 'This is a bundled schema with all $ref resolved inline. For the modular version with references, use the parent directory.'
      };

      // Write bundled schema
      const outputPath = path.join(bundledDir, relativePath);
      ensureDir(path.dirname(outputPath));
      fs.writeFileSync(outputPath, JSON.stringify(dereferenced, null, 2));
      successCount++;
    } catch (error) {
      console.warn(`   ⚠️  Failed to bundle ${relativePath}: ${error.message}`);
      errorCount++;
    }
  }

  return { successCount, errorCount };
}

/**
 * Copy schemas from a source directory to a skill schemas directory
 * Returns the count of files copied
 */
function copySchemaDir(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  ensureDir(targetDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  let count = 0;

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      fs.copyFileSync(sourcePath, targetPath);
      count++;
    }
  }

  return count;
}

/**
 * Generate schemas for a single skill
 * Returns the count of files copied, or 0 if source doesn't exist
 */
function generateSkillSchema(versionDir, version, protocol, skillName) {
  const sourceDir = path.join(versionDir, protocol);
  const skillDir = path.join(SKILLS_DIR, skillName, 'schemas');

  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
  ensureDir(skillDir);

  let count = copySchemaDir(sourceDir, skillDir);
  count += copySchemaDir(path.join(versionDir, 'core'), path.join(skillDir, 'core'));
  count += copySchemaDir(path.join(versionDir, 'enums'), path.join(skillDir, 'enums'));

  console.log(`📚 Generated skill schemas: skills/${skillName}/schemas/ (${count} files from ${version})`);
  return count;
}

/**
 * Generate skill schemas from versioned dist schemas
 * Copies protocol schemas to skills/{protocol}/schemas/
 */
function generateSkillSchemas(versionDir, version) {
  const skills = [
    { protocol: 'media-buy', skillName: 'adcp-media-buy' },
    { protocol: 'creative', skillName: 'adcp-creative' },
    { protocol: 'signals', skillName: 'adcp-signals' },
  ];

  let totalCount = 0;
  for (const { protocol, skillName } of skills) {
    const count = generateSkillSchema(versionDir, version, protocol, skillName);
    if (count === 0 && protocol === 'media-buy') {
      console.log(`   ⚠️  No media-buy schemas found in ${versionDir}`);
    }
    totalCount += count;
  }

  return totalCount;
}

async function main() {
  const version = getVersion();
  const majorVersion = getMajorVersion(version);
  const minorVersion = getMinorVersion(version);
  const latestReleasedVersion = findLatestReleasedVersion();

  if (isRelease) {
    console.log(`🚀 RELEASE BUILD: Creating schemas for AdCP v${version}`);
  } else {
    console.log(`📦 Development build: Updating latest/ schemas`);
  }
  console.log(`   Source: ${SOURCE_DIR}`);
  console.log(`   Target: ${DIST_DIR}`);
  if (latestReleasedVersion) {
    console.log(`   Latest released version: ${latestReleasedVersion}`);
  }
  console.log('');

  // Lint mutating request schemas before we build anything — a schema
  // that's supposed to be mutating but forgets idempotency_key is a
  // latent spec bug that silently bypasses the storyboard-level lint.
  lintMutatingRequestsRequireIdempotencyKey(SOURCE_DIR);

  // Lint vendor metric uniqueness: enforce the semantic uniqueness key
  // (vendor.domain, vendor.brand_id, metric_id) documented in
  // reporting-capabilities.json and delivery-metrics.json. JSON Schema
  // uniqueItems was deliberately omitted because BrandRef's optional
  // fields defeat deep-equal; this build-time check enforces the MUST
  // constraint on example payloads embedded in schema files. Issue #3502.
  lintVendorMetricSemanticUniqueness(SOURCE_DIR);

  // Lint error-code enumMetadata coverage: every enum value MUST have a
  // structured recovery classification, and that classification MUST agree
  // with the "Recovery: X" prose in enumDescriptions. Stops the
  // hand-transcribed-recovery drift bug (adcp#3725).
  lintErrorCodeEnumMetadata(SOURCE_DIR);

  // Update source registry version
  updateSourceRegistry(version);

  // Ensure dist directory exists
  ensureDir(DIST_DIR);

  if (isRelease) {
    // RELEASE MODE: Create a new versioned directory
    const versionDir = path.join(DIST_DIR, version);

    if (fs.existsSync(versionDir)) {
      console.log(`⚠️  Version ${version} already exists. Overwriting...`);
      fs.rmSync(versionDir, { recursive: true, force: true });
    }

    console.log(`📋 Creating release: dist/schemas/${version}/`);
    ensureDir(versionDir);
    copyAndTransformSchemas(SOURCE_DIR, versionDir, version);

    // Build extensions (auto-discovered, filtered by version)
    console.log(`🔌 Building extensions for ${version}`);
    const extResult = buildExtensions(SOURCE_DIR, versionDir, version);
    if (extResult.total === 0) {
      console.log(`   ✓ No extensions defined yet (empty registry created)`);
    } else {
      console.log(`   ✓ Included ${extResult.included}/${extResult.total} extensions: ${extResult.extensions.join(', ') || 'none'}`);
    }

    // Generate the canonical tool/error/specialism manifest (adcp#3725).
    const manifestStats = writeManifest(SOURCE_DIR, versionDir, version, version, path.join(__dirname, '..'));
    console.log(`📑 Generated manifest.json (${manifestStats.tools} tools, ${manifestStats.mutating} mutating, ${manifestStats.error_codes} error codes, ${manifestStats.specialisms} specialisms)`);

    // Generate bundled schemas for release
    const bundledDir = path.join(versionDir, 'bundled');
    console.log(`📦 Generating bundled schemas to dist/schemas/${version}/bundled/`);
    const { successCount, errorCount } = await generateBundledSchemas(SOURCE_DIR, bundledDir, version);
    console.log(`   ✓ Bundled ${successCount} schemas${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

    // Note: Version aliases (v2, v2.5, v1, latest) are handled by HTTP middleware
    // No symlinks needed - the server rewrites /schemas/v2.5/* to /schemas/2.5.1/*

    // Also update latest/ to match the release
    const latestDir = path.join(DIST_DIR, 'latest');
    if (fs.existsSync(latestDir)) {
      fs.rmSync(latestDir, { recursive: true, force: true });
    }
    console.log(`📋 Updating latest/ to match release`);
    ensureDir(latestDir);
    copyAndTransformSchemas(SOURCE_DIR, latestDir, 'latest');

    // Build extensions for latest (using full version for filtering)
    buildExtensions(SOURCE_DIR, latestDir, version);

    // Manifest for latest/.
    writeManifest(SOURCE_DIR, latestDir, 'latest', version, path.join(__dirname, '..'));

    // Generate bundled schemas for latest
    const latestBundledDir = path.join(latestDir, 'bundled');
    await generateBundledSchemas(SOURCE_DIR, latestBundledDir, 'latest');

    // Generate skill schemas from the release version
    generateSkillSchemas(versionDir, version);

    // Stage the new versioned directory for git commit
    // This is needed for the changesets workflow to include it in the version commit
    console.log(`📝 Staging dist/schemas/${version}/ for git commit`);
    try {
      execSync(`git add dist/schemas/${version}/`, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    } catch (error) {
      // Not in a git repo or git add failed - that's okay for non-CI builds
      console.log(`   (git add skipped - not in git context or git not available)`);
    }

    // Show available paths (aliases are handled by HTTP middleware)
    const latestPerMinor = getLatestPatchPerMinor();
    console.log('');
    console.log('✅ Release build complete!');
    console.log('');
    console.log('Released paths:');
    console.log(`   /schemas/${version}/          - Exact version (pin for production)`);
    console.log(`   /schemas/${version}/bundled/  - Bundled schemas (no $ref)`);
    console.log(`   /schemas/latest/           - Development (matches release)`);
    console.log('');
    console.log('Version aliases (handled by HTTP middleware):');
    console.log(`   /schemas/v${majorVersion}/              - Major alias → latest ${majorVersion}.x.x`);
    for (const [minor, patchVersion] of Object.entries(latestPerMinor)) {
      console.log(`   /schemas/v${minor}/            - Minor alias → ${patchVersion}`);
    }

  } else {
    // DEVELOPMENT MODE: Only rebuild latest/
    const latestDir = path.join(DIST_DIR, 'latest');

    // Clean and rebuild latest/ only
    if (fs.existsSync(latestDir)) {
      console.log('🧹 Cleaning existing latest/ directory...');
      fs.rmSync(latestDir, { recursive: true, force: true });
    }

    console.log(`📋 Building schemas to dist/schemas/latest/`);
    ensureDir(latestDir);
    copyAndTransformSchemas(SOURCE_DIR, latestDir, 'latest');

    // Build extensions (auto-discovered, filtered by current version)
    console.log(`🔌 Building extensions for ${version}`);
    const extResult = buildExtensions(SOURCE_DIR, latestDir, version);
    if (extResult.total === 0) {
      console.log(`   ✓ No extensions defined yet (empty registry created)`);
    } else {
      console.log(`   ✓ Included ${extResult.included}/${extResult.total} extensions: ${extResult.extensions.join(', ') || 'none'}`);
    }

    // Generate the canonical tool/error/specialism manifest (adcp#3725).
    const manifestStats = writeManifest(SOURCE_DIR, latestDir, 'latest', version, path.join(__dirname, '..'));
    console.log(`📑 Generated manifest.json (${manifestStats.tools} tools, ${manifestStats.mutating} mutating, ${manifestStats.error_codes} error codes, ${manifestStats.specialisms} specialisms)`);

    // Generate bundled schemas for latest
    const bundledDir = path.join(latestDir, 'bundled');
    console.log(`📦 Generating bundled schemas to dist/schemas/latest/bundled/`);
    const { successCount, errorCount } = await generateBundledSchemas(SOURCE_DIR, bundledDir, 'latest');
    console.log(`   ✓ Bundled ${successCount} schemas${errorCount > 0 ? ` (${errorCount} failed)` : ''}`);

    // Generate skill schemas from latest
    generateSkillSchemas(latestDir, 'latest');

    // Note: Version aliases (v2, v2.5, v1) are handled by HTTP middleware
    // No symlinks needed - the server rewrites URLs dynamically

    // Show available paths
    const latestPerMinor = getLatestPatchPerMinor();
    console.log('');
    console.log('✅ Development build complete!');
    console.log('');
    console.log('Available paths:');
    console.log(`   /schemas/latest/           - Development schemas (just rebuilt)`);
    if (latestReleasedVersion) {
      const releasedMajor = getMajorVersion(latestReleasedVersion);
      console.log(`   /schemas/${latestReleasedVersion}/          - Latest release (unchanged)`);
      console.log('');
      console.log('Version aliases (handled by HTTP middleware):');
      console.log(`   /schemas/v${releasedMajor}/              - Major alias → latest ${releasedMajor}.x.x`);
      for (const [minor, patchVersion] of Object.entries(latestPerMinor)) {
        console.log(`   /schemas/v${minor}/            - Minor alias → ${patchVersion}`);
      }
    } else {
      console.log('');
      console.log('⚠️  No released versions found. Run with --release to create one:');
      console.log('   npm run build:schemas -- --release');
    }
  }

  console.log('');
  console.log('📖 See docs/reference/versioning.mdx for guidance on which to use.');
}

module.exports = { hoistDuplicateInlineEnums };

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Build failed:', err.message);
    process.exit(1);
  });
}
