#!/usr/bin/env node
/**
 * Storyboard sample_request schema conformance lint (issue #2763).
 *
 * For every storyboard step that declares a `schema_ref`, validate the step's
 * `sample_request` against the referenced JSON schema. Substitution strings
 * (`$context.*`, `$generate:*`, `$test_kit.*`) are replaced with schema-typed
 * placeholders before validation — the runtime resolves those, not the lint.
 *
 * What it catches:
 *   - Missing required fields (the #2763 `caller` gap)
 *   - Unknown properties under strict schemas
 *   - Wrong types, enum violations, shape drift between related storyboards
 *
 * What it does not catch:
 *   - Semantic correctness of resolved substitution values (runtime concern)
 *   - Response-side drift (future work; response_schema_ref pairs with fixture
 *     response shapes in specialism scenarios/*.yaml, not sample_request)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const STORYBOARD_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');
const SCHEMA_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const ALLOWLIST_PATH = path.resolve(__dirname, '..', 'tests', 'storyboard-sample-request-schema-allowlist.json');

// Two substitution dialects are live in storyboards today:
//   - $-prefix: $context.foo, $generate:uuid_v4#tag, $test_kit.schemas.primary,
//     $from_step:step_id.path
//   - Handlebars-style: {{runner.webhook_url:step_id}}, {{prior_step.id.field}}
// Both resolve to runtime-synthesized values that the lint cannot statically
// check, so leaf strings matching either form are replaced with a schema-typed
// placeholder before ajv validation.
const SUBSTITUTION_RE = /^(\$(context\.|generate:|test_kit\.|from_step:)|\{\{(runner\.|prior_step\.))/;

const schemaCache = new Map();

function schemaRefToPath(ref) {
  if (!ref) return null;
  const trimmed = ref.startsWith('/schemas/') ? ref.slice('/schemas/'.length) : ref;
  return path.join(SCHEMA_DIR, trimmed);
}

function loadSchema(ref) {
  const full = schemaRefToPath(ref);
  if (!full) return null;
  if (schemaCache.has(full)) return schemaCache.get(full);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    doc = null;
  }
  schemaCache.set(full, doc);
  return doc;
}

function walkYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(full));
    else if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve a schema node at a traversal step (e.g., one level of `properties.foo`
 * or `items`). Follows $ref once, and tries each branch of oneOf/anyOf before
 * giving up. Returns the first concrete node that has a typable shape, or null.
 *
 * When `discriminatorValue` is provided, composite branches are filtered to
 * the one whose `properties.<discriminatorKey>` const matches. Used by the
 * payload walker so that a sample_request object carrying `scope: "request"`
 * picks the matching oneOf variant for placeholder generation instead of
 * always taking branch 0.
 *
 * Important: this is used for placeholder generation only, not for ajv
 * validation. Ajv does real-branch selection against the full schema.
 */
function resolveSchemaNode(node, discriminator) {
  if (!node || typeof node !== 'object') return null;
  if (node.$ref) {
    const resolved = loadSchema(node.$ref);
    return resolveSchemaNode(resolved, discriminator);
  }
  // If the node has a concrete type or shape keywords, return it as-is.
  if (node.type || node.properties || node.items || node.enum || node.const) {
    return node;
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(node[key]) || node[key].length === 0) continue;
    const branches = node[key];
    // Discriminated union: pick the branch whose const matches the payload's
    // value for the discriminator key.
    if (discriminator) {
      for (const b of branches) {
        const r = resolveSchemaNode(b);
        const prop = r?.properties?.[discriminator.key];
        if (prop && (prop.const === discriminator.value || (Array.isArray(prop.enum) && prop.enum.includes(discriminator.value)))) {
          return r;
        }
      }
    }
    const branch = resolveSchemaNode(branches[0]);
    if (branch) return branch;
  }
  return node;
}

/**
 * Inspect a payload object and a schema for a discriminator hint. Common
 * JSON-schema idioms use a `properties.<key>.const` on each oneOf branch to
 * signal the variant; this helper surfaces (key, value) pairs so callers can
 * pass them to `resolveSchemaNode`.
 */
