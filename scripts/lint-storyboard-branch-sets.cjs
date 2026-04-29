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
 *   contributes_both     — step declares both `contributes` and `contributes_to`
 *   contributes_outside_branch_set — `contributes: true` outside a branch_set phase
 *   contributes_bad_type — `contributes` is present but not a boolean
 *   orphan_contribution  — contributes_to flag is never consumed by any
 *                          assert_contribution any_of in the same storyboard
 *   unresolved_scenario_reference — requires_scenarios entry names an id
 *                          that doesn't exist in the source tree (no file
 *                          declares that `id:`). Symmetric with the
 *                          duplicate-doc.id throw in buildScenarioFlagIndex:
 *                          if collisions are a build-time error, missing
 *                          references must be too.
 *
 * `contributes_both` / `contributes_outside_branch_set` / `contributes_bad_type`
 * mirror adcp-client's loader (node_modules/@adcp/sdk/dist/lib/testing/
 * storyboard/loader.js `resolveContributesShorthand`) so authors see the
 * violation at build time instead of storyboard-load time.
 *
 * Doc-level rules (those that apply to the storyboard as a whole, not a
 * specific phase) use `phaseId: '<doc>'` as a sentinel so the main()
 * formatter can render `file.yaml:<doc>` consistently. Current doc-level
 * rules: unresolved_scenario_reference.
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
  contributes_both: () =>
    'step declares both `contributes` and `contributes_to`. Pick one — ' +
    "the runner's loader throws on ambiguity at storyboard-load time.",
  contributes_outside_branch_set: () =>
    '`contributes: true` is only legal inside a phase that declares ' +
    '`branch_set:`. Outside a branch set there is no id to resolve the ' +
    'shorthand to — use `contributes_to: <flag>` or remove the field.',
  contributes_bad_type: ({ value }) =>
    '`contributes` must be a boolean (true or false); ' +
    `got ${JSON.stringify(value)}. Use \`contributes_to: <flag>\` for the ` +
    'string form.',
  orphan_contribution: ({ flag }) =>
    `step declares contribution to "${flag}" but no \`assert_contribution\` ` +
    `step in this storyboard references it via \`check: any_of, ` +
    `allowed_values: [${flag}]\`. Either add the assertion or remove the ` +
    'dead contribution — nothing is grading what this step produces.',
  unresolved_scenario_reference: ({ scenarioId }) =>
    `requires_scenarios references "${scenarioId}" but no file in the source ` +
    `tree declares that \`id:\`. Either fix the reference, add the missing ` +
    'scenario file, or remove the entry — the runner will grade this ' +
    'storyboard `not_applicable` with `unresolved_scenario_reference` rather ' +
    'than silently pass.',
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
 * Walk the source tree and build `Map<doc.id, Set<flag>>` of asserted flags
 * per storyboard/scenario. `orphan_contribution` checks consume this to
 * honor `requires_scenarios:` references — a flag asserted in a linked
 * scenario is legitimately consumed.
 *
 * Duplicate `id:` across files is a source bug: which file "wins" becomes
 * order-dependent on filesystem iteration, and the wrong file's asserted
 * flags could mask a real orphan elsewhere. Throw immediately so the
 * collision surfaces at lint time rather than as a silent false negative.
 */
function buildScenarioFlagIndex(sourceDir) {
  const index = new Map();
  const sources = new Map();
  for (const file of walkYaml(sourceDir)) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    const id = doc.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const prior = sources.get(id);
    if (prior && prior !== file) {
      throw new Error(
        `lint-storyboard-branch-sets: duplicate storyboard id "${id}" in ` +
          `${path.relative(sourceDir, prior)} and ` +
          `${path.relative(sourceDir, file)}. IDs must be unique across the ` +
          'source tree so requires_scenarios resolution is deterministic.',
      );
    }
    sources.set(id, file);
    index.set(id, collectAssertedFlags(doc));
  }
  return index;
}

/**
 * Lint a single parsed storyboard doc. Returns an array of violations shaped
 * as `{ rule, phaseId, stepId?, ...rule-specific payload }`. File paths are
 * threaded on at the caller.
 *
 * Accepts an options object so tests can exercise future `semantics` values
 * without mutating module state.
 */
