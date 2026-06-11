#!/usr/bin/env node
/**
 * Ensure package-mutating update_media_buy storyboards validate returned
 * affected package state, not only affected package IDs.
 *
 * The update_media_buy contract says affected_packages contains full Package
 * objects showing complete post-update state. JSON Schema cannot enforce that
 * contextual rule because Package is shared and many fields are conditional.
 * This lint keeps the semantic compliance checks from regressing to ID-only
 * assertions: every successful storyboard step that sends packages[] must
 * assert affected_packages and must include one state-bearing field_contains
 * assertion per package mutation.
 *
 * This intentionally scopes to existing package updates. new_packages[] creates
 * seller-generated package IDs, so created-package coverage needs a separate
 * assertion model that can fingerprint request-side package context without
 * forcing authors to know the generated package_id.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');

const RULE_MESSAGES = {
  missing_affected_packages_assertion: () =>
    'Successful package-mutating update_media_buy steps must assert affected_packages. ' +
    'Add an affected_packages validation so omitted arrays fail compliance.',
  insufficient_full_package_state_assertions: (expected, actual) =>
    `Successful package-mutating update_media_buy steps need one field_contains assertion on ` +
    `affected_packages[*] per packages[] mutation. Each assertion must match package_id ` +
    `and at least one non-identity post-update state field. Found ${actual}, expected ${expected}. ` +
    `ID-only affected_packages stubs must fail compliance.`,
};

const PACKAGE_IDENTITY_KEYS = new Set(['package_id', 'product_id', 'pricing_option_id']);
const PACKAGE_NON_STATE_KEYS = new Set([...PACKAGE_IDENTITY_KEYS, 'context']);

function isSubmittedEnvelopeValidation(validation) {
  if (!validation || typeof validation !== 'object') return false;
  if (typeof validation.path === 'string' && validation.path.startsWith('task_completion.')) {
    return true;
  }
  if (validation.path !== 'status') return false;
  if (validation.value === 'submitted') return true;
  return Array.isArray(validation.allowed_values) && validation.allowed_values.includes('submitted');
}

function modelsSubmittedEnvelope(step) {
  const validations = Array.isArray(step && step.validations) ? step.validations : [];
  return validations.some(isSubmittedEnvelopeValidation);
}

function isStoryboardYaml(rel) {
  if (rel.startsWith('test-kits/')) return false;
  if (rel.endsWith('storyboard-schema.yaml')) return false;
  if (rel.endsWith('runner-output-contract.yaml')) return false;
  return true;
}

function packageMutationCount(step) {
  const request = step && step.sample_request;
  if (!request || typeof request !== 'object') return 0;
  return Array.isArray(request.packages) ? request.packages.length : 0;
}

function packageUpdateIds(step) {
  const packages = step && step.sample_request && Array.isArray(step.sample_request.packages)
    ? step.sample_request.packages
    : [];
  return packages
    .map((pkg) => pkg && pkg.package_id)
    .filter((id) => typeof id === 'string' && id.length > 0);
}

function hasAffectedPackagesPath(validation) {
  return validation &&
    typeof validation.path === 'string' &&
    validation.path.startsWith('affected_packages');
}

function isAffectedPackageStateAssertion(validation) {
  if (!validation || validation.check !== 'field_contains') return false;
  if (validation.path !== 'affected_packages[*]') return false;
  const value = validation.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'package_id')) return false;
  return Object.keys(value).some((key) => !PACKAGE_NON_STATE_KEYS.has(key));
}

function lintDoc(doc, file = '<inline>') {
  const violations = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.phases)) return violations;

  for (const phase of doc.phases) {
    if (!phase || !Array.isArray(phase.steps)) continue;
    for (const step of phase.steps) {
      if (!step || step.task !== 'update_media_buy' || step.expect_error) continue;
      if (modelsSubmittedEnvelope(step)) continue;
      const expectedAssertions = packageMutationCount(step);
      if (expectedAssertions === 0) continue;

      const validations = Array.isArray(step.validations) ? step.validations : [];
      if (!validations.some(hasAffectedPackagesPath)) {
        violations.push({
          file,
          phase: phase.id,
          step: step.id,
          rule: 'missing_affected_packages_assertion',
          expected: expectedAssertions,
          actual: 0,
        });
        continue;
      }

      const assertions = validations.filter(isAffectedPackageStateAssertion);
      const actualAssertions = assertions.length;
      if (actualAssertions < expectedAssertions) {
        violations.push({
          file,
          phase: phase.id,
          step: step.id,
          rule: 'insufficient_full_package_state_assertions',
          expected: expectedAssertions,
          actual: actualAssertions,
        });
        continue;
      }

      const assertedPackageIds = new Set(
        assertions
          .map((validation) => validation.value && validation.value.package_id)
          .filter((id) => typeof id === 'string' && id.length > 0),
      );
      const packageIds = packageUpdateIds(step);
      const missingPackageIds = packageIds.filter((id) => !assertedPackageIds.has(id));
      if (missingPackageIds.length > 0) {
        violations.push({
          file,
          phase: phase.id,
          step: step.id,
          rule: 'insufficient_full_package_state_assertions',
          expected: expectedAssertions,
          actual: actualAssertions - missingPackageIds.length,
          missingPackageIds,
        });
        continue;
      }

    }
  }

  return violations;
}

function lint(sourceDir = SOURCE_DIR) {
  const violations = [];

  function lintFile(filePath) {
    const rel = path.relative(sourceDir, filePath);
    if (!isStoryboardYaml(rel)) return;
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return;
    }
    violations.push(...lintDoc(doc, rel));
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
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
    console.log('✓ update_media_buy affected_packages lint: package updates assert affected package identity and state');
    return;
  }

  console.error(`✗ update_media_buy affected_packages lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule](v.expected, v.actual) : v.rule;
    console.error(`  ${v.file} phase=${v.phase} step=${v.step} (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  RULE_MESSAGES,
  hasAffectedPackagesPath,
  isAffectedPackageStateAssertion,
  modelsSubmittedEnvelope,
  lint,
  lintDoc,
  packageUpdateIds,
  packageMutationCount,
};