function discriminatorFor(payload, schema) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const branches = Array.isArray(schema?.oneOf)
    ? schema.oneOf
    : Array.isArray(schema?.anyOf)
      ? schema.anyOf
      : null;
  if (!branches) return null;
  const candidateKeys = new Set();
  for (const b of branches) {
    const r = resolveSchemaNode(b);
    if (!r?.properties) continue;
    for (const [k, v] of Object.entries(r.properties)) {
      if (typeof v?.const !== 'undefined' || Array.isArray(v?.enum)) candidateKeys.add(k);
    }
  }
  for (const k of candidateKeys) {
    if (k in payload && (typeof payload[k] === 'string' || typeof payload[k] === 'number')) {
      return { key: k, value: payload[k] };
    }
  }
  return null;
}

// UUID-v4 placeholder. 36 chars, A-Z/0-9/-, which satisfies most id and
// idempotency-key patterns in the schemas. Substitutions typically resolve
// to ids at runtime, so a UUID is a safer default than a short sentinel.
const STRING_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';

/**
 * Build a schema-typed placeholder for a substitution string. The placeholder
 * must satisfy the schema's type constraints without reproducing the business
 * semantics of the resolved value — ajv only checks shape, not meaning.
 *
 * For object-typed locations (including oneOf/anyOf variants whose first
 * branch is an object), recursively synthesize a shape-valid placeholder by
 * populating every `required` field with a type-valid placeholder. This
 * matches the runtime behavior of substitutions like `$context.first_signal_id`
 * that resolve to an object captured from a prior step's response.
 *
 * The `depth` guard prevents infinite recursion on self-referential schemas.
 */
function placeholderFor(schema, depth = 0) {
  const resolved = resolveSchemaNode(schema);
  if (!resolved) return STRING_PLACEHOLDER;
  const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
  // Prefer string since it's the most common substitution target.
  if (types.includes('string') || !resolved.type) {
    if (resolved.format === 'uri' || resolved.format === 'uri-reference') return 'https://placeholder.example';
    if (resolved.format === 'date-time') return '2026-01-01T00:00:00Z';
    if (resolved.format === 'date') return '2026-01-01';
    if (resolved.format === 'email') return 'placeholder@example.com';
    if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];
    if (typeof resolved.const !== 'undefined') return resolved.const;
    // Object variant nested inside a oneOf/anyOf at a location where the
    // author's substitution will resolve to that shape at runtime. Synthesize
    // the concrete shape instead of returning a string that fails required.
    if (!resolved.type) {
      const objectBranch = firstObjectBranch(resolved);
      if (objectBranch) return synthesizeObject(objectBranch, depth);
    }
    return STRING_PLACEHOLDER;
  }
  if (types.includes('integer')) return resolved.minimum ?? 1;
  if (types.includes('number')) return resolved.minimum ?? 0;
  if (types.includes('boolean')) return true;
  if (types.includes('array')) return [];
  if (types.includes('object')) return synthesizeObject(resolved, depth);
  if (types.includes('null')) return null;
  return STRING_PLACEHOLDER;
}

function firstObjectBranch(node) {
  for (const key of ['oneOf', 'anyOf']) {
    if (!Array.isArray(node[key])) continue;
    for (const branch of node[key]) {
      const r = resolveSchemaNode(branch);
      if (!r) continue;
      const t = Array.isArray(r.type) ? r.type : [r.type];
      if (t.includes('object') || r.properties || r.required) return r;
    }
  }
  return null;
}

function synthesizeObject(schema, depth) {
  if (depth > 4) return {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const properties = schema?.properties || {};
  const out = {};
  for (const field of required) {
    out[field] = placeholderFor(properties[field] || {}, depth + 1);
  }
  return out;
}

/**
 * Walk the payload in parallel with the schema, replacing substitution strings
 * with schema-typed placeholders. Descends into object properties, array items,
 * and follows $ref / oneOf / anyOf. Unknown property paths fall back to a
 * string placeholder — the schema validator will flag those structurally.
 */
function normalizeSubstitutions(value, schema) {
  const discriminator = discriminatorFor(value, schema);
  const resolved = resolveSchemaNode(schema, discriminator);
  if (typeof value === 'string' && SUBSTITUTION_RE.test(value)) {
    return placeholderFor(resolved);
  }
  if (Array.isArray(value)) {
    const itemSchema = resolved?.items;
    return value.map((v) => normalizeSubstitutions(v, itemSchema));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      let childSchema = null;
      if (resolved?.properties?.[k]) {
        childSchema = resolved.properties[k];
      } else if (resolved?.additionalProperties && typeof resolved.additionalProperties === 'object') {
        childSchema = resolved.additionalProperties;
      } else if (Array.isArray(resolved?.oneOf) || Array.isArray(resolved?.anyOf)) {
        // composite: try each branch for a matching property
        const branches = resolved.oneOf || resolved.anyOf;
        for (const b of branches) {
          const r = resolveSchemaNode(b);
          if (r?.properties?.[k]) {
            childSchema = r.properties[k];
            break;
          }
        }
      }
      out[k] = normalizeSubstitutions(v, childSchema);
    }
    return out;
  }
  return value;
}

