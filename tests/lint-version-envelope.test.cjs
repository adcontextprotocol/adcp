#!/usr/bin/env node
/**
 * Lint: schemas that compose core/version-envelope.json at the **root**
 * `allOf` MUST have additionalProperties: true (or absent — defaults to
 * true) at their outer root.
 *
 * Why: in JSON Schema draft-07, allOf does not bypass the parent schema's
 * additionalProperties. A parent with additionalProperties: false rejects
 * the envelope's adcp_version and adcp_major_version fields outright,
 * even though they are declared inside the $ref'd envelope. The strict
 * version returns at draft 2019-09 via unevaluatedProperties: false
 * (tracked separately in #3534).
 *
 * Until then, the envelope-via-allOf pattern requires permissive parents.
 * This lint enforces the invariant so future contributors don't reintroduce
 * the regression.
 *
 * Scope: this lint inspects only the schema's root `allOf` array. Schemas
 * that need strict-mode (e.g. trusted-match/identity-match-request.json's privacy
 * boundary) intentionally don't compose the envelope via allOf — they
 * inline `adcp_version` / `adcp_major_version` in `properties`. The lint
 * does not (and should not) detect indirect composition through `oneOf`
 * branches, `definitions`/`$defs`, or nested allOf — those patterns are
 * not used in AdCP today and adding them would rightly trigger this lint
 * via direct conversion to a root-level allOf.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
const ENVELOPE_REF = '/schemas/core/version-envelope.json';

function listJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function usesVersionEnvelope(schema) {
  return (
    schema &&
    typeof schema === 'object' &&
    Array.isArray(schema.allOf) &&
    schema.allOf.some((s) => s && s.$ref === ENVELOPE_REF)
  );
}

test('every schema that allOfs the version envelope has permissive additionalProperties at root', () => {
  const violations = [];
  for (const file of listJsonFiles(SOURCE_DIR)) {
    let schema;
    try {
      schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // malformed JSON is a different lint's concern
    }
    if (!usesVersionEnvelope(schema)) continue;

    const ap = schema.additionalProperties;
    if (ap === false) {
      violations.push({
        file: path.relative(path.resolve(__dirname, '..'), file),
        reason: 'additionalProperties: false at root rejects envelope fields',
      });
    }
  }

  assert.deepEqual(
    violations,
    [],
    'Schemas with allOf $ref to version-envelope.json MUST have ' +
      'additionalProperties: true (or absent) at root. draft-07 allOf does ' +
      'not bypass parent strict-mode. Violations:\n' +
      violations.map((v) => `  ${v.file} — ${v.reason}`).join('\n'),
  );
});

test('release-precision version grammar stays aligned across inlined negotiation surfaces', () => {
  const readJson = (relativePath) => JSON.parse(
    fs.readFileSync(path.join(SOURCE_DIR, relativePath), 'utf8'),
  );
  const canonicalPattern = readJson('core/version-envelope.json').properties.adcp_version.pattern;

  const inlinedPatterns = [
    readJson('trusted-match/context-match-request.json').properties.adcp_version.pattern,
    readJson('trusted-match/identity-match-request.json').properties.adcp_version.pattern,
    readJson('error-details/version-unsupported.json').properties.supported_versions.items.pattern,
    readJson('protocol/get-adcp-capabilities-response.json').properties.adcp.properties.supported_versions.items.pattern,
  ];
  assert.deepEqual(inlinedPatterns, Array(inlinedPatterns.length).fill(canonicalPattern));

  const storyboardPath = path.resolve(
    __dirname,
    '..',
    'static',
    'compliance',
    'source',
    'universal',
    'version-negotiation.yaml',
  );
  const storyboard = YAML.parse(fs.readFileSync(storyboardPath, 'utf8'));
  const checks = storyboard.phases.flatMap((phase) =>
    (phase.steps || []).flatMap((step) => step.validations || []),
  );
  const versionPatternCheck = checks.find(
    (check) => check.check === 'envelope_field_pattern' && check.path === 'adcp_version',
  );
  assert.equal(versionPatternCheck?.pattern, canonicalPattern);
});
