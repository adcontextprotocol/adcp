#!/usr/bin/env node
/**
 * Enforce authoring rules for first-class `branch_set:` declarations on
 * storyboard phases. See static/compliance/source/universal/storyboard-schema.yaml
 * ("Branch sets" section) for the normative description.
 *
 * A branch set is a group of peer `optional: true` phases exercising mutually
 * exclusive agent behaviors for the same trigger. Before #2633 membership was
 * implied by correlation of `contributes_to` values; this lint enforces the
 * explicit declaration so typos and undeclared peers can't silently break the
 * any_of semantics.
 *
 * Rules (each violation carries a stable `rule` ID — tests assert on it):
 *   not_optional         — phase with branch_set: is not optional: true
 *   shape                — branch_set is not an object
 *   missing_id           — branch_set.id is missing or not a non-empty string
 *   bad_semantics        — branch_set.semantics is not a supported value
 *   semantics_conflict   — peer phases share branch_set.id but differ on semantics
 *   no_assertion         — declared branch_set.id has no matching assert_contribution any_of
 *   contributes_to_mismatch — step inside branch_set phase has contributes_to != branch_set.id
 *   peer_not_declared    — phase contributes_to a declared branch_set.id without declaring branch_set:
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');

const SUPPORTED_SEMANTICS = new Set(['any_of']);

const RULE_MESSAGES = {
  shape: () => '`branch_set:` must be an object with `id` and `semantics` fields',
  missing_id: () => '`branch_set.id` must be a non-empty string',
  bad_semantics: ({ semantics, supported }) =>
    `\`branch_set.semantics\` must be one of [${[...supported].join(', ')}] ` +
    `(got ${JSON.stringify(semantics)})`,
  not_optional: ({ id }) =>
    `phase declares \`branch_set: ${id}\` but is not \`optional: true\`. ` +
    'A non-optional phase would fail the storyboard unconditionally and defeat the any_of semantics.',
  semantics_conflict: ({ id, prior, current }) =>
    `branch_set "${id}" has conflicting semantics across peer phases ` +
    `(saw ${JSON.stringify(prior)} and ${JSON.stringify(current)})`,
  no_assertion: ({ id }) =>
    `branch_set "${id}" has no matching \`assert_contribution\` step ` +
    'with `check: any_of, allowed_values: [...]` including the id. ' +
    'Without the assertion the branch set is dead — nothing grades it.',
  contributes_to_mismatch: ({ id, contribution }) =>
    `step declares \`contributes_to: ${JSON.stringify(contribution)}\` ` +
    `inside branch_set "${id}". Inside a branch_set phase, contributes_to ` +
    'MUST equal `branch_set.id` so the assertion consumes what the step produces.',
  peer_not_declared: ({ id }) =>
    `phase has a step with \`contributes_to: ${id}\` but the phase itself ` +
    `does not declare \`branch_set: { id: ${id}, ... }\`. Another phase in this ` +
    'storyboard already declares that branch set — in mixed mode the runner ' +
    "would see a single-member set and grade this peer's failing steps as " +
    '`failed` instead of `peer_branch_taken`.',
};

function formatMessage(violation) {
  const builder = RULE_MESSAGES[violation.rule];
  if (!builder) return `unknown rule ${violation.rule}`;
  return builder(violation);
}

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
 * Collect every assertion flag referenced by an `assert_contribution` step's
 * `any_of` validation. Returns a Set of branch_set.id values the storyboard's
 * assertions will consume.
 */
function collectAssertedFlags(doc) {
  const flags = new Set();
  const phases = Array.isArray(doc?.phases) ? doc.phases : [];
  for (const phase of phases) {
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    for (const step of steps) {
      if (step?.task !== 'assert_contribution') continue;
      const validations = Array.isArray(step.validations) ? step.validations : [];
      for (const v of validations) {
        if (v?.check !== 'any_of') continue;
        const allowed = Array.isArray(v.allowed_values) ? v.allowed_values : [];
        for (const flag of allowed) {
          if (typeof flag === 'string' && flag.length > 0) flags.add(flag);
        }
      }
    }
  }
  return flags;
}

/**
 * Lint a single parsed storyboard doc. Returns an array of violations shaped
 * as `{ rule, phaseId, stepId?, ...rule-specific payload }`. File paths are
 * threaded on at the caller.
 *
 * Accepts an options object so tests can exercise future `semantics` values
 * without mutating module state.
 */
