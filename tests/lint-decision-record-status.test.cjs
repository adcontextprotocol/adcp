#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  lintDecisionRecordStatus,
  readAllowedStatuses,
} = require('../scripts/lint-decision-record-status.cjs');

const README = [
  '# Decision Records',
  '',
  '```markdown',
  '---',
  'id: DR-NNNN',
  'status: proposed | recorded | ratified | superseded',
  '---',
  '```',
  '',
].join('\n');

function record(status) {
  const statusLine = status === undefined ? '' : `status: ${status}\n`;
  return `---\nid: DR-0001\ntitle: A ruling\n${statusLine}date: 2026-11-08\n---\n\n## Decision\n`;
}

function withFixture(files, callback) {
  const decisionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-record-status-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(decisionsDir, name), text);
    }
    callback(lintDecisionRecordStatus({ decisionsDir }));
  } finally {
    fs.rmSync(decisionsDir, { recursive: true, force: true });
  }
}

test('every record in the repository uses a status the README lists', () => {
  const result = lintDecisionRecordStatus();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.records.length > 0);
});

test('reads the allowed statuses from the README format block', () => {
  assert.deepEqual(readAllowedStatuses(README), ['proposed', 'recorded', 'ratified', 'superseded']);
  assert.equal(readAllowedStatuses('# Decision Records\n\nNo format block.\n'), null);
});

test('accepts every listed status', () => {
  withFixture({
    'README.md': README,
    'DR-0001-a.md': record('proposed'),
    'DR-0002-b.md': record('recorded'),
    'DR-0003-c.md': record('ratified'),
    'DR-0004-d.md': record('superseded'),
  }, (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.records.length, 4);
  });
});

test('rejects a status the README does not list', () => {
  withFixture({ 'README.md': README, 'DR-0001-a.md': record('accepted') }, (result) => {
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      'DR-0001-a.md: status "accepted" is not one of proposed, recorded, ratified, superseded (governance/decisions/README.md)',
    ]);
  });
});

test('rejects a record with no status, a repeated status, or no frontmatter', () => {
  withFixture({
    'README.md': README,
    'DR-0001-a.md': record(undefined),
    'DR-0002-b.md': record('ratified').replace('date:', 'status: ratified\ndate:'),
    'DR-0003-c.md': '## Decision\n\nstatus: ratified\n',
  }, (result) => {
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      'DR-0001-a.md: no status in frontmatter',
      'DR-0002-b.md: status appears 2 times in frontmatter',
      'DR-0003-c.md: no frontmatter',
    ]);
  });
});

test('ignores a status line outside the frontmatter', () => {
  withFixture({
    'README.md': README,
    'DR-0001-a.md': `${record('ratified')}\nstatus: accepted\n`,
  }, (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

test('fails closed when the README lists no statuses', () => {
  withFixture({ 'README.md': '# Decision Records\n', 'DR-0001-a.md': record('accepted') }, (result) => {
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['README.md format block has no "status:" line listing the allowed values']);
  });
});
