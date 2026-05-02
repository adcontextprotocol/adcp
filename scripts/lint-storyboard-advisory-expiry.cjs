#!/usr/bin/env node
/**
 * Validate storyboard advisory-severity validation entries.
 *
 * When a storyboard validation declares `severity: advisory`, exactly one
 * of the following MUST be present on the entry:
 *
 *   1. `expires_after_version: "<semver>"`
 *      Runtime gate. The runner promotes the advisory to required once
 *      runner_capability_version >= this value. Common case for
 *      adoption-window gating (declare upstream_traffic as advisory while
 *      @adcp/sdk implements it; promote automatically once it ships).
 *
 *   2. `permanent_advisory: { reason: "<text>" }`
 *      Structured marker declaring the advisory is deliberately not gated
 *      on runner version. Use case: experimental signals where the advisory
 *      grade is the contract.
 *
 * Replaces the earlier `# advisory-permanent: <reason>` YAML-comment
 * marker, which broke under YAML round-tripping in editor formatters and
 * downstream tooling and could be silenced via injection of the literal
 * text inside a `description: |` block scalar (security review of #3852).
 *
 * Drift is a judgment call — these are warnings, not errors. The build
 * does NOT fail on violations. Authors silence at PR review time by
 * adding one of the two fields above.
 *
 * Rules (each warning carries a stable `rule` ID — tests assert on it):
 *
 *   advisory_without_expiry_or_permanent
 *       severity: advisory declared without expires_after_version AND
 *       without permanent_advisory.
 *
 *   advisory_expiry_not_semver
 *       expires_after_version is set to a value that fails
 *       semver.valid(). This is an error class, not just a warning,
 *       because the value gets interpolated into rendered reports
 *       (rendered_output_fencing covers it but defense-in-depth: malformed
 *       inputs shouldn't reach a renderer at all). Promoted to error
 *       severity in the lint output but the script still exits 0 — see
 *       below.
 *
 *   advisory_double_gating
 *       severity: advisory declared with BOTH expires_after_version AND
 *       permanent_advisory. The two are mutually exclusive — runtime
 *       promotion vs. permanent advisory are different intents.
 *
 * Lint exits 0 on all rule violations — these are PR-review signals, not
 * build blockers. Compare with lint-storyboard-raw-mode-required.cjs
 * which exits 1 (errors) because raw-required-without-justification has
 * an objective sufficiency criterion.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const semver = require('semver');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');

const RULE_MESSAGES = {
  advisory_without_expiry_or_permanent: () =>
    'severity: advisory declared without expires_after_version AND without ' +
    'permanent_advisory. Either add `expires_after_version: "<semver>"` (the ' +
    'runner_capability_version after which this advisory promotes to required), ' +
    'or add `permanent_advisory: { reason: "<text>" }` to mark this advisory as ' +
    'deliberately permanent. See storyboard-schema.yaml > "Validation" > ' +
    'expires_after_version and permanent_advisory.',
  advisory_expiry_not_semver: (value) =>
    `expires_after_version: "${value}" is not a valid semver. The lint validates ` +
    'the value via Node\'s `semver.valid()`; malformed values would fail at runtime ' +
    'and can leak storyboard-author content into rendered reports. Use a strict ' +
    'semver string (e.g., "6.5.0", "6.5.0-rc.3").',
  advisory_double_gating: () =>
    'severity: advisory declared with BOTH expires_after_version AND ' +
    'permanent_advisory. These are mutually exclusive — pick exactly one. ' +
    'expires_after_version is for adoption-window gating (auto-promote once ' +
    'runner catches up); permanent_advisory is for advisories that should ' +
    'never auto-promote.',
};

function isStoryboardYaml(rel) {
  if (rel.startsWith('test-kits/')) return false;
  if (rel.endsWith('storyboard-schema.yaml')) return false;
  if (rel.endsWith('runner-output-contract.yaml')) return false;
  return true;
}

function* walkAdvisoryValidations(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) return;
  for (const phase of doc.phases) {
    if (!phase || !Array.isArray(phase.steps)) continue;
    for (const step of phase.steps) {
      if (!step || !Array.isArray(step.validations)) continue;
      for (let i = 0; i < step.validations.length; i++) {
        const v = step.validations[i];
        if (!v || typeof v !== 'object') continue;
        if (v.severity !== 'advisory') continue;
        yield {
          phaseId: phase.id,
          stepId: step.id,
          index: i,
          validation: v,
        };
      }
    }
  }
}

function checkValidation(v) {
  const hasExpiry = typeof v.expires_after_version === 'string';
  const hasPermanent =
    v.permanent_advisory !== null &&
    typeof v.permanent_advisory === 'object' &&
    typeof v.permanent_advisory.reason === 'string';

  if (hasExpiry && hasPermanent) {
    return { rule: 'advisory_double_gating' };
  }
  if (!hasExpiry && !hasPermanent) {
    return { rule: 'advisory_without_expiry_or_permanent' };
  }
  if (hasExpiry && !semver.valid(v.expires_after_version)) {
    return {
      rule: 'advisory_expiry_not_semver',
      value: v.expires_after_version,
    };
  }
  return null;
}

function lint(sourceDir = SOURCE_DIR) {
  const warnings = [];

  function lintFile(p) {
    const rel = path.relative(sourceDir, p);
    if (!isStoryboardYaml(rel)) return;
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(p, 'utf8'));
    } catch {
      return;
    }
    for (const hit of walkAdvisoryValidations(doc)) {
      const violation = checkValidation(hit.validation);
      if (!violation) continue;
      warnings.push({
        file: rel,
        phase: hit.phaseId,
        step: hit.stepId,
        index: hit.index,
        check: hit.validation.check,
        ...violation,
      });
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

  return warnings;
}

function main() {
  const warnings = lint();
  if (warnings.length === 0) {
    console.log('✓ storyboard advisory-expiry lint: every advisory validation is gated, permanent, or fully spec\'d');
    return;
  }
  console.log(`⚠ storyboard advisory-expiry lint: ${warnings.length} warning(s)\n`);
  for (const w of warnings) {
    const msg = RULE_MESSAGES[w.rule] ? RULE_MESSAGES[w.rule](w.value) : w.rule;
    console.log(`  ${w.file} phase=${w.phase} step=${w.step} validations[${w.index}] check=${w.check} (${w.rule})`);
    console.log(`    ${msg}`);
    console.log('');
  }
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  walkAdvisoryValidations,
  checkValidation,
  lint,
};
