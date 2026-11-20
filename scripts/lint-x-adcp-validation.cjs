#!/usr/bin/env node
/**
 * x-adcp-validation lint: every annotation uses the documented vocabulary
 * (#8472).
 *
 * scripts/x-adcp-validation.schema.json is the vocabulary as a meta-schema:
 * the core sub-keys docs/reference/schema-extensions.mdx documents, each with
 * its shape, plus extension terms `{domain}:{key}`. verifier_constraints
 * stays a free-form map for one-off rules. Each x-adcp-validation object on a
 * subschema is validated against it.
 *
 * Rules (one finding per annotation and key):
 *
 *   unknown-key        a key that is neither a core sub-key nor an extension
 *                      term. Put a one-off rule in verifier_constraints, or
 *                      add a core sub-key to the vocabulary and the doc.
 *   invalid-core-key   a core sub-key whose value doesn't have its documented
 *                      shape.
 *   missing-spec       no `spec` pointer beside the rules.
 *   not-an-object      the annotation isn't an object.
 *
 * Existing findings are in lint-x-adcp-validation-baseline.json. A new finding
 * fails.
 */

'use strict';

const path = require('node:path');
const Ajv = require('ajv');
const { loadSchemaTree, runCli, walkSchema } = require('./schema-convention-lint.cjs');

const DEFAULT_BASELINE_PATH = path.join(__dirname, 'lint-x-adcp-validation-baseline.json');
const META_SCHEMA = require('./x-adcp-validation.schema.json');
const KEYWORD = 'x-adcp-validation';

function compileMetaSchema() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(META_SCHEMA);
}

/** One finding per (annotation, key) from the meta-schema's errors. */
function findingsFor(annotation, site, validate) {
  if (annotation === null || typeof annotation !== 'object' || Array.isArray(annotation)) {
    return [{ rule: 'not-an-object', site, message: `${KEYWORD} is ${JSON.stringify(annotation)}` }];
  }
  if (validate(annotation)) return [];
  const byKey = new Map();
  for (const error of validate.errors) {
    if (error.instancePath === '' && error.keyword === 'additionalProperties') {
      const key = error.params.additionalProperty;
      byKey.set(`unknown-key ${key}`, { rule: 'unknown-key', site: `${site} (${key})`, message: `\`${key}\` is neither a core sub-key nor a {domain}:{key} extension term` });
    } else if (error.instancePath === '' && error.keyword === 'required') {
      byKey.set('missing-spec', { rule: 'missing-spec', site, message: 'no `spec` pointer beside the rules' });
    } else if (error.instancePath !== '') {
      const key = error.instancePath.split('/')[1].replace(/~1/g, '/').replace(/~0/g, '~');
      byKey.set(`invalid-core-key ${key}`, {
        rule: 'invalid-core-key',
        site: `${site} (${key})`,
        message: `\`${key}\` doesn't have its documented shape (${error.instancePath} ${error.message})`,
      });
    }
  }
  return [...byKey.values()];
}

function lintXAdcpValidation({ schemasDir } = {}) {
  const tree = loadSchemaTree(schemasDir);
  const validate = compileMetaSchema();
  const findings = [];
  let annotations = 0;
  for (const document of tree.documents) {
    for (const { node, pointer } of walkSchema(document.schema)) {
      if (!(KEYWORD in node)) continue;
      annotations += 1;
      findings.push(...findingsFor(node[KEYWORD], `${document.relativePath}#${pointer}/${KEYWORD}`, validate));
    }
  }
  return {
    findings: findings.sort((a, b) => `${a.rule} ${a.site}`.localeCompare(`${b.rule} ${b.site}`, 'en')),
    errors: tree.parseErrors.map((error) => `schema parse error: ${error}`),
    report: [`${annotations} ${KEYWORD} annotations`],
  };
}

module.exports = { DEFAULT_BASELINE_PATH, META_SCHEMA, lintXAdcpValidation };

if (require.main === module) {
  process.exitCode = runCli({
    name: 'x-adcp-validation lint',
    defaultBaselinePath: DEFAULT_BASELINE_PATH,
    baselineComment: 'x-adcp-validation keys outside the documented vocabulary (scripts/lint-x-adcp-validation.cjs, #8472). A new finding fails. Entries leave as rules move to a core sub-key, into verifier_constraints, or into the spec text.',
    lint: lintXAdcpValidation,
  });
}
