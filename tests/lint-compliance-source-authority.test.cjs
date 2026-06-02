#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lintBuiltMirror,
  lintSourceAuthority,
} = require('../scripts/lint-compliance-source-authority.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-source-authority-'));
}

function writeFile(root, rel, body = '') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function makeMinimalSource(root) {
  for (const dir of ['protocols', 'specialisms', 'test-kits', 'test-vectors', 'universal']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFile(
    root,
    'universal/capability-discovery.yaml',
    `
id: capability_discovery
phases:
  - id: discover
    steps: []
`,
  );
}

function writeMinimalIndex(root, overrides = {}) {
  writeFile(
    root,
    'index.json',
    JSON.stringify({
      universal: ['capability-discovery'],
      protocols: [],
      specialisms: [],
      ...overrides,
    }, null, 2) + '\n',
  );
}

test('real compliance source passes source-authority lint', () => {
  assert.deepEqual(lintSourceAuthority(), []);
});

test('source-authority lint rejects generated cache artifacts in source', () => {
  const tmp = makeTempDir();
  try {
    makeMinimalSource(tmp);
    fs.mkdirSync(path.join(tmp, 'domains'));
    writeFile(tmp, 'index.json', '{}\n');

    const rules = lintSourceAuthority({ sourceDir: tmp }).map((violation) => violation.rule).sort();
    assert.deepEqual(rules, ['generated_artifact_in_source', 'generated_artifact_in_source']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('source-authority lint rejects unknown top-level entries', () => {
  const tmp = makeTempDir();
  try {
    makeMinimalSource(tmp);
    writeFile(tmp, 'storyboards/extra.yaml', 'id: extra\n');

    const rules = lintSourceAuthority({ sourceDir: tmp }).map((violation) => violation.rule);
    assert.deepEqual(rules, ['unknown_top_level']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('built mirror lint accepts a generated bundle that mirrors canonical source', () => {
  const source = makeTempDir();
  const target = makeTempDir();
  try {
    makeMinimalSource(source);
    fs.cpSync(source, target, { recursive: true });
    fs.cpSync(path.join(target, 'protocols'), path.join(target, 'domains'), { recursive: true });
    writeMinimalIndex(target);

    assert.deepEqual(lintBuiltMirror({ sourceDir: source, targetDir: target }), []);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('built mirror lint catches missing, stale, and changed files', () => {
  const source = makeTempDir();
  const target = makeTempDir();
  try {
    makeMinimalSource(source);
    fs.cpSync(source, target, { recursive: true });
    fs.cpSync(path.join(target, 'protocols'), path.join(target, 'domains'), { recursive: true });
    writeMinimalIndex(target);

    fs.rmSync(path.join(target, 'universal/capability-discovery.yaml'));
    writeFile(target, 'universal/stale.yaml', 'id: stale\n');
    writeFile(target, 'protocols/index.yaml', 'changed\n');
    writeFile(source, 'protocols/index.yaml', 'source\n');

    const rules = lintBuiltMirror({ sourceDir: source, targetDir: target })
      .map((violation) => violation.rule)
      .sort();

    assert.deepEqual(rules, [
      'domains_alias_drift',
      'mirror_content_drift',
      'missing_in_mirror',
      'stale_in_mirror',
    ]);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('built mirror lint catches stale index membership', () => {
  const source = makeTempDir();
  const target = makeTempDir();
  try {
    makeMinimalSource(source);
    fs.cpSync(source, target, { recursive: true });
    fs.cpSync(path.join(target, 'protocols'), path.join(target, 'domains'), { recursive: true });
    writeMinimalIndex(target, { universal: [] });

    const violations = lintBuiltMirror({ sourceDir: source, targetDir: target });
    assert.deepEqual(
      violations.map((violation) => violation.rule),
      ['index_membership_drift'],
    );
    assert.equal(violations[0].field, 'universal');
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
