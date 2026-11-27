'use strict';

/**
 * The repo's Ajv configuration, as the schema tests and storyboard lints use
 * it (tests/schema-validation.test.cjs, tests/json-schema-validation.test.cjs,
 * scripts/lint-storyboard-*-schema.cjs):
 *
 *   new Ajv({ allErrors: true, strict: false, discriminator: true }) + addFormats(ajv)
 *
 * `allErrors` changes only how many errors are collected, never the verdict,
 * so verdict-only callers may turn it off for speed.
 */

const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const REPO_AJV_OPTIONS = Object.freeze({ allErrors: true, strict: false, discriminator: true });

function createAjv(overrides = {}) {
  const ajv = new Ajv({ ...REPO_AJV_OPTIONS, ...overrides });
  addFormats(ajv);
  return ajv;
}

/** Keywords Ajv registers as rules under the repo configuration. */
function ruleKeywords() {
  return Object.keys(createAjv().RULES.all);
}

module.exports = { createAjv, ruleKeywords, REPO_AJV_OPTIONS };
