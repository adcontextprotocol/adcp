#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?$/;

function collectFiles(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(filename, files);
    else if (entry.isFile()) files.push(filename);
  }
}

// Image assembly only: never regenerate, rewrite, or remove release content.
// Only immutable snapshots participate; latest and symlinks are left alone.
function deduplicateRuntimeArtifacts(distDirectory) {
  const files = [];
  for (const tree of ['schemas', 'compliance', 'docs']) {
    const directory = path.join(distDirectory, tree);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && RELEASE_VERSION.test(entry.name)) {
        collectFiles(path.join(directory, entry.name), files);
      }
    }
  }

  // Different lengths or permission bits cannot share storage. Hash only the
  // groups with potential duplicates, and confirm bytes before linking them.
  const candidates = new Map();
  for (const filename of files.sort()) {
    const stat = fs.statSync(filename);
    const key = `${stat.size}:${stat.mode}:${stat.uid}:${stat.gid}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(filename);
  }

  let linkedFiles = 0;
  let savedBytes = 0;
  for (const group of candidates.values()) {
    if (group.length < 2) continue;
    const originals = new Map();
    for (const filename of group) {
      const content = fs.readFileSync(filename);
      const hash = createHash('sha256').update(content).digest('hex');
      const original = originals.get(hash);
      if (!original) {
        originals.set(hash, filename);
        continue;
      }
      const stat = fs.statSync(filename);
      const originalStat = fs.statSync(original);
      if (stat.dev === originalStat.dev && stat.ino === originalStat.ino) continue;
      if (!content.equals(fs.readFileSync(original))) {
        throw new Error(`Artifact hash collision: ${filename}`);
      }

      // Create the replacement before an atomic rename. A failed link leaves
      // the published path intact and makes the image build fail closed.
      const temporary = `${filename}.dedup-${process.pid}`;
      fs.linkSync(original, temporary);
      try {
        fs.renameSync(temporary, filename);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      linkedFiles += 1;
      savedBytes += stat.size;
    }
  }
  return { scannedFiles: files.length, linkedFiles, savedBytes };
}

if (require.main === module) {
  console.log(JSON.stringify(deduplicateRuntimeArtifacts(path.resolve(__dirname, '../dist'))));
}

module.exports = { deduplicateRuntimeArtifacts };
