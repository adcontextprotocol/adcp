#!/usr/bin/env node
/**
 * Warn (not fail) when a storyboard validation entry declares `severity:
 * advisory` without an `expires_after_version` semver. The field is
 * optional by design — permanent advisory checks (experimental signals
 * the spec authors deliberately keep advisory) legitimately omit it. But
 * the common case for advisory severity is rollout gating during a runner
 * adoption window, which means the author intends to promote the check
 * once the runner catches up. Without expires_after_version, that
 * promotion is manual — and easy to forget across many PRs.
 *
 * This lint surfaces "is this drift on purpose?" at PR review time. It
 * emits warnings to stdout but does NOT exit non-zero — drift is a
 * judgment call, not a build error. Authors silence the warning by either
 * adding expires_after_version or adding an explicit
 * `# advisory-permanent: <reason>` comment on the storyboard step.
 *
 * Rules (each warning carries a stable `rule` ID):
 *
 *   advisory_without_expiry
 *       severity: advisory declared without expires_after_version, and no
 *       advisory-permanent: marker on the surrounding step. Add either
 *       expires_after_version: "<semver>" to gate auto-promotion, or
 *       "# advisory-permanent: <reason>" above the step to mark this as
 *       deliberate permanent advisory drift.
 *
 * See storyboard-schema.yaml > "Validation" > expires_after_version for
 * the runner-side promotion semantics. The runner consumes
 * expires_after_version at storyboard-load time; this lint surfaces the
 * authoring hazard before the storyboard ever hits a runner.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');

const RULE_MESSAGES = {
  advisory_without_expiry: () =>
    'severity: advisory declared without expires_after_version. Either add ' +
    '`expires_after_version: "<semver>"` (the @adcp/sdk version after which the ' +
    'runner promotes this advisory to required), or add ' +
    '`# advisory-permanent: <reason>` immediately above the storyboard step ' +
    'to mark deliberate permanent advisory drift. See ' +
    'static/compliance/source/universal/storyboard-schema.yaml > "Validation" ' +
    '> expires_after_version.',
};

function isStoryboardYaml(rel) {
  if (rel.startsWith('test-kits/')) return false;
  if (rel.endsWith('storyboard-schema.yaml')) return false;
  if (rel.endsWith('runner-output-contract.yaml')) return false;
  return true;
}

/**
 * Walk a parsed storyboard doc and yield each {phaseId, stepId, validation}
 * triple where the validation has severity: advisory.
 */
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

/**
 * Detect `# advisory-permanent: <reason>` markers in the raw file text.
 * Returns a Set of step IDs that carry the marker. We use textual match
 * rather than YAML-comment parsing because js-yaml drops comments — and
 * the marker is a maintenance signal, not load-bearing semantic data, so
 * approximate matching (the marker appears within ~10 lines of a `- id: x`
 * declaration) is enough.
 */
function findAdvisoryPermanentMarkers(rawText) {
  const stepIdsWithMarker = new Set();
  const lines = rawText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/#\s*advisory-permanent\s*:/i.test(lines[i])) continue;
    // Look ahead up to 10 lines for the next `- id: <name>` (a step ID).
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const m = lines[j].match(/^\s*-\s*id:\s*(\S+)/);
      if (m) {
        stepIdsWithMarker.add(m[1]);
        break;
      }
    }
  }
  return stepIdsWithMarker;
}

function lint(sourceDir = SOURCE_DIR) {
  const warnings = [];

  function lintFile(p) {
    const rel = path.relative(sourceDir, p);
    if (!isStoryboardYaml(rel)) return;
    const rawText = fs.readFileSync(p, 'utf8');
    let doc;
    try {
      doc = yaml.load(rawText);
    } catch {
      return;
    }
    const permanentMarkers = findAdvisoryPermanentMarkers(rawText);
    for (const hit of walkAdvisoryValidations(doc)) {
      if (typeof hit.validation.expires_after_version === 'string') continue;
      if (permanentMarkers.has(hit.stepId)) continue;
      warnings.push({
        file: rel,
        phase: hit.phaseId,
        step: hit.stepId,
        index: hit.index,
        check: hit.validation.check,
        rule: 'advisory_without_expiry',
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
    console.log('✓ storyboard advisory-expiry lint: every advisory validation is gated or marked permanent');
    return;
  }
  // Warnings, not errors — exit 0.
  console.log(`⚠ storyboard advisory-expiry lint: ${warnings.length} warning(s)\n`);
  for (const w of warnings) {
    const msg = RULE_MESSAGES[w.rule] ? RULE_MESSAGES[w.rule]() : w.rule;
    console.log(`  ${w.file} phase=${w.phase} step=${w.step} validations[${w.index}] check=${w.check} (${w.rule})`);
    console.log(`    ${msg}`);
    console.log('');
  }
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  findAdvisoryPermanentMarkers,
  walkAdvisoryValidations,
  lint,
};
