#!/usr/bin/env node
'use strict';

// Owned, temporary SDK bridge; see .agents/sdk-shim-ledger.json. Apply only
// reviewed 15.9.5 preimages, never a newer runner bundle or an approximate edit.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const patchRoot = path.resolve(__dirname, '../patches/sdk-creative-build-probe');
const manifest = JSON.parse(fs.readFileSync(path.join(patchRoot, 'manifest.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const helperPayloads = new Set(['creative-build-probe.js', 'creative-build-probe.mjs', 'creative-build-probe.d.ts', 'creative-build-probe.d.mts']);

function install(packageRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (pkg.name !== manifest.package || pkg.version !== manifest.version) {
    throw new Error(`Creative build probe bridge requires ${manifest.package}@${manifest.version}; got ${pkg.name}@${pkg.version}. Qualify the upstream replacement before removing this bridge.`);
  }
  // Validate every target and every prospective output before any write.
  const staged = manifest.files.map(entry => {
    if (!(entry.path === 'bin/adcp.js' || entry.path.startsWith('dist/lib/testing/storyboard/') || /^dist\/lib\/testing\/index\.(js|mjs|d\.ts|d\.mts)$/.test(entry.path)) || entry.path.includes('..')) {
      throw new Error('Invalid SDK bridge target');
    }
    if (entry.contents_file !== undefined && (!helperPayloads.has(entry.contents_file) || !entry.path.endsWith('/' + entry.contents_file))) {
      throw new Error('Invalid SDK bridge contents_file');
    }
    const file = path.join(packageRoot, entry.path);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const hash = before === null ? null : digest(before);
    if (hash === entry.after) return { file, done: true };
    if (hash !== entry.before) throw new Error(`SDK bridge content drift: ${entry.path}`);
    let after = entry.contents_file
      ? fs.readFileSync(path.join(patchRoot, entry.contents_file), 'utf8')
      : before;
    for (const edit of entry.replacements ?? []) {
      if (after.split(edit.from).length !== 2) throw new Error(`SDK bridge anchor drift: ${entry.path}`);
      after = after.replace(edit.from, () => edit.to);
    }
    if (digest(after) !== entry.after) throw new Error(`SDK bridge output drift: ${entry.path}`);
    return { file, done: false, after };
  });
  const done = staged.filter(entry => entry.done).length;
  if (done && done !== staged.length) throw new Error('SDK bridge has mixed original/patched targets; reinstall dependencies');
  if (done === staged.length) return;
  for (const entry of staged) fs.writeFileSync(entry.file, entry.after);
}

if (require.main === module) {
  // Resolve the package root through the public entry, then verify its identity.
  const entry = require.resolve('@adcp/sdk/testing');
  const packageRoot = path.resolve(entry, '../../../..');
  install(packageRoot);
}

module.exports = { install };