// One shared ajv instance + compile cache keyed by schema_ref. Each schema
// compiles once per run; a 78-storyboard suite hit ~12s when this was
// per-step, ~2s with the cache.
let sharedAjv = null;
const validatorCache = new Map();

function getAjv() {
  if (sharedAjv) return sharedAjv;
  sharedAjv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: (uri) => {
      const resolved = loadSchema(uri);
      if (!resolved) throw new Error(`Cannot resolve $ref: ${uri}`);
      return Promise.resolve(resolved);
    },
  });
  addFormats(sharedAjv);
  return sharedAjv;
}

async function getValidator(schemaRef) {
  if (validatorCache.has(schemaRef)) return validatorCache.get(schemaRef);
  const schema = loadSchema(schemaRef);
  if (!schema) {
    validatorCache.set(schemaRef, null);
    return null;
  }
  try {
    const validate = await getAjv().compileAsync(schema);
    validatorCache.set(schemaRef, validate);
    return validate;
  } catch (err) {
    validatorCache.set(schemaRef, { compileError: err.message });
    return { compileError: err.message };
  }
}

async function validateStep({ schemaRef, payload }) {
  const schema = loadSchema(schemaRef);
  if (!schema) return { ok: true, skipped: 'schema_not_found', schemaRef };
  const validate = await getValidator(schemaRef);
  if (!validate) return { ok: true, skipped: 'schema_not_found', schemaRef };
  if (validate.compileError) return { ok: true, skipped: `compile_error: ${validate.compileError}`, schemaRef };
  const normalized = normalizeSubstitutions(payload, schema);
  const valid = validate(normalized);
  if (valid) return { ok: true };
  return {
    ok: false,
    errors: validate.errors.map((e) => ({
      path: e.instancePath || '/',
      message: e.message,
      keyword: e.keyword,
      params: e.params,
    })),
  };
}

/**
 * Detect whether a step is a negative/error-path test. These intentionally
 * send malformed payloads to verify the agent's error response, so their
 * sample_request is not expected to validate.
 *
 * Detection is structural: a step is negative if any validation asserts an
 * error code or a 4xx/5xx HTTP status. Authors can also opt out explicitly
 * with `sample_request_skip_schema: true` for cases the heuristic misses
 * (e.g., shape-agnostic transport tests).
 */
function isNegativeStep(step) {
  if (step?.sample_request_skip_schema === true) return true;
  const validations = Array.isArray(step?.validations) ? step.validations : [];
  for (const v of validations) {
    if (v?.check === 'error_code') return true;
    if (v?.check === 'http_status_in') {
      const allowed = Array.isArray(v.allowed_values) ? v.allowed_values : [];
      if (allowed.some((s) => typeof s === 'number' ? s >= 400 : /^[45]\d\d$/.test(String(s)))) return true;
    }
    if (v?.check === 'http_status' || v?.check === 'status_code') {
      const val = Number(v.value);
      if (!Number.isNaN(val) && val >= 400) return true;
    }
  }
  return false;
}

async function lintFile(file) {
  const violations = [];
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { violations, parseError: `yaml_parse: ${err.message}` };
  }
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];
  for (const phase of phases) {
    if (!phase || typeof phase !== 'object') continue;
    const phaseId = phase.id;
    if (!phaseId) continue;
    const steps = Array.isArray(phase.steps) ? phase.steps : [];
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      const stepId = step.id;
      if (!stepId) continue;
      const schemaRef = step.schema_ref;
      const sampleRequest = step.sample_request;
      // Test-kit-driven schemas resolve at runtime via test_kit.schemas.*
      // and have no static file to check against.
      if (!schemaRef || schemaRef.startsWith('$test_kit.')) continue;
      if (!sampleRequest || typeof sampleRequest !== 'object') continue;
      if (isNegativeStep(step)) continue;
      const result = await validateStep({ schemaRef, payload: sampleRequest });
      if (!result.ok) {
        violations.push({ file, phaseId, stepId, schemaRef, errors: result.errors });
      }
    }
  }
  return { violations };
}

