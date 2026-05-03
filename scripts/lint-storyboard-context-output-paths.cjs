#!/usr/bin/env node
/**
 * Validate every storyboard step's `context_outputs[].path` resolves to a
 * field defined by its `response_schema_ref`. Catches the class of bug where
 * a storyboard captures `rights[0].rights_id` from a response whose schema
 * has no `rights` property — the path is wishful and a real agent's response
 * silently misses the capture.
 *
 * Per #3918: storyboard-author drift between assertion and spec is a class
 * we want to catch at build time, not at adopter-validation time.
 *
 * Coverage: every step under static/compliance/source/ that declares both
 * `response_schema_ref` and `context_outputs[]`. Scope intentionally narrow —
 * `validations[].path` is a separate generalisation tracked elsewhere.
 *
 * Rule:
 *   path_not_in_schema — `path` does not resolve to any defined property in
 *                        the response schema (after $ref / oneOf / anyOf
 *                        resolution and numeric-index descent into items).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const STORYBOARD_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');
const SCHEMA_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const ALLOWLIST_PATH = path.join(__dirname, 'storyboard-context-output-paths-allowlist.json');

/**
 * The allowlist exists for legitimate captures the static lint can't verify
 * against the spec schema alone — most commonly paths through error.details
 * (polymorphic extension keyed on error.code, see error-handling.mdx) and
 * runtime-convention echoes the spec leaves to additionalProperties: true.
 * Each entry MUST carry a `reason` explaining why the lint can't verify the
 * path; review during spec changes.
 */
function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return [];
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  return Array.isArray(doc.allowlist) ? doc.allowlist : [];
}

function isAllowlisted(allowlist, filePath, stepId, contextPath) {
  const rel = path.relative(path.resolve(__dirname, '..'), filePath);
  return allowlist.some(
    (entry) =>
      entry.file === rel &&
      entry.step === stepId &&
      entry.path === contextPath,
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
 *
 * Mirrors the rule in `lint-storyboard-validations-paths.cjs`.
 */
function isPureExtensionPoint(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.additionalProperties !== true) return false;
  if (node.properties && Object.keys(node.properties).length > 0) return false;
  if (node.items) return false;
  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf) || Array.isArray(node.allOf)) return false;
  return true;
}

/**
 * Walk a JSON Schema node to determine whether a dotted path resolves to
 * any defined element. Follows `$ref`, descends through `properties.<name>`
 * for object steps and `items` for numeric-index steps, and accepts any
 * variant of `oneOf` / `anyOf` / `allOf` that resolves. Returns true when
 * EVERY segment was either resolved by a defined property/items, accepted
 * by at least one composite variant, or descended into a pure extension
 * point (e.g., `core/context.json`, `error.details`).
 *
 * Empty path resolves trivially (the root itself exists).
 */
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

  // Numeric — array index. Only valid when this node has `items`.
  if (/^\d+$/.test(seg)) {
    if (node.items && pathResolves(node.items, rest, seen)) return true;
  } else if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, seg)) {
    if (pathResolves(node.properties[seg], rest, seen)) return true;
  }

  // Composite variants — any variant that resolves the FULL remaining path
  // (starting from the current segment, since composites apply at this node).
  // Union-of-branches is correct for `oneOf`/`anyOf` (the resolved instance
  // matches one variant, and is a path-existence question) AND for `allOf`
  // (intersection of constraints means the resolved object carries the union
  // of properties across branches — a property defined in any branch is
  // present after merging).
  const variants = node.oneOf || node.anyOf || node.allOf;
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (pathResolves(variant, segments, seen)) return true;
    }
  }

  if (isPureExtensionPoint(node)) return true;

  return false;
}

function* findContextOutputSteps(node, trail) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      yield* findContextOutputSteps(node[i], [...trail, i]);
    }
    return;
  }
  if (node && typeof node === 'object') {
    if (
      typeof node.response_schema_ref === 'string' &&
      Array.isArray(node.context_outputs) &&
      node.context_outputs.length > 0
    ) {
      yield {
        responseRef: node.response_schema_ref,
        contextOutputs: node.context_outputs,
        stepId: typeof node.id === 'string' ? node.id : null,
        expectedArm: typeof node.expected_arm === 'string' ? node.expected_arm : null,
        expectError: node.expect_error === true,
        trail: [...trail],
      };
    }
    for (const key of Object.keys(node)) {
      yield* findContextOutputSteps(node[key], [...trail, key]);
    }
  }
}

/**
 * Mirrors `findArmByDiscriminator` in lint-storyboard-validations-paths.cjs.
 * See that file for the full design rationale of `expected_arm` annotations.
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

/** Mirrors `findErrorArm` in lint-storyboard-validations-paths.cjs. */
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

/** Mirrors `resolveExpectedArmSchema` in lint-storyboard-validations-paths.cjs. */
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

function lintDoc(doc, filePath, allowlist = []) {
  const violations = [];
  if (!doc) return violations;
  for (const step of findContextOutputSteps(doc, [])) {
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
    for (let i = 0; i < step.contextOutputs.length; i++) {
      const out = step.contextOutputs[i];
      const rawPath = out?.path;
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
      const segments = parsePath(rawPath);
      if (pathResolves(schema, segments)) continue;
      if (isAllowlisted(allowlist, filePath, step.stepId, rawPath)) continue;
      violations.push({
        rule: 'path_not_in_schema',
        filePath,
        stepId: step.stepId,
        responseRef: step.responseRef,
        contextPath: rawPath,
        captureName: out?.key || out?.name || null,
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
      // YAML parse errors are surfaced by sibling lints
      // (lint-storyboard-response-schema, etc.); skip rather than double-report.
      continue;
    }
    violations.push(...lintDoc(doc, file, allowlist));
  }
  return violations;
}

const RULE_MESSAGES = {
  path_not_in_schema: ({ contextPath, responseRef, captureName }) => {
    const name = captureName ? ` (capture: \`${captureName}\`)` : '';
    return (
      `context_outputs path \`${contextPath}\`${name} does not resolve to any defined ` +
      `field in \`${responseRef}\`. The storyboard captures from a path the spec ` +
      'schema does not define — a real agent response will silently miss this capture, ' +
      'and downstream `$context.<name>` consumers will see undefined values.\n' +
      '    Fix one of:\n' +
      '      1. Update the path to a field that exists in the response schema.\n' +
      '      2. Update the response_schema_ref to the schema that defines this path.\n' +
      '      3. If the path is conditional (e.g., only present on a discriminated arm), ' +
      'use a path that resolves through that arm\'s defined properties.'
    );
  },
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
    console.log(`  storyboard context-output path lint: clean (${fileCount} storyboard files scanned)`);
    return;
  }
  for (const v of violations) {
    const rel = path.relative(path.resolve(__dirname, '..'), v.filePath);
    const stepLabel = v.stepId ? `:${v.stepId}` : '';
    console.error(`  error: ${rel}${stepLabel} — ${formatMessage(v)}`);
  }
  console.error(`\n  ${violations.length} storyboard context_outputs path violation(s).`);
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  lint,
  lintDoc,
  loadSchema,
  loadAllowlist,
  pathResolves,
  findArmByDiscriminator,
  findErrorArm,
  resolveExpectedArmSchema,
  parsePath,
  formatMessage,
};