function lintDoc(doc, { supportedSemantics = SUPPORTED_SEMANTICS } = {}) {
  const violations = [];
  if (!doc || typeof doc !== 'object') return violations;
  const phases = Array.isArray(doc.phases) ? doc.phases : [];

  const semanticsById = new Map();
  const declaredBranchSetIds = new Set();
  const assertedFlags = collectAssertedFlags(doc);

  // Pass 1: gather declared branch_set.ids so pass 2 can enforce peer
  // completeness against contributes_to on peer phases that haven't been
  // declared yet.
  for (const phase of phases) {
    const bs = phase?.branch_set;
    if (bs && typeof bs === 'object' && !Array.isArray(bs) && typeof bs.id === 'string' && bs.id.length > 0) {
      declaredBranchSetIds.add(bs.id);
    }
  }

  for (const phase of phases) {
    const phaseId = phase?.id || '<unnamed>';
    const bs = phase?.branch_set;

    if (bs === undefined || bs === null) {
      // Rule 6 (peer_not_declared): the phase doesn't declare branch_set, but
      // if a peer does, any step here contributing to that peer's id is a
      // mixed-mode authoring error.
      if (phase?.optional === true) {
        const steps = Array.isArray(phase?.steps) ? phase.steps : [];
        for (const step of steps) {
          const c = step?.contributes_to;
          if (typeof c === 'string' && declaredBranchSetIds.has(c)) {
            violations.push({
              rule: 'peer_not_declared',
              phaseId,
              stepId: step?.id || '<unnamed>',
              id: c,
            });
          }
        }
      }
      continue;
    }

    if (typeof bs !== 'object' || Array.isArray(bs)) {
      violations.push({ rule: 'shape', phaseId });
      continue;
    }

    const id = bs.id;
    const semantics = bs.semantics;

    if (typeof id !== 'string' || id.length === 0) {
      violations.push({ rule: 'missing_id', phaseId });
      continue;
    }

    if (typeof semantics !== 'string' || !supportedSemantics.has(semantics)) {
      violations.push({
        rule: 'bad_semantics',
        phaseId,
        semantics,
        supported: supportedSemantics,
      });
      continue;
    }

    if (phase.optional !== true) {
      violations.push({ rule: 'not_optional', phaseId, id });
    }

    const prior = semanticsById.get(id);
    if (prior !== undefined && prior !== semantics) {
      violations.push({
        rule: 'semantics_conflict',
        phaseId,
        id,
        prior,
        current: semantics,
      });
    } else {
      semanticsById.set(id, semantics);
    }

    if (!assertedFlags.has(id)) {
      violations.push({ rule: 'no_assertion', phaseId, id });
    }

    const steps = Array.isArray(phase.steps) ? phase.steps : [];
    for (const step of steps) {
      const contribution = step?.contributes_to;
      if (contribution === undefined || contribution === null) continue;
      if (typeof contribution !== 'string' || contribution !== id) {
        violations.push({
          rule: 'contributes_to_mismatch',
          phaseId,
          stepId: step?.id || '<unnamed>',
          id,
          contribution,
        });
      }
    }
  }

  return violations;
}

function lint() {
  const files = walkYaml(SOURCE_DIR);
  const allViolations = [];
  for (const file of files) {
    let doc;
    try {
      // YAML parse errors are handled by the schema-validation pass in the
      // build pipeline; skip unparseable files here rather than double-reporting.
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const relFile = path.relative(SOURCE_DIR, file);
    for (const v of lintDoc(doc)) {
      allViolations.push({ ...v, file: relFile });
    }
  }
  return allViolations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ storyboard branch-set lint: all declarations conform');
    return;
  }

  console.error(`✗ storyboard branch-set lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const loc = v.stepId ? `${v.file}:${v.phaseId}/${v.stepId}` : `${v.file}:${v.phaseId}`;
    console.error(`  ${loc} — ${formatMessage(v)}`);
  }
  console.error(
    '\nSee static/compliance/source/universal/storyboard-schema.yaml ("Branch sets" section) for the normative rules.',
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  SUPPORTED_SEMANTICS,
  RULE_MESSAGES,
  lint,
  lintDoc,
  collectAssertedFlags,
  formatMessage,
};
