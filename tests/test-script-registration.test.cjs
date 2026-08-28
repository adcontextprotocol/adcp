#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('new root CJS suites are registered by a test script', () => {
  const root = path.resolve(__dirname, '..');
  const scripts = Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts)
    .filter(([name]) => name === 'test' || name.startsWith('test:'))
    .map(([, command]) => command)
    .join('\n');
  const added = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=A', 'origin/main...HEAD', '--', 'tests/*.test.cjs'],
    { cwd: root, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  const unregistered = added.filter(file => !scripts.includes(file) && !scripts.includes(path.basename(file)));
  assert.deepEqual(unregistered, [], `new CJS test suites are not registered in package.json: ${unregistered.join(', ')}`);
});
