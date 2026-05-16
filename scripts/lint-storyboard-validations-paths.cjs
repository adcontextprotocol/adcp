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
 * `core/protocol-envelope.json` defines the fields wrapping every task
 * response — `status`, `task_id`, `context_id`, `replayed`, `adcp_error`,
 * `governance_context`, `push_notification_config`, etc. The envelope's
 * top-level description explicitly states "Task response schemas should
 * NOT include these fields - they are protocol-level concerns," so they
 * never appear in the per-task response schemas this lint walks.
 *
 * Storyboards do assert on envelope fields (e.g., `path: "replayed"`,
 * `path: "adcp_error"`), so the resolver falls back to the envelope when
 * a top-level segment isn't found in the response schema. Only the FIRST
 * segment is matched against the envelope — once we descend into an
 * envelope property, further resolution proceeds normally.
 */
const ENVELOPE_REF = 'core/protocol-envelope.json';

function isEnvelopeProperty(name) {
  const envelope = loadSchema(ENVELOPE_REF);
  if (!envelope || !envelope.properties) return false;
  return Object.prototype.hasOwnProperty.call(envelope.properties, name);
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
        expectedArm: typeof node.expected_arm === 'string' ? node.expected_arm : null,
        expectError: node.expect_error === true,
        trail: [...trail],
      };
    }
    for (const key of Object.keys(node)) {
      yield* findStepsWithValidations(node[key], [...trail, key]);
    }
  }
}

/**
 * Walk a node's `oneOf` / `anyOf` (after $ref / allOf flattening) looking
 * for the variant whose discriminator matches `expectedArm`. The match rule:
 * any property in that variant declares `const: "<expectedArm>"`. Returns
 * the matching variant, or null when no variant matches (an authoring bug
 * the lint surfaces as `unknown_expected_arm`).
 */
function findArmByDiscriminator(node, expectedArm, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (node.$ref) {
    if (seen.has(node.$ref)) return null;
    const next = new Set(seen);
    next.add(node.$ref);
    return findArmByDiscriminator(loadSchema(node.$ref), expectedArm, next);
  }
  const variants = node.oneOf || node.anyOf;
  if (!Array.isArray(variants)) return null;
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') continue;
    const props = variant.properties || {};
    for (const propName of Object.keys(props)) {
      const propSchema = props[propName];
      if (propSchema && propSchema.const === expectedArm) {
        return variant;
      }
    }
  }
  return null;
}

/**
 * Find the response schema's "Error arm" — the oneOf branch whose `required`
 * list includes `errors` and which has no const discriminator (so it isn't
 * already const-tagged with a status value). Used as a fallback when a step
 * has `expect_error: true` but no explicit `expected_arm`.
 */
function findErrorArm(node, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (node.$ref) {
    if (seen.has(node.$ref)) return null;
    const next = new Set(seen);
    next.add(node.$ref);
    return findErrorArm(loadSchema(node.$ref), next);
  }
  const variants = node.oneOf || node.anyOf;
  if (!Array.isArray(variants)) return null;
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object') continue;
    const required = Array.isArray(variant.required) ? variant.required : [];
    if (!required.includes('errors')) continue;
    const props = variant.properties || {};
    let hasConstDiscriminator = false;
    for (const propName of Object.keys(props)) {
      if (props[propName] && props[propName].const !== undefined) {
        hasConstDiscriminator = true;
        break;
      }
    }
    if (!hasConstDiscriminator) return variant;
  }
  return null;
}

/**
 * Resolve which schema node the lint should validate paths against, given
 * the step's `expected_arm` and `expect_error` annotations. Returns either:
 *   { schema: <node> } — proceed normally with this schema (full or arm-restricted)
 *   { error: 'unknown_expected_arm' } — author named an arm that doesn't exist
 */
function resolveExpectedArmSchema(schema, expectedArm, expectError) {
  if (typeof expectedArm === 'string' && expectedArm.length > 0) {
    const arm = findArmByDiscriminator(schema, expectedArm);
    if (!arm) return { error: 'unknown_expected_arm' };
    return { schema: arm };
  }
  if (expectError) {
    const arm = findErrorArm(schema);
    if (arm) return { schema: arm };
  }
  return { schema };
}

function pathResolvesAgainstResponseOrEnvelope(schema, segments) {
  if (pathResolves(schema, segments)) return true;
  // Fall back to the protocol envelope. Storyboards address envelope-level
  // fields with bare top-level names (e.g., `replayed`, `adcp_error`,
  // `status`), so we only consult the envelope when the FIRST segment
  // matches an envelope property; subsequent segments resolve through
  // the envelope's own definition of that field.
  if (segments.length > 0 && isEnvelopeProperty(segments[0])) {
    const envelope = loadSchema(ENVELOPE_REF);
    if (envelope && pathResolves(envelope, segments)) return true;
  }
  return false;
}

function lintDoc(doc, filePath, allowlist = []) {
  const violations = [];
  if (!doc) return violations;
  for (const step of findStepsWithValidations(doc, [])) {
    const fullSchema = loadSchema(step.responseRef);
    if (!fullSchema) {
      violations.push({
        rule: 'response_schema_not_found',
        filePath,
        stepId: step.stepId,
        responseRef: step.responseRef,
      });
      continue;
    }
    const armResult = resolveExpectedArmSchema(fullSchema, step.expectedArm, step.expectError);
    if (armResult.error === 'unknown_expected_arm') {
      violations.push({
        rule: 'unknown_expected_arm',
        filePath,
        stepId: step.stepId,
        responseRef: step.responseRef,
        expectedArm: step.expectedArm,
      });
      continue;
    }
    const schema = armResult.schema;
    for (let i = 0; i < step.validations.length; i++) {
      const v = step.validations[i];
      if (!v || typeof v !== 'object') continue;
      if (!PATH_BEARING_CHECKS.has(v.check)) continue;
      const rawPath = v.path;
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
      const segments = parsePath(rawPath);
      if (pathResolvesAgainstResponseOrEnvelope(schema, segments)) continue;
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
  unknown_expected_arm: ({ expectedArm, responseRef }) =>
    `expected_arm \`${expectedArm}\` does not match any oneOf/anyOf branch in \`${responseRef}\`. ` +
    'Match rule: a branch must declare some property with `const: "<expected_arm>"`. ' +
    'Verify the discriminator value against the response schema.',
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
  ENVELOPE_REF,
  lint,
  lintDoc,
  loadSchema,
  loadAllowlist,
  isEnvelopeProperty,
  pathResolves,
  pathResolvesAgainstResponseOrEnvelope,
  findArmByDiscriminator,
  findErrorArm,
  resolveExpectedArmSchema,
  parsePath,
  formatMessage,
};
