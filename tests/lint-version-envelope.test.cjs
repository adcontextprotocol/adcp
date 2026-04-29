#!/usr/bin/env node
/**
 * Lint: every schema that composes core/version-envelope.json via allOf
 * MUST have additionalProperties: true (or absent — defaults to true) at
 * its outer root.
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
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

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
