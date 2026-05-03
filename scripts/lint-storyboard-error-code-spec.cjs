#!/usr/bin/env node
/**
 * Storyboard error-code spec conformance lint (adcontextprotocol/adcp#3918 item 7).
 *
 * For every storyboard step that declares a `validations[]` entry with
 * `check: error_code`, validate that every referenced code in `value` or
 * `allowed_values` exists in `static/schemas/source/enums/error-code.json`.
 *
 * Why this lint exists
 * --------------------
 * The check-enum lint validates that `validations[].check` keywords are
 * recognized (e.g., "error_code" itself is a valid check kind). It does NOT
 * validate the *values* cited — the actual error code strings. As a result,
 * storyboards can cite non-spec codes ("BRAND_NOT_FOUND", "brand_not_found")
 * that silently drift from the spec. Adopters who copy these assertions then
 * test against codes their implementations will never return, or write
 * switch-statements that can never match. Both bugs (#3892 rights_grant_id,
 * #3914 GOVERNANCE_DENIED) originated as "storyboard authored a non-spec
 * opinion" — this lint is the publish-time gate.
 *
 * Note: a `check: error_code` entry with neither `value` nor `allowed_values`
 * is valid — the runner asserts only that some error code is present. Such
 * entries are not linted here (no code to validate).
 *
 * Rules (each violation carries a stable `rule` ID — tests assert on it):
 *
 *   unknown_error_code  — a code cited in `value` or `allowed_values` under
 *                         `check: error_code` is not in the error-code.json
 *                         enum. Sellers MAY return unlisted codes per the
 *                         spec, but storyboard *expected-value* assertions
 *                         that name codes the spec never defines are author
 *                         bugs, not forward-compat claims.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');
const ERROR_CODE_FILE = path.join(ROOT, 'static', 'schemas', 'source', 'enums', 'error-code.json');

function loadErrorCodes() {
  const schema = JSON.parse(fs.readFileSync(ERROR_CODE_FILE, 'utf8'));
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    throw new Error(
      `error-code.json is missing the \`enum\` array. ` +
      `This lint reads that field as the canonical error code set; restore it before running.`
    );
  }
  return new Set(schema.enum);
}

const RULE_MESSAGES = {
  unknown_error_code: (code) =>
    `error code "${code}" is not in static/schemas/source/enums/error-code.json. ` +
    `Storyboard expected-value assertions must cite spec-defined codes only — sellers ` +
    `may return unlisted codes at runtime, but storyboard value:/allowed_values: entries ` +
    `teach adopters which codes to expect and MUST reflect the spec. ` +
    `Fix: use the canonical code (e.g., REFERENCE_NOT_FOUND for unknown-resource errors), ` +
    `or remove the value assertion and use check: error_code without value/allowed_values ` +
    `if any error code is acceptable.`,
};

function isStoryboardYaml(rel) {
  if (rel.startsWith('test-kits/')) return false;
  if (rel.endsWith('storyboard-schema.yaml')) return false;
  if (rel.endsWith('runner-output-contract.yaml')) return false;
  return true;
}

function* walkErrorCodeValidations(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) return;
  for (const phase of doc.phases) {
    if (!phase || !Array.isArray(phase.steps)) continue;
    for (const step of phase.steps) {
      if (!step || !Array.isArray(step.validations)) continue;
      for (let i = 0; i < step.validations.length; i++) {
        const v = step.validations[i];
        if (!v || typeof v !== 'object' || v.check !== 'error_code') continue;

        const codes = [];
        if (typeof v.value === 'string') codes.push(v.value);
        if (Array.isArray(v.allowed_values)) {
          for (const c of v.allowed_values) {
            if (typeof c === 'string') codes.push(c);
          }
        }

        for (const code of codes) {
          yield {
            phase: phase.id,
            step: step.id,
            index: i,
            code,
          };
        }
      }
    }
  }
}

function lint(sourceDir = SOURCE_DIR) {
  const errorCodes = loadErrorCodes();
  const violations = [];

  function lintFile(p) {
    const rel = path.relative(sourceDir, p);
    if (!isStoryboardYaml(rel)) return;
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(p, 'utf8'));
    } catch {
      return;
    }
    for (const hit of walkErrorCodeValidations(doc)) {
      if (!errorCodes.has(hit.code)) {
        violations.push({
          file: rel,
          phase: hit.phase,
          step: hit.step,
          index: hit.index,
          code: hit.code,
          rule: 'unknown_error_code',
        });
      }
    }
  }

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        lintFile(p);
      }
    }
  }
  walk(sourceDir);

  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ storyboard error-code spec lint: every cited error code is in the spec enum');
    return;
  }
  console.error(`✗ storyboard error-code spec lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule](v.code) : v.rule;
    console.error(`  ${v.file} phase=${v.phase} step=${v.step} validations[${v.index}] (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  loadErrorCodes,
  lint,
};
