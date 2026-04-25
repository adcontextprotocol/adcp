#!/usr/bin/env node
/**
 * Storyboard sample_response schema conformance lint (issue #2823).
 *
 * For every storyboard step that declares both `response_schema_ref` AND
 * `sample_response`, validate the sample_response against the referenced JSON
 * schema. This is the response-side twin of lint-storyboard-sample-request-schema.cjs
 * (see the "future work" note at line 17 of that script).
 *
 * Coverage today: inline `sample_response` on the step only. The
 * comply_scenario-to-fixture mapping (specialism scenarios/*.yaml) is a
 * runtime runner hint, not a static fixture file — response fixtures from
 * that path are deferred. The corpus currently has sparse sample_response
 * coverage; the lint passes vacuously on day 1 and gains CI value as
 * storyboard authors add sample_response fixtures.
 *
 * What it catches (once coverage exists):
 *   - Response shape drift: fields added/removed between schema and fixture
 *   - Wrong types, enum violations, required field omissions
 *   - Stale fixtures that diverge after a schema change
 *
 * What it does not catch:
 *   - Dynamic agent responses (runtime concern, not static lint)
 *   - Semantic correctness of field values
 *   - Steps without sample_response (intentionally skipped)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const STORYBOARD_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');
const SCHEMA_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const ALLOWLIST_PATH = path.resolve(__dirname, '..', 'tests', 'storyboard-response-schema-allowlist.json');

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

let sharedAjv = null;
const validatorCache = new Map();

function getAjv() {
  if (sharedAjv) return sharedAjv;
  sharedAjv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
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
  const valid = validate(payload);
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
      const schemaRef = step.response_schema_ref;
      const sampleResponse = step.sample_response;
      if (!schemaRef || schemaRef.startsWith('$test_kit.') || !sampleResponse) continue;
      if (!sampleResponse || typeof sampleResponse !== 'object') continue;
      const result = await validateStep({ schemaRef, payload: sampleResponse });
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
    entries[key] = { schema: v.schemaRef, errors };
  }
  return entries;
}

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
      const grew = Object.keys(nextEntries).some((k) => {
        if (!(k in existingEntries)) return false;
        const cur = new Set(nextEntries[k].errors || []);
        const prev = new Set(existingEntries[k].errors || []);
        for (const fp of cur) if (!prev.has(fp)) return true;
        return false;
      });
      if (added.length > 0 || grew) {
        console.error('Refusing to grow the allowlist. Pass --allow-grow if this is intentional.');
        if (added.length > 0) {
          console.error('New entries:');
          for (const k of added) console.error(`  ${k}`);
        }
        if (grew) console.error('At least one existing entry gained a new error fingerprint.');
        process.exit(1);
      }
    }
    const doc = {
      $comment: [
        'Known storyboard sample_response schema drift. Regenerate with',
        '`node scripts/lint-storyboard-response-schema.cjs --write-allowlist`',
        'after a real fix — defaults to shrink-only.',
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
    console.log(`✅ sample_response schema lint: no new drift${suffix}`);
    process.exit(0);
  }

  if (parseErrors.length > 0) {
    console.log(`❌ sample_response schema lint: ${parseErrors.length} file(s) have YAML parse errors\n`);
    for (const p of parseErrors) console.log(`  ${path.relative(STORYBOARD_DIR, p.file)}: ${p.error}`);
  }
  if (newDrift.length > 0) {
    console.log(`\n❌ sample_response schema lint: ${newDrift.length} step(s) have new drift\n`);
    for (const v of newDrift) console.log(formatViolation(v));
  }
  if (stale.length > 0) {
    console.log(`\n❌ sample_response schema lint: ${stale.length} stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} (drift was fixed — remove from allowlist)\n`);
    for (const s of stale) console.log(`  ${s.key}`);
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  lintAll,
  lintFile,
  validateStep,
  loadSchema,
  formatViolation,
  fingerprintError,
  entryKey,
  loadAllowlist,
  reconcileAgainstAllowlist,
  violationsToAllowlist,
  sortEntries,
  STORYBOARD_DIR,
  ALLOWLIST_PATH,
};
