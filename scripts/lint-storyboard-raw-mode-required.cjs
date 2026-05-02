#!/usr/bin/env node
/**
 * Reject storyboards that set `attestation_mode_required: "raw"` on an
 * `upstream_traffic` check without a `payload_must_contain` clause that
 * justifies the exclusion of digest-mode adopters.
 *
 * Why this lint exists
 * --------------------
 * `attestation_mode_required: "raw"` excludes every adopter who supports
 * `query_upstream_traffic` only in digest mode (the EU/privacy-conscious
 * cohort). The spec says "use sparingly" — but soft guidance is
 * unenforceable. This lint converts the guidance into a publish-time
 * gate: setting raw-required is only justified when the storyboard
 * declares an assertion that genuinely cannot be expressed in digest
 * mode.
 *
 * Mode-agnostic assertions (work in both raw and digest):
 *   - min_count
 *   - endpoint_pattern
 *   - identifier_paths   (digest mode supports via identifier_match_proofs)
 *   - purpose_filter
 *   - since
 *
 * Raw-only assertions:
 *   - payload_must_contain  (arbitrary path-into-payload assertions —
 *                            digest mode grades these not_applicable
 *                            because the runner can't introspect a
 *                            digest)
 *
 * If a storyboard sets attestation_mode_required: "raw" but has zero
 * payload_must_contain entries, the raw requirement adds no value — it
 * just excludes digest-mode adopters from the conformance signal for
 * nothing.
 *
 * Rules:
 *
 *   raw_required_without_justification
 *       attestation_mode_required: "raw" set on an upstream_traffic check
 *       that has no payload_must_contain clause. Either add a
 *       payload_must_contain assertion (the raw-only feature this is
 *       protecting), or drop attestation_mode_required so digest-mode
 *       adopters can participate.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');

const MODE_AGNOSTIC_FIELDS = [
  'min_count',
  'endpoint_pattern',
  'identifier_paths',
  'purpose_filter',
  'since',
];

function presentModeAgnosticAssertions(validation) {
  const present = [];
  for (const field of MODE_AGNOSTIC_FIELDS) {
    const value = validation[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    present.push(field);
  }
  return present;
}

const RULE_MESSAGES = {
  raw_required_without_justification: (presentAssertions) => {
    const enumeratedPresent = presentAssertions && presentAssertions.length > 0
      ? `Present assertions on this check: ${presentAssertions.join(', ')} — all mode-agnostic. `
      : '';
    return (
      'attestation_mode_required: "raw" set on an upstream_traffic check that ' +
      'has no payload_must_contain clause. ' +
      enumeratedPresent +
      'The raw requirement excludes every adopter who supports ' +
      'query_upstream_traffic only in digest mode (privacy-conscious cohort) — ' +
      'and adds no value when all the assertions on this check work in digest ' +
      'mode too. Either add a payload_must_contain entry (the raw-only assertion ' +
      'the flag protects), or drop attestation_mode_required so digest-mode ' +
      'adopters can participate. See ' +
      'static/compliance/source/universal/storyboard-schema.yaml > "upstream_traffic".'
    );
  },
};

function isStoryboardYaml(rel) {
  if (rel.startsWith('test-kits/')) return false;
  if (rel.endsWith('storyboard-schema.yaml')) return false;
  if (rel.endsWith('runner-output-contract.yaml')) return false;
  return true;
}

function* walkUpstreamTrafficChecks(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) return;
  for (const phase of doc.phases) {
    if (!phase || !Array.isArray(phase.steps)) continue;
    for (const step of phase.steps) {
      if (!step || !Array.isArray(step.validations)) continue;
      for (let i = 0; i < step.validations.length; i++) {
        const v = step.validations[i];
        if (!v || typeof v !== 'object') continue;
        if (v.check !== 'upstream_traffic') continue;
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

function lint(sourceDir = SOURCE_DIR) {
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
    for (const hit of walkUpstreamTrafficChecks(doc)) {
      if (hit.validation.attestation_mode_required !== 'raw') continue;
      const hasPayloadMustContain =
        Array.isArray(hit.validation.payload_must_contain) &&
        hit.validation.payload_must_contain.length > 0;
      if (hasPayloadMustContain) continue;
      violations.push({
        file: rel,
        phase: hit.phaseId,
        step: hit.stepId,
        index: hit.index,
        rule: 'raw_required_without_justification',
        present_assertions: presentModeAgnosticAssertions(hit.validation),
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

  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ storyboard raw-mode-required lint: every attestation_mode_required:raw declares a payload_must_contain clause');
    return;
  }
  console.error(`✗ storyboard raw-mode-required lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule](v.present_assertions) : v.rule;
    console.error(`  ${v.file} phase=${v.phase} step=${v.step} validations[${v.index}] (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  MODE_AGNOSTIC_FIELDS,
  presentModeAgnosticAssertions,
  walkUpstreamTrafficChecks,
  lint,
};