function lintDoc(doc, { supportedSemantics = SUPPORTED_SEMANTICS, scenarioFlagIndex } = {}) {
  const violations = [];
  if (!doc || typeof doc !== 'object') return violations;
  const phases = Array.isArray(doc.phases) ? doc.phases : [];

  const semanticsById = new Map();
  const declaredBranchSetIds = new Set();
  // A contribution is legitimately consumed if any of (a) this doc asserts
  // it via assert_contribution any_of, or (b) a scenario the doc declares
  // in `requires_scenarios:` asserts it. The two kinds are unioned so a
  // parent storyboard that delegates its grading to a shared scenario
  // doesn't trigger orphan_contribution.
  //
  // An unresolved entry in `requires_scenarios` is a separate, stronger
  // violation: it means the runner will grade this storyboard
  // not_applicable at execution time. Surface it at lint time instead.
  const assertedFlags = collectAssertedFlags(doc);
  if (scenarioFlagIndex && Array.isArray(doc.requires_scenarios)) {
    for (const scenarioId of doc.requires_scenarios) {
      if (typeof scenarioId !== 'string') continue;
      const scenarioFlags = scenarioFlagIndex.get(scenarioId);
      if (scenarioFlags) {
        for (const flag of scenarioFlags) assertedFlags.add(flag);
      } else {
        violations.push({
          rule: 'unresolved_scenario_reference',
          phaseId: '<doc>',
          scenarioId,
        });
      }
    }
  }

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
      const steps = Array.isArray(phase?.steps) ? phase.steps : [];
      for (const step of steps) {
        const stepId = step?.id || '<unnamed>';

        // `contributes` in a phase without branch_set: only `false` is valid
        // (equivalent to absence); `true` has no id to resolve to, non-boolean
        // is a type error.
        if (step?.contributes !== undefined) {
          if (typeof step.contributes !== 'boolean') {
            violations.push({
              rule: 'contributes_bad_type',
              phaseId,
              stepId,
              value: step.contributes,
            });
          } else if (step.contributes === true) {
            violations.push({
              rule: 'contributes_outside_branch_set',
              phaseId,
              stepId,
            });
          }
        }

        if (step?.contributes !== undefined && step?.contributes_to !== undefined) {
          violations.push({ rule: 'contributes_both', phaseId, stepId });
        }

        // peer_not_declared: the phase doesn't declare branch_set, but if a
        // peer does, any step here contributing to that peer's id is a
        // mixed-mode authoring error.
        if (phase?.optional === true) {
          const c = step?.contributes_to;
          if (typeof c === 'string' && declaredBranchSetIds.has(c)) {
            violations.push({
              rule: 'peer_not_declared',
              phaseId,
              stepId,
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
      const stepId = step?.id || '<unnamed>';

      if (step?.contributes !== undefined && step?.contributes_to !== undefined) {
        violations.push({ rule: 'contributes_both', phaseId, stepId });
      }

      if (step?.contributes !== undefined && typeof step.contributes !== 'boolean') {
        violations.push({
          rule: 'contributes_bad_type',
          phaseId,
          stepId,
          value: step.contributes,
        });
      }

      // `contributes: true` resolves to phase.branch_set.id — never a mismatch.
      // `contributes_to: <string>` must still equal branch_set.id.
      const contribution = step?.contributes_to;
      if (contribution === undefined || contribution === null) continue;
      if (typeof contribution !== 'string' || contribution !== id) {
        violations.push({
          rule: 'contributes_to_mismatch',
          phaseId,
          stepId,
          id,
          contribution,
        });
      }
    }
  }

  // orphan_contribution: every contributes_to flag (and every branch_set.id
  // on a step with `contributes: true`) must be consumed by an
  // assert_contribution any_of somewhere in the same storyboard. A
  // contribution nothing asserts on is silently a no-op.
  for (const phase of phases) {
    const phaseId = phase?.id || '<unnamed>';
    const bs = phase?.branch_set;
    const branchSetId =
      bs && typeof bs === 'object' && !Array.isArray(bs) && typeof bs.id === 'string' && bs.id.length > 0
        ? bs.id
        : null;
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    for (const step of steps) {
      const stepId = step?.id || '<unnamed>';
      let flag = null;
      if (typeof step?.contributes_to === 'string' && step.contributes_to.length > 0) {
        flag = step.contributes_to;
      } else if (step?.contributes === true && branchSetId) {
        flag = branchSetId;
      }
      if (flag === null) continue;
      if (!assertedFlags.has(flag)) {
        violations.push({ rule: 'orphan_contribution', phaseId, stepId, flag });
      }
    }
  }

  return violations;
}

function lint() {
  const files = walkYaml(SOURCE_DIR);
  const scenarioFlagIndex = buildScenarioFlagIndex(SOURCE_DIR);
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
    for (const v of lintDoc(doc, { scenarioFlagIndex })) {
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
  buildScenarioFlagIndex,
  formatMessage,
};
