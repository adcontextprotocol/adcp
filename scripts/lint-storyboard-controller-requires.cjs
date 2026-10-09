#!/usr/bin/env node
/**
 * Reject storyboards that set `prerequisites.controller_seeding: true`
 * without declaring `requires: [controller]`.
 *
 * Why this lint exists
 * --------------------
 * A storyboard that seeds fixtures through `comply_test_controller` cannot
 * run against a seller that has no test controller. Without the
 * storyboard-level `requires: [controller]` gate, the runner grades every
 * seeded step `missing_test_controller` — dozens of identical lines per
 * storyboard that bury real results. With the gate, the runner emits one
 * `requirement_unmet` skip at load time. A controller that disappears
 * mid-run still grades per step.
 *
 * Rules:
 *
 *   controller_seeding_without_requires_controller
 *       `prerequisites.controller_seeding` is true but the top-level
 *       `requires` list does not include `controller`. Add `controller` to
 *       `requires` (append to the existing list if the storyboard already
 *       gates on other values, such as `multi_agent`).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'static', 'compliance', 'source');

const RULE_MESSAGES = {
  controller_seeding_without_requires_controller: () =>
    'prerequisites.controller_seeding is true but `requires` does not include ' +
    '`controller`. A seller without a test controller would be graded ' +
    '`missing_test_controller` on every seeded step instead of receiving one ' +
    'storyboard-level `requirement_unmet` skip. Add `requires: [controller]` ' +
    '(append `controller` if `requires` already lists other values). See ' +
    'static/compliance/source/universal/storyboard-schema.yaml > "requires".',
};

function lint(sourceDir = SOURCE_DIR) {
  const violations = [];

  function lintFile(p) {
    const rel = path.relative(sourceDir, p);
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(p, 'utf8'));
    } catch {
      return;
    }
    if (!doc || typeof doc !== 'object') return;
    if (!doc.prerequisites || doc.prerequisites.controller_seeding !== true) return;
    if (Array.isArray(doc.requires) && doc.requires.includes('controller')) return;
    violations.push({
      file: rel,
      id: doc.id,
      rule: 'controller_seeding_without_requires_controller',
    });
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
    console.log('✓ storyboard controller-requires lint: every controller_seeding storyboard declares requires: [controller]');
    return;
  }
  console.error(`✗ storyboard controller-requires lint: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file} (${v.rule})`);
    console.error(`    ${RULE_MESSAGES[v.rule]()}`);
    console.error('');
  }
  process.exit(1);
}

if (require.main === module) main();

module.exports = { RULE_MESSAGES, lint };
