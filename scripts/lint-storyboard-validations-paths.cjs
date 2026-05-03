#!/usr/bin/env node
/**
 * Validate every storyboard step's `validations[].path` resolves to a field
 * defined by its `response_schema_ref`. Companion to
 * `lint-storyboard-context-output-paths.cjs` — that one catches captures
 * from undefined paths; this one catches assertions on undefined paths.
 *
 * Per #3918 follow-up: a `check: field_present, path: "media_buy_oid"`
 * (typo) silently passes against any conformant agent that returns the
 * actual `media_buy_id` — the storyboard nominally asserts something but
 * the assertion's target doesn't exist.
 *
 * Coverage: every step under `static/compliance/source/` that declares
 * `response_schema_ref` and has at least one `validations[]` entry whose
 * `check` is a path-bearing form. Path-bearing checks are:
 *   - field_present
 *   - field_value
 *   - field_value_or_absent
 *   - field_absent
 *
 * Non-path-bearing checks (error_code, response_schema, http_status_in,
 * http_status, any_of, on_401_require_header) are skipped — they don't
 * carry a path to validate.
 *
 * Rule:
 *   path_not_in_schema — `path` does not resolve to any defined property
 *                        in the response schema (after $ref / oneOf / anyOf
 *                        resolution and numeric-index descent into items).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const STORYBOARD_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');
const SCHEMA_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const ALLOWLIST_PATH = path.join(__dirname, 'storyboard-validations-paths-allowlist.json');

const PATH_BEARING_CHECKS = new Set([
  'field_present',
  'field_value',
  'field_value_or_absent',
  'field_absent',
]);

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return [];
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  return Array.isArray(doc.allowlist) ? doc.allowlist : [];
}

function isAllowlisted(allowlist, filePath, stepId, validationPath) {
  const rel = path.relative(path.resolve(__dirname, '..'), filePath);
  return allowlist.some(
    (entry) =>
      entry.file === rel &&
      entry.step === stepId &&
      entry.path === validationPath,
  );
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

function parsePath(raw) {
  if (!raw) return [];
  return raw.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

function schemaRefToPath(ref) {
  if (!ref) return null;
  const trimmed = ref.startsWith('/schemas/') ? ref.slice('/schemas/'.length) : ref;
  return path.join(SCHEMA_DIR, trimmed);
}

const schemaCache = new Map();

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

/**
 * A node is a "pure extension point" when it declares `additionalProperties:
 * true` AND has no `properties` / `items` / composite variants. Examples:
 * `core/context.json` (opaque correlation data, by spec design) and
 * `error.details` (additionalProperties: true because the structured shape
 * lives in per-error-code `error-details/<code>.json` schemas selected at
 * runtime). Once we descend into one of these, any remaining path segments
 * are accepted — the spec deliberately does not constrain what lives below.
 *
 * Mixed schemas (declared `properties` AND `additionalProperties: true`) are
 * NOT pure extension points — those use `additionalProperties: true` for
 * forward-compat extension, not as an open container, so paths through them
 * MUST hit defined properties.
 */
function isPureExtensionPoint(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.additionalProperties !== true) return false;
  if (node.properties && Object.keys(node.properties).length > 0) return false;
  if (node.items) return false;
  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf) || Array.isArray(node.allOf)) return false;
  return true;
}

function pathResolves(node, segments, seen = new Set()) {
  if (!node || typeof node !== 'object') return false;
  if (segments.length === 0) return true;

  if (node.$ref) {
    if (seen.has(node.$ref)) return false;
    const next = new Set(seen);
    next.add(node.$ref);
    const resolved = loadSchema(node.$ref);
    return pathResolves(resolved, segments, next);
  }

  const [seg, ...rest] = segments;

  if (/^\d+$/.test(seg)) {
    if (node.items && pathResolves(node.items, rest, seen)) return true;
  } else if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, seg)) {
    if (pathResolves(node.properties[seg], rest, seen)) return true;
  }

  // Union semantics across `oneOf` / `anyOf` / `allOf` — see
  // lint-storyboard-context-output-paths.cjs for the rationale.
  const variants = node.oneOf || node.anyOf || node.allOf;
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (pathResolves(variant, segments, seen)) return true;
    }
  }

  if (isPureExtensionPoint(node)) return true;

  return false;
}

