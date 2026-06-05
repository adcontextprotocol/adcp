#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIST_SCHEMAS_DIR = path.join(__dirname, '../dist/schemas');

function walkJsonFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

test('dist schema roots do not contain unversioned AdCP $id/$ref values', () => {
  const failures = [];
  for (const version of fs.readdirSync(DIST_SCHEMAS_DIR)) {
    if (version === 'latest') continue;
    const versionDir = path.join(DIST_SCHEMAS_DIR, version);
    if (!fs.statSync(versionDir).isDirectory()) continue;
    for (const file of walkJsonFiles(versionDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/"\$(?:id|ref)"\s*:\s*"\/schemas\/([^/]+)\/[^"]*"/g)) {
        const [, actualVersion] = match;
        if (actualVersion !== version) {
          failures.push(`${path.relative(path.join(__dirname, '..'), file)}: ${match[0]}`);
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});
