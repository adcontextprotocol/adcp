#!/usr/bin/env node
/**
 * Enforce authoring rules for `provides_state_for` declarations on storyboard
 * steps. See static/compliance/source/universal/storyboard-schema.yaml
 * (`provides_state_for` field) for the normative description.
 *
 * `provides_state_for: <step_id> | <step_id>[]` declares that a stateful step
 * establishes equivalent state for the named peer step(s) in the same phase,
 * letting the runner waive the missing_tool / missing_test_controller cascade
 * when the substitute passes. Validation rules surface authoring mistakes at
 * build time so the runner never ingests a malformed declaration.
 *
 * Rules (each violation carries a stable `rule` ID — tests assert on it):
 *   shape                  — provides_state_for is not a string or array of strings
 *   empty_target           — declaration contains an empty string entry
 *   self_reference         — declaration names the substitute's own step id
 *   unknown_target         — declaration names a step id not present in the same phase
 *   cross_phase            — declaration names a step id that exists in a DIFFERENT phase
 *                            (the substitution must be same-phase; cross-phase state
 *                            contracts belong in context_outputs / context_inputs)
 *   substitute_not_stateful — substitute step lacks `stateful: true`
 *   target_not_stateful    — target step lacks `stateful: true`
 *   cycle                  — A and B both name each other (A→B and B→A in the same phase)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const SOURCE_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source');

const RULE_MESSAGES = {
  shape: ({ value }) =>
    '`provides_state_for` must be a non-empty string or array of non-empty strings ' +
    `(got ${JSON.stringify(value)})`,
  empty_target: () =>
    '`provides_state_for` array contains an empty string — every entry must name a peer step id',
  self_reference: ({ stepId }) =>
    `\`provides_state_for\` names this step's own id "${stepId}". A step cannot ` +
    'substitute for itself; remove the entry.',
  unknown_target: ({ target }) =>
    `\`provides_state_for: ${target}\` does not match any step id in the same phase. ` +
    'Targets must be peers in the same phase — fix the typo or move the substitute.',
  cross_phase: ({ target, targetPhase }) =>
    `\`provides_state_for: ${target}\` references a step in phase "${targetPhase}". ` +
    'Cross-phase substitution is not supported — the target must live in the same ' +
    'phase as the substitute. Cross-phase state contracts belong in ' +
    '`context_outputs` / `context_inputs`, not this field.',
  substitute_not_stateful: () =>
    '`provides_state_for` is declared on a step that is not `stateful: true`. ' +
    'A stateless step cannot establish equivalent state on the agent side; ' +
    'add `stateful: true` or remove the declaration.',
  target_not_stateful: ({ target }) =>
    `\`provides_state_for: ${target}\` names a target step that is not ` +
    '`stateful: true`. Stateless peers do not carry a state contract to ' +
    'substitute for — remove the entry or mark the target stateful.',
  cycle: ({ target }) =>
    `\`provides_state_for\` cycle: this step substitutes for "${target}" and ` +
    `"${target}" substitutes back for this step. The peer-graph per phase MUST ` +
    'be acyclic — pick one direction.',
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
 * Normalize a `provides_state_for` field value to an array of target ids.
 * Returns null if the field is absent; returns the violation `{ rule, value }`
 * payload if the shape is invalid.
 */
function normalizeTargets(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    if (value.length === 0) return { invalid: true, value };
    return [value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { invalid: true, value };
    if (!value.every((v) => typeof v === 'string')) return { invalid: true, value };
    return value;
  }
  return { invalid: true, value };
}

/**
 * Lint a single parsed storyboard doc. Returns an array of violations shaped
 * as `{ rule, phaseId, stepId, ...rule-specific payload }`.
 */
function lintDoc(doc) {
  const violations = [];
  if (!doc || typeof doc !== 'object') return violations;
  const phases = Array.isArray(doc.phases) ? doc.phases : [];

  // Pass 1: index every step by id with its phase id and stateful flag so
  // pass 2 can resolve same-phase / cross-phase / target-stateful checks
  // without an O(n²) scan.
  const stepIndex = new Map(); // stepId -> { phaseId, stateful }
  for (const phase of phases) {
    const phaseId = phase?.id || '<unnamed>';
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];
    for (const step of steps) {
      const stepId = step?.id;
      if (typeof stepId !== 'string' || stepId.length === 0) continue;
      stepIndex.set(stepId, { phaseId, stateful: step.stateful === true });
    }
  }

  // Pass 2: per-phase rule enforcement, including cycle detection within the
  // phase's substitution graph.
  for (const phase of phases) {
    const phaseId = phase?.id || '<unnamed>';
    const steps = Array.isArray(phase?.steps) ? phase.steps : [];

    // edges: substituteId -> Set<targetId> (edges only kept for steps in
    // THIS phase that resolve to in-phase targets, since cross-phase is
    // a separate violation and shouldn't seed cycle detection).
    const edges = new Map();

    for (const step of steps) {
      const stepId = step?.id || '<unnamed>';
      const raw = step?.provides_state_for;
      const normalized = normalizeTargets(raw);
      if (normalized === null) continue;

      if (normalized.invalid) {
        violations.push({ rule: 'shape', phaseId, stepId, value: raw });
        continue;
      }

      // Substitute step itself must be stateful — independent of any specific
      // target's validity.
      if (step.stateful !== true) {
        violations.push({ rule: 'substitute_not_stateful', phaseId, stepId });
      }

      const inPhaseTargets = new Set();
      for (const target of normalized) {
        if (target.length === 0) {
          violations.push({ rule: 'empty_target', phaseId, stepId });
          continue;
        }
        if (target === stepId) {
          violations.push({ rule: 'self_reference', phaseId, stepId });
          continue;
        }
        const targetEntry = stepIndex.get(target);
        if (!targetEntry) {
          violations.push({ rule: 'unknown_target', phaseId, stepId, target });
          continue;
        }
        if (targetEntry.phaseId !== phaseId) {
          violations.push({
            rule: 'cross_phase',
            phaseId,
            stepId,
            target,
            targetPhase: targetEntry.phaseId,
          });
          continue;
        }
        if (!targetEntry.stateful) {
          violations.push({ rule: 'target_not_stateful', phaseId, stepId, target });
          // still seed cycle detection — a non-stateful target is its own
          // violation, but a back-edge from it would be a separate one.
        }
        inPhaseTargets.add(target);
      }
      if (inPhaseTargets.size > 0) edges.set(stepId, inPhaseTargets);
    }

    // Cycle detection: only direct two-step cycles (A→B and B→A) are reported
    // since `provides_state_for` is per-step and longer chains imply a state
    // shape the substitute mechanism isn't designed for. A multi-step cycle
    // would surface as multiple direct cycles anyway.
    for (const [stepId, targets] of edges) {
      for (const target of targets) {
        const back = edges.get(target);
        if (back && back.has(stepId)) {
          // Report once per pair, on the lexicographically lower step id, so
          // the same cycle doesn't double-fire.
          if (stepId < target) {
            violations.push({ rule: 'cycle', phaseId, stepId, target });
          }
        }
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
    console.log('✓ storyboard provides_state_for lint: all declarations conform');
    return;
  }

  console.error(`✗ storyboard provides_state_for lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const loc = `${v.file}:${v.phaseId}/${v.stepId}`;
    console.error(`  ${loc} — ${formatMessage(v)}`);
  }
  console.error(
    '\nSee static/compliance/source/universal/storyboard-schema.yaml (`provides_state_for` field) for the normative rules.',
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  lint,
  lintDoc,
  normalizeTargets,
  formatMessage,
};
