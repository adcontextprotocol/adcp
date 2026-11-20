#!/usr/bin/env node
/**
 * Checks every decision record's frontmatter `status` against the status
 * values listed in governance/decisions/README.md.
 *
 * The allowed values are read from the README's format block
 * (`status: proposed | recorded | ratified | superseded`), so the README stays
 * the single source of truth. A README without that line fails the lint
 * rather than passing every record.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DECISIONS_DIR = path.join(REPO_ROOT, 'governance', 'decisions');
const README_NAME = 'README.md';

function stripComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

/**
 * The status values the README's format block lists, in order, or null when
 * the block has no `status:` line.
 */
function readAllowedStatuses(readmeText) {
  const block = /```markdown\n([\s\S]*?)```/.exec(readmeText);
  if (!block) return null;
  const line = /^status:(.*)$/m.exec(block[1]);
  if (!line) return null;
  const values = stripComment(line[1]).split('|').map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : null;
}

/** The frontmatter lines of a record, or null when it has none. */
function readFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? match[1].split(/\r?\n/) : null;
}

function checkRecord(name, text, allowed) {
  const frontmatter = readFrontmatter(text);
  if (!frontmatter) return [`${name}: no frontmatter`];
  const statuses = frontmatter
    .map((line) => /^status:(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => stripComment(match[1]).replace(/^(['"])(.*)\1$/, '$2'));
  if (statuses.length === 0) return [`${name}: no status in frontmatter`];
  if (statuses.length > 1) return [`${name}: status appears ${statuses.length} times in frontmatter`];
  if (!allowed.includes(statuses[0])) {
    return [`${name}: status "${statuses[0]}" is not one of ${allowed.join(', ')} (governance/decisions/README.md)`];
  }
  return [];
}

function lintDecisionRecordStatus({ decisionsDir = DEFAULT_DECISIONS_DIR } = {}) {
  const readmePath = path.join(decisionsDir, README_NAME);
  if (!fs.existsSync(readmePath)) {
    return { ok: false, allowed: [], records: [], errors: [`missing ${README_NAME} in ${decisionsDir}`] };
  }
  const allowed = readAllowedStatuses(fs.readFileSync(readmePath, 'utf8'));
  if (!allowed) {
    return {
      ok: false,
      allowed: [],
      records: [],
      errors: [`${README_NAME} format block has no "status:" line listing the allowed values`],
    };
  }
  const records = fs.readdirSync(decisionsDir)
    .filter((name) => name.endsWith('.md') && name !== README_NAME)
    .sort();
  const errors = records.flatMap((name) => checkRecord(
    name,
    fs.readFileSync(path.join(decisionsDir, name), 'utf8'),
    allowed,
  ));
  return { ok: errors.length === 0, allowed, records, errors };
}

function main() {
  const result = lintDecisionRecordStatus();
  if (result.ok) {
    console.log(`✓ decision record status lint: ${result.records.length} records, statuses ${result.allowed.join(' | ')}`);
    return;
  }
  console.error(`✗ decision record status lint failed with ${result.errors.length} error(s):\n`);
  result.errors.forEach((error) => console.error(`  - ${error}`));
  process.exitCode = 1;
}

module.exports = {
  checkRecord,
  lintDecisionRecordStatus,
  readAllowedStatuses,
};

if (require.main === module) main();
