#!/usr/bin/env node
/**
 * Enforce authoring rules for `step.auth:` shapes in storyboards. See
 * `static/compliance/source/universal/storyboard-schema.yaml` (the step-level
 * `auth:` documentation) for the normative description.
 *
 * Current rules (each violation carries a stable `rule` ID — tests assert on it):
 *
 *   literal_value — step.auth declares a literal `value: "<string>"`. Literal
 *                   credentials in storyboard YAML are a code smell: they
 *                   bind the storyboard to a specific credential rather than
 *                   a test-kit principal, they can't rotate without rewriting
 *                   the storyboard, and they leak plaintext identity into
 *                   source control. Declared shapes to use instead:
 *                     auth: { type: <t>, from_test_kit: true }
 *                     auth: { type: <t>, from_test_kit: "<path>" }
 *                     auth: { type: <t>, value_strategy: <strategy> }
 *                     auth: none
 *                   The contradiction lint's `describeStepAuth` tolerates
 *                   literals via a sha1-8hex hash (#2708) as defense-in-depth,
 *                   but that's a bucket-avoidance mechanism — not an
 *                   endorsement of the pattern. This lint is the authoring
 *                   guard that keeps literals from ever entering source.
 *                   Filed: #2720.
 *
 * Doc-level rules (apply to the storyboard as a whole, not a specific phase)
 * use `phaseId: '<doc>'` as a sentinel so the main() formatter renders
 * `file.yaml:<doc>` consistently. No doc-level rules today.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');

const RULE_MESSAGES = {
  literal_value: () =>
    '`step.auth.value: "<literal>"` is not allowed in storyboards. ' +
    'Replace with `from_test_kit: true` (or `from_test_kit: "<path>"` to select ' +
    'a named principal within a multi-principal kit), or with ' +
    '`value_strategy: <strategy>` if the shape is deliberate (e.g., ' +
    '`random_invalid` for invalid-credential probes). ' +
    'See static/compliance/source/universal/storyboard-schema.yaml §auth.',
};

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

/**
 * Walk the storyboard's phases and emit `{ phaseId, step }` for every step
 * that carries a `task:` string. Steps with no task (assertion-only helpers
 * etc.) never declare `auth:` so they're safe to skip.
 *
 * `<unnamed>` sentinel for missing `phase.id`: deliberately different from
 * the scoping lint's undefined-passthrough. Here it gives the error
 * formatter a stable string to interpolate, so `file.yaml:<unnamed>/step`
 * prints cleanly when an author forgets the phase id — that's the scenario
 * most likely to hit this lint (a draft storyboard with incomplete metadata).
 */
function* iterSteps(doc) {
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];
  for (const phase of phases) {
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    for (const step of steps) {
      if (step && typeof step.task === 'string') {
        yield { phaseId: phase.id || '<unnamed>', step };
      }
    }
  }
}

/**
 * Detect the literal-value antipattern. Returns a rule record or null.
 *
 * `auth: "none"` (string) and `auth: { value_strategy: X }` don't match.
 * Only an object with a string `value:` field matches — which is the
 * specific shape `describeStepAuth` hashes as `literal:<sha1-8hex>`.
 */
function checkStep(step) {
  const auth = step.auth;
  if (!auth || typeof auth !== 'object') return null;
  if (typeof auth.value !== 'string') return null;
  return { rule: 'literal_value' };
}

/**
 * Walk a directory of storyboard YAML and return all violations. Accepts
 * an optional override of the source directory so tests can drop a
 * synthetic tree in an OS temp dir and exercise the full walker →
 * iterSteps → checkStep → aggregation path without touching the real
 * source tree.
 */
function lint(dir = SOURCE_DIR) {
  const files = walkYaml(dir);
  const violations = [];
  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    for (const { phaseId, step } of iterSteps(doc)) {
      const violation = checkStep(step);
      if (violation) {
        violations.push({
          file: path.relative(dir, file),
          phaseId,
          stepId: step.id || '<unnamed>',
          rule: violation.rule,
        });
      }
    }
  }
  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ storyboard auth-shape lint: no authoring antipatterns');
    return;
  }
  console.error(`✗ storyboard auth-shape lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule]() : v.rule;
    console.error(`  ${v.file}:${v.phaseId}/${v.stepId} (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = { RULE_MESSAGES, iterSteps, checkStep, lint };
