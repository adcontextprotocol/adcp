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
 * Rules:
 *   1. Every phase with `branch_set:` MUST set `optional: true`.
 *   2. `branch_set:` MUST carry a non-empty `id` (string) and a `semantics`
 *      equal to `any_of`. Other semantics values are reserved for future
 *      revisions and not yet implemented by runners.
 *   3. All phases in the same storyboard sharing a `branch_set.id` MUST
 *      share the same `branch_set.semantics`.
 *   4. A storyboard containing phases that declare `branch_set:` MUST also
 *      contain an `assert_contribution` step whose `validations[].check: any_of`
 *      includes that `branch_set.id` in `allowed_values`.
 *   5. Any step inside a branch-set phase that declares `contributes_to: X`
 *      MUST use `X === branch_set.id`. A mismatch grades the agent against a
 *      flag the assertion does not consume — a silent no-op we are trying to
 *      eliminate.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');

const SUPPORTED_SEMANTICS = new Set(['any_of']);

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

function lintStoryboard(relFile, doc, violations) {
  if (!doc || typeof doc !== 'object') return;
  const phases = Array.isArray(doc.phases) ? doc.phases : [];

  // id → semantics observed so far (rule 3)
  const semanticsById = new Map();
  const assertedFlags = collectAssertedFlags(doc);

  for (const phase of phases) {
    const bs = phase?.branch_set;
    if (bs === undefined || bs === null) continue;

    const phaseId = phase.id || '<unnamed>';

    if (typeof bs !== 'object' || Array.isArray(bs)) {
      violations.push({
        file: relFile,
        phaseId,
        message: '`branch_set:` must be an object with `id` and `semantics` fields',
      });
      continue;
    }

    const id = bs.id;
    const semantics = bs.semantics;

    if (typeof id !== 'string' || id.length === 0) {
      violations.push({
        file: relFile,
        phaseId,
        message: '`branch_set.id` must be a non-empty string',
      });
      continue;
    }

    if (typeof semantics !== 'string' || !SUPPORTED_SEMANTICS.has(semantics)) {
      violations.push({
        file: relFile,
        phaseId,
        message:
          `\`branch_set.semantics\` must be one of [${[...SUPPORTED_SEMANTICS].join(', ')}] ` +
          `(got ${JSON.stringify(semantics)})`,
      });
      continue;
    }

    // Rule 1: branch_set phases must be optional.
    if (phase.optional !== true) {
      violations.push({
        file: relFile,
        phaseId,
        message:
          `phase declares \`branch_set: ${id}\` but is not \`optional: true\`. ` +
          'A non-optional phase would fail the storyboard unconditionally and defeat the any_of semantics.',
      });
    }

    // Rule 3: peer phases in the same set share semantics.
    const prior = semanticsById.get(id);
    if (prior !== undefined && prior !== semantics) {
      violations.push({
        file: relFile,
        phaseId,
        message:
          `branch_set "${id}" has conflicting semantics across peer phases ` +
          `(saw ${JSON.stringify(prior)} and ${JSON.stringify(semantics)})`,
      });
    } else {
      semanticsById.set(id, semantics);
    }

    // Rule 4: storyboard asserts over this branch_set.id.
    if (!assertedFlags.has(id)) {
      violations.push({
        file: relFile,
        phaseId,
        message:
          `branch_set "${id}" has no matching \`assert_contribution\` step ` +
          'with `check: any_of, allowed_values: [...]` including the id. ' +
          'Without the assertion the branch set is dead — nothing grades it.',
      });
    }

    // Rule 5: contributes_to inside the phase matches branch_set.id.
    const steps = Array.isArray(phase.steps) ? phase.steps : [];
    for (const step of steps) {
      const contribution = step?.contributes_to;
      if (contribution === undefined || contribution === null) continue;
      if (typeof contribution !== 'string' || contribution !== id) {
        violations.push({
          file: relFile,
          phaseId,
          stepId: step?.id || '<unnamed>',
          message:
            `step declares \`contributes_to: ${JSON.stringify(contribution)}\` ` +
            `inside branch_set "${id}". Inside a branch_set phase, contributes_to ` +
            'MUST equal `branch_set.id` so the assertion consumes what the step produces.',
        });
      }
    }
  }
}

function lint() {
  const files = walkYaml(SOURCE_DIR);
  const violations = [];
  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const relFile = path.relative(SOURCE_DIR, file);
    lintStoryboard(relFile, doc, violations);
  }
  return violations;
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
    console.error(`  ${loc} — ${v.message}`);
  }
  console.error(
    '\nSee static/compliance/source/universal/storyboard-schema.yaml ("Branch sets" section) for the normative rules.',
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = { SUPPORTED_SEMANTICS, lint, collectAssertedFlags };
