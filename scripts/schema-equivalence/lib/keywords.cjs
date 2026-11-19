'use strict';

/**
 * Keyword classes for JSON Schema draft-07 as the repo's Ajv configuration
 * evaluates it: `new Ajv({ allErrors: true, strict: false, discriminator: true })`
 * plus `addFormats(ajv)`.
 *
 * - Assertion keywords change which payloads validate. They are kept.
 * - STRIP keywords are annotations the canonical form drops without a report.
 * - Everything else (`default`, `x-*`, and keywords Ajv ignores under
 *   `strict: false`, such as `enumDescriptions` or `contentMediaType`) is
 *   reported in the informational channel and never affects the verdict.
 */

// Keywords whose value is one subschema.
const SINGLE = new Set([
  'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else',
]);
// Keywords whose value is a name -> subschema map.
const MAP = new Set(['properties', 'patternProperties']);
// Keywords whose value is a list of subschemas with set semantics.
const UNION = new Set(['anyOf', 'oneOf']);
// Keywords whose value is plain JSON data.
const VALUE = new Set([
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxProperties',
  'minProperties', 'required', 'format', 'discriminator', 'nullable',
  // ajv-formats registers these with addFormats(ajv).
  'formatMaximum', 'formatMinimum', 'formatExclusiveMaximum', 'formatExclusiveMinimum',
]);
// `items`, `dependencies`, `allOf`, and `$ref` get dedicated handling.
const STRUCTURAL = new Set(['items', 'dependencies', 'allOf', '$ref']);

const STRIP = new Set([
  'title', 'description', 'examples', '$comment', '$id', '$schema', 'definitions', '$defs',
  'deprecated', 'readOnly', 'writeOnly',
]);

// A subschema keyword whose `true` value is the same as leaving it out.
const TRUE_IS_ABSENT = new Set(['additionalItems', 'additionalProperties', 'propertyNames', 'then', 'else', 'items']);

// Rules Ajv registers that do not assert anything.
const AJV_NON_ASSERTING = new Set(['$comment', 'id']);

/**
 * Fails when Ajv evaluates a keyword this module does not classify as an
 * assertion, so an Ajv upgrade cannot silently turn a keyword into noise.
 */
function assertCoversAjv(ajvRules) {
  const missing = ajvRules.filter(k => !AJV_NON_ASSERTING.has(k) && !isAssertion(k));
  if (missing.length) throw new Error(`Ajv evaluates keywords the canonical form does not classify: ${missing.join(', ')}`);
}

function isAssertion(key) {
  return SINGLE.has(key) || MAP.has(key) || UNION.has(key) || VALUE.has(key) || STRUCTURAL.has(key);
}

function isInfo(key) {
  return !isAssertion(key) && !STRIP.has(key);
}

module.exports = { SINGLE, MAP, UNION, VALUE, STRUCTURAL, STRIP, TRUE_IS_ABSENT, AJV_NON_ASSERTING, isAssertion, isInfo, assertCoversAjv };