function* findStepsWithValidations(node, trail) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* findStepsWithValidations(node[i], [...trail, i]);
    }
    return;
  }
  if (node && typeof node === 'object') {
    if (
      typeof node.response_schema_ref === 'string' &&
      Array.isArray(node.validations) &&
      node.validations.length > 0
    ) {
      yield {
        responseRef: node.response_schema_ref,
        validations: node.validations,
        stepId: typeof node.id === 'string' ? node.id : null,
        trail: [...trail],
      };
    }
    for (const key of Object.keys(node)) {
      yield* findStepsWithValidations(node[key], [...trail, key]);
    }
  }
}

function lintDoc(doc, filePath, allowlist = []) {
  const violations = [];
  if (!doc) return violations;
  for (const step of findStepsWithValidations(doc, [])) {
    const schema = loadSchema(step.responseRef);
    if (!schema) {
      violations.push({
        rule: 'response_schema_not_found',
        filePath,
        stepId: step.stepId,
        responseRef: step.responseRef,
      });
      continue;
    }
    for (let i = 0; i < step.validations.length; i++) {
      const v = step.validations[i];
      if (!v || typeof v !== 'object') continue;
      if (!PATH_BEARING_CHECKS.has(v.check)) continue;
      const rawPath = v.path;
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
      const segments = parsePath(rawPath);
      if (pathResolves(schema, segments)) continue;
      if (isAllowlisted(allowlist, filePath, step.stepId, rawPath)) continue;
      violations.push({
        rule: 'path_not_in_schema',
        filePath,
        stepId: step.stepId,
        responseRef: step.responseRef,
        validationPath: rawPath,
        check: v.check,
        index: i,
      });
    }
  }
  return violations;
}

function lint() {
  const violations = [];
  const files = walkYaml(STORYBOARD_DIR);
  const allowlist = loadAllowlist();
  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      // YAML parse errors are surfaced by sibling lints; skip rather than
      // double-report.
      continue;
    }
    violations.push(...lintDoc(doc, file, allowlist));
  }
  return violations;
}

const RULE_MESSAGES = {
  path_not_in_schema: ({ validationPath, responseRef, check }) =>
    `validations[].path \`${validationPath}\` (check: \`${check}\`) does not resolve to any defined ` +
    `field in \`${responseRef}\`. The storyboard asserts on a path the spec schema does not define — ` +
    'a real agent\'s response will silently pass `field_absent` and silently fail `field_present` / ' +
    '`field_value` / `field_value_or_absent` regardless of what the agent actually returns.\n' +
    '    Fix one of:\n' +
    '      1. Update the path to a field that exists in the response schema.\n' +
    '      2. Update the response_schema_ref to the schema that defines this path.\n' +
    '      3. If the path traverses a documented extension point (error.details polymorphism, ' +
    'additionalProperties: true convention), add an entry to ' +
    '`scripts/storyboard-validations-paths-allowlist.json` with a `reason` string.',
  response_schema_not_found: ({ responseRef }) =>
    `response_schema_ref \`${responseRef}\` could not be loaded — fix the ref or the schema path.`,
};

function formatMessage(violation) {
  const builder = RULE_MESSAGES[violation.rule];
  return builder ? builder(violation) : `unknown rule ${violation.rule}`;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    const fileCount = walkYaml(STORYBOARD_DIR).length;
    console.log(`  storyboard validations path lint: clean (${fileCount} storyboard files scanned)`);
    return;
  }
  for (const v of violations) {
    const rel = path.relative(path.resolve(__dirname, '..'), v.filePath);
    const stepLabel = v.stepId ? `:${v.stepId}` : '';
    console.error(`  error: ${rel}${stepLabel} — ${formatMessage(v)}`);
  }
  console.error(`\n  ${violations.length} storyboard validations path violation(s).`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  PATH_BEARING_CHECKS,
  lint,
  lintDoc,
  loadSchema,
  loadAllowlist,
  pathResolves,
  parsePath,
  formatMessage,
};
