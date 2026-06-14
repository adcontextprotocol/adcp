#!/usr/bin/env node
/**
 * Enforce the bimodal partition of test-kit files described in
 * `static/compliance/source/universal/storyboard-schema.yaml` ("Test kit
 * flavors" section). Every file under `static/compliance/source/test-kits/`
 * MUST declare at least one of:
 *
 *   auth.api_key   — brand-kit flavor (carries a Bearer principal; used by
 *                    brand-focused storyboards)
 *   auth.basic     — brand-kit flavor (carries an HTTP Basic principal; used
 *                    by brand-focused storyboards)
 *   applies_to     — runner-contract flavor (carries harness coordination
 *                    fields; used by harness-focused storyboards and by
 *                    step-level `requires_contract:` references)
 *
 * Kits that declare both are tolerated — that's the future-branded-runner
 * shape (a runner contract that also carries its own test-coordination
 * principal). Kits that declare none are rejected: without any
 * marker the runner can't tell whether to treat the kit as credential-
 * carrying or contract-only, which silently reintroduces the `auth=
 * kit_default` ambiguity this invariant exists to close (#2721).
 *
 * Current rules (each violation carries a stable `rule` ID — tests assert on it):
 *
 *   kit_shape_unclassified — file has none of `auth.api_key`, `auth.basic`,
 *                            or `applies_to`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const TEST_KITS_DIR = path.resolve(__dirname, '..', 'static', 'compliance', 'source', 'test-kits');

const RULE_MESSAGES = {
  kit_shape_unclassified: () =>
    'test-kit file declares none of `auth.api_key` or `auth.basic` (brand-kit flavor), ' +
    'nor `applies_to` (runner-contract flavor). Add one — see the "Test kit flavors" section of ' +
    'static/compliance/source/universal/storyboard-schema.yaml.',
};

function isSafeBasicPart(value) {
  return typeof value === 'string' && value.length > 0 && !/[\r\n\x00]|[^\x20-\x7E]/.test(value);
}

function hasUsableBasicCredential(basic) {
  if (basic === null || typeof basic !== 'object') return false;
  if (isSafeBasicPart(basic.username) && isSafeBasicPart(basic.password)) return true;
  if (!isSafeBasicPart(basic.credentials)) return false;
  const colonIndex = basic.credentials.indexOf(':');
  return colonIndex > 0 && colonIndex < basic.credentials.length - 1;
}

/**
 * Classify a parsed kit doc by which partition markers it carries.
 *
 * The checks are deliberately asymmetric: `hasApiKey` requires a string at
 * `auth.api_key`, `hasBasic` requires a usable Basic credential shape, while
 * `hasAppliesTo` is a presence check on the top-level field. Reason: the auth
 * markers have canonical shapes and we need to distinguish them from
 * `auth: { probe_task: ... }` with no credential (which is an incomplete brand
 * kit, not a valid one). `applies_to:` is already polymorphic across the
 * current runner contracts — some declare an object, some would declare a list
 * — so a presence check is the right floor without over-specifying the contract
 * shape.
 */
function classify(doc) {
  const isObject = doc !== null && typeof doc === 'object';
  const auth = isObject && doc.auth !== null && typeof doc.auth === 'object' ? doc.auth : null;
  const hasApiKey =
    auth !== null &&
    typeof auth.api_key === 'string';
  const basic = auth !== null && auth.basic !== null && typeof auth.basic === 'object' ? auth.basic : null;
  const hasBasic = hasUsableBasicCredential(basic);
  const hasAppliesTo =
    isObject && doc.applies_to !== undefined && doc.applies_to !== null;
  return { hasApiKey, hasBasic, hasAppliesTo };
}

function lint(dir = TEST_KITS_DIR) {
  const violations = [];
  if (!fs.existsSync(dir)) return violations;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
    const full = path.join(dir, entry.name);
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const { hasApiKey, hasBasic, hasAppliesTo } = classify(doc);
    if (!hasApiKey && !hasBasic && !hasAppliesTo) {
      violations.push({
        file: path.relative(dir, full),
        rule: 'kit_shape_unclassified',
      });
    }
  }
  return violations;
}

function main() {
  const violations = lint();
  if (violations.length === 0) {
    console.log('✓ storyboard test-kits lint: every kit carries auth.api_key, auth.basic, or applies_to');
    return;
  }
  console.error(`✗ storyboard test-kits lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    const msg = RULE_MESSAGES[v.rule] ? RULE_MESSAGES[v.rule]() : v.rule;
    console.error(`  test-kits/${v.file} (${v.rule})`);
    console.error(`    ${msg}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = { RULE_MESSAGES, classify, lint };
