#!/usr/bin/env node
/**
 * Validate that every storyboard-authored `step.validations[].check` value
 * appears in the `authored_check_kinds` enum declared in
 * `static/compliance/source/universal/runner-output-contract.yaml`.
 *
 * Why this lint exists
 * --------------------
 * The runner-output-contract v2.0.0 added a forward-compat clause: runners
 * MUST grade unrecognized authored `check` values as `not_applicable`, not
 * failed. That clause exists for cross-version skew between storyboard and
 * runner — but it also creates a footgun where a typo like
 * `check: upsteam_traffic` silently grades not_applicable instead of
 * failing the storyboard at load. Defense-in-depth is correct; catching
 * typos at *publish* time is also correct. This lint is the publish-time
 * gate.
 *
 * Synthesized codes (`capture_path_not_resolvable`,
 * `unresolved_substitution`) are emitted by the runner, not authored. A
 * storyboard that declares one is itself a bug — the runner generates
 * those after authored checks complete, so an authored declaration is
 * either dead text or an attempt to assert against runner-internal state
 * that the storyboard cannot observe at validation time. Those codes are
 * deliberately not in `authored_check_kinds`; this lint flags them.
 *
 * Rules (each violation carries a stable `rule` ID — tests assert on it):
 *
 *   unknown_check_kind   — value is not in `authored_check_kinds` and is
 *                          not a runner-synthesized code.
 *   synthesized_check_kind_authored
 *                        — value is one of the runner-synthesized codes
 *                          (capture_path_not_resolvable,
 *                          unresolved_substitution) declared in a
 *                          storyboard's authored validations array.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');
const CONTRACT_FILE = path.join(SOURCE_DIR, 'universal', 'runner-output-contract.yaml');

const SYNTHESIZED_CHECK_KINDS = new Set([
  'capture_path_not_resolvable',
  'unresolved_substitution',
]);

function loadAuthoredCheckKinds() {
  const doc = yaml.load(fs.readFileSync(CONTRACT_FILE, 'utf8'));
  const kinds = doc && Array.isArray(doc.authored_check_kinds) ? doc.authored_check_kinds : null;
  if (!kinds || kinds.length === 0) {
    throw new Error(
      `runner-output-contract.yaml is missing the \`authored_check_kinds\` list. ` +
      `This lint reads that field as the canonical enum; restore it before running.`
    );
  }
  return new Set(kinds);
}

const RULE_MESSAGES = {
  unknown_check_kind: (check) =>
    `validations[].check value "${check}" is not in authored_check_kinds (declared in ` +
    `static/compliance/source/universal/runner-output-contract.yaml). Either fix the typo, or ` +
    `add the new check kind to authored_check_kinds AND document its semantics in ` +
    `storyboard-schema.yaml's "Validation" section before using it. The runtime forward-compat ` +
    `clause (runners grade unknown kinds not_applicable) exists for cross-version skew, not ` +
    `for catching typos at publish time.`,
  synthesized_check_kind_authored: (check) =>
    `validations[].check value "${check}" is a runner-synthesized code, not an authored ` +
    `check. Synthesized codes are emitted by the runner after authored checks complete — a ` +
    `storyboard cannot meaningfully assert against them. Remove this entry. See ` +
    `storyboard-schema.yaml's "Runner grading codes" section for which codes are synthesized.`,
};

function isStoryboardYaml(rel) {
  // Test-kit fixtures are not storyboards.
  if (rel.startsWith('test-kits/')) return false;
  // The schema doc itself documents check kinds in comment text; never lint it.
  if (rel.endsWith('storyboard-schema.yaml')) return false;
  // The runner-output-contract carries the authoritative enum; don't lint it
  // against itself.
  if (rel.endsWith('runner-output-contract.yaml')) return false;
  return true;
}

function* walkValidations(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) return;
  for (const phase of doc.phases) {
    if (!phase || !Array.isArray(phase.steps)) continue;
    for (const step of phase.steps) {
      if (!step || !Array.isArray(step.validations)) continue;
      for (let i = 0; i < step.validations.length; i++) {
        const v = step.validations[i];
        if (!v || typeof v !== 'object' || typeof v.check !== 'string') continue;
        yield {
          phase: phase.id,
          step: step.id,
          index: i,
          check: v.check,
        };
      }
    }
  }
}

function lint(sourceDir = SOURCE_DIR) {
  const authoredKinds = loadAuthoredCheckKinds();
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
    for (const hit of walkValidations(doc)) {
      if (SYNTHESIZED_CHECK_KINDS.has(hit.check)) {
        violations.push({
          file: rel,
          phase: hit.phase,
          step: hit.step,
          index: hit.index,
          check: hit.check,
          rule: 'synthesized_check_kind_authored',
        });
        continue;
      }
      if (!authoredKinds.has(hit.check)) {
        violations.push({
          file: rel,
          phase: hit.phase,
          step: hit.step,
          index: hit.index,
          check: hit.check,
          rule: 'unknown_check_kind',
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
    console.log('✓ storyboard check-enum lint: every authored validation check is in the enum');
    return;
  }
  console.error(`✗ storyboard check-enum lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule](v.check) : v.rule;
    console.error(`  ${v.file} phase=${v.phase} step=${v.step} validations[${v.index}] (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  SYNTHESIZED_CHECK_KINDS,
  loadAuthoredCheckKinds,
  lint,
};