async function lintAll() {
  const files = walkYaml(STORYBOARD_DIR);
  const violations = [];
  const parseErrors = [];
  for (const file of files) {
    const r = await lintFile(file);
    if (r.parseError) parseErrors.push({ file, error: r.parseError });
    violations.push(...r.violations);
  }
  return { violations, parseErrors };
}

function formatViolation(v) {
  const rel = path.relative(STORYBOARD_DIR, v.file);
  const head = `  ${rel} :: ${v.phaseId}/${v.stepId} (schema: ${v.schemaRef})`;
  if (v.error) return `${head}\n    ERROR: ${v.error}`;
  const errs = (v.errors || [])
    .slice(0, 5)
    .map((e) => `    ${e.path || '/'} [${e.keyword}] ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`)
    .join('\n');
  const more = v.errors && v.errors.length > 5 ? `\n    … and ${v.errors.length - 5} more` : '';
  return `${head}\n${errs}${more}`;
}

/**
 * Compact fingerprint for a single ajv error. Two errors on the same step
 * fingerprint identically iff they describe the same failure class at the
 * same path. Keep this stable — changing the format invalidates every
 * allowlist entry at once. Expect an ajv major-version bump to require a
 * one-off allowlist regeneration via `--write-allowlist` if param shapes
 * change.
 */
function serializeDetail(v) {
  if (v === null || typeof v !== 'object') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '<unserializable>';
  }
}

function fingerprintError(err) {
  const path_ = err.path || '/';
  const kw = err.keyword;
  let detail = '';
  if (err.params && typeof err.params === 'object') {
    if (err.params.missingProperty) detail = `:${err.params.missingProperty}`;
    else if (err.params.additionalProperty) detail = `:${err.params.additionalProperty}`;
    else if (typeof err.params.allowedValue !== 'undefined') detail = `:${serializeDetail(err.params.allowedValue)}`;
    else if (typeof err.params.type !== 'undefined') detail = `:${err.params.type}`;
    else if (typeof err.params.format !== 'undefined') detail = `:${err.params.format}`;
    else if (typeof err.params.limit !== 'undefined') detail = `:${err.params.limit}`;
  }
  return `${kw}@${path_}${detail}`;
}

function entryKey(file, phaseId, stepId) {
  const rel = path.relative(STORYBOARD_DIR, file);
  return `${rel}#${phaseId}/${stepId}`;
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return { entries: {} };
  try {
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse allowlist at ${ALLOWLIST_PATH}: ${err.message}`);
  }
}

/**
 * Split a list of violations against an allowlist into three buckets:
 *   - newDrift: violations not covered by any allowlist entry, or errors
 *     within a covered step that weren't fingerprinted at allowlist time.
 *   - stale: allowlist entries whose recorded errors no longer appear
 *     (either the step was fixed, or the error pattern changed).
 *   - grandfathered: violations fully covered by the allowlist.
 *
 * New drift and stale entries both fail the lint. Grandfathered entries
 * pass silently — the goal is to let the ratchet tighten over time without
 * blocking unrelated work behind a 46-fixture rewrite.
 */
function reconcileAgainstAllowlist(violations, allowlist) {
  const entries = allowlist.entries || {};
  const seen = new Set();
  const newDrift = [];
  const grandfathered = [];
  for (const v of violations) {
    const key = entryKey(v.file, v.phaseId, v.stepId);
    const entry = entries[key];
    if (!entry) {
      newDrift.push(v);
      continue;
    }
    seen.add(key);
    const allowed = new Set(entry.errors || []);
    const current = (v.errors || []).map(fingerprintError);
    const unexpected = current.filter((fp) => !allowed.has(fp));
    if (unexpected.length > 0) {
      newDrift.push({
        ...v,
        errors: (v.errors || []).filter((e) => !allowed.has(fingerprintError(e))),
      });
    } else {
      grandfathered.push(v);
    }
  }
  const stale = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (seen.has(key)) continue;
    stale.push({ key, entry });
  }
  return { newDrift, stale, grandfathered };
}

function violationsToAllowlist(violations) {
  const entries = {};
  for (const v of violations) {
    const key = entryKey(v.file, v.phaseId, v.stepId);
    const errors = (v.errors || []).map(fingerprintError);
    entries[key] = {
      schema: v.schemaRef,
      errors,
    };
  }
  return entries;
}

// Alphabetize keys so regenerations produce diff-friendly output regardless of
// filesystem order or how the walker happened to traverse the tree.
function sortEntries(entries) {
  const out = {};
  for (const k of Object.keys(entries).sort()) out[k] = entries[k];
  return out;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const { violations, parseErrors } = await lintAll();

  if (args.has('--write-allowlist')) {
    if (parseErrors.length > 0) {
      console.error(`Refusing to regenerate allowlist while ${parseErrors.length} file(s) have YAML parse errors — fix those first:`);
      for (const p of parseErrors) console.error(`  ${path.relative(STORYBOARD_DIR, p.file)}: ${p.error}`);
      process.exit(1);
    }
    const existing = loadAllowlist();
    const nextEntries = violationsToAllowlist(violations);
    const existingEntries = existing.entries || {};
    if (!args.has('--allow-grow')) {
      const added = Object.keys(nextEntries).filter((k) => !(k in existingEntries));
      const grew = added.length > 0;
      const grewExisting = Object.keys(nextEntries).some((k) => {
        if (!(k in existingEntries)) return false;
        const cur = new Set(nextEntries[k].errors || []);
        const prev = new Set(existingEntries[k].errors || []);
        for (const fp of cur) if (!prev.has(fp)) return true;
        return false;
      });
      if (grew || grewExisting) {
        console.error('Refusing to grow the allowlist. Pass --allow-grow if this is intentional.');
        if (added.length > 0) {
          console.error('New entries:');
          for (const k of added) console.error(`  ${k}`);
        }
        if (grewExisting) console.error('At least one existing entry gained a new error fingerprint.');
        process.exit(1);
      }
    }
    const doc = {
      $comment: [
        'Known storyboard sample_request schema drift, grandfathered before the lint',
        'was turned on. Each entry fingerprints the violation; new drift in a listed',
        'step fails the lint, and fixed drift that leaves an entry stale also fails',
        '(so follow-up PRs must remove entries as they fix fixtures). Regenerate',
        'with `node scripts/lint-storyboard-sample-request-schema.cjs --write-allowlist`',
        'after a real fix — defaults to shrink-only. Pass `--allow-grow` only when',
        'adding a deliberate, newly-identified drift is the explicit intent; never',
        'hand-edit to silence a new violation.',
      ].join(' '),
      entries: sortEntries(nextEntries),
    };
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(doc, null, 2) + '\n');
    console.log(`Wrote ${Object.keys(nextEntries).length} entries to ${path.relative(process.cwd(), ALLOWLIST_PATH)}`);
    process.exit(0);
  }

  const allowlist = loadAllowlist();
  const { newDrift, stale, grandfathered } = reconcileAgainstAllowlist(violations, allowlist);

  const hasFailure = newDrift.length > 0 || stale.length > 0 || parseErrors.length > 0;
  if (!hasFailure) {
    const suffix = grandfathered.length > 0 ? ` (${grandfathered.length} grandfathered)` : '';
    console.log(`✅ sample_request schema lint: no new drift${suffix}`);
    process.exit(0);
  }

  if (parseErrors.length > 0) {
    console.log(`❌ sample_request schema lint: ${parseErrors.length} file(s) have YAML parse errors\n`);
    for (const p of parseErrors) console.log(`  ${path.relative(STORYBOARD_DIR, p.file)}: ${p.error}`);
  }
  if (newDrift.length > 0) {
    console.log(`\n❌ sample_request schema lint: ${newDrift.length} step(s) have new drift\n`);
    for (const v of newDrift) console.log(formatViolation(v));
  }
  if (stale.length > 0) {
    console.log(`\n❌ sample_request schema lint: ${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} (drift was fixed — remove from allowlist)\n`);
    for (const s of stale) console.log(`  ${s.key}`);
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  lintAll,
  lintFile,
  validateStep,
  normalizeSubstitutions,
  loadSchema,
  formatViolation,
  fingerprintError,
  entryKey,
  loadAllowlist,
  reconcileAgainstAllowlist,
  violationsToAllowlist,
  sortEntries,
  isNegativeStep,
  resolveSchemaNode,
  discriminatorFor,
  placeholderFor,
  STORYBOARD_DIR,
  ALLOWLIST_PATH,
};
