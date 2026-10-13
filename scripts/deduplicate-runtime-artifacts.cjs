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

function snapshot(filename) {
  // Open first: metadata and content must describe the same inode, even if a
  // path changes after directory enumeration. Never follow a substituted link.
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Artifact is not a regular file: ${filename}`);
    return { stat, content: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
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

  const originals = new Map();
  let linkedFiles = 0;
  let savedBytes = 0;
  for (const filename of files.sort()) {
    const { stat, content } = snapshot(filename);
    const hash = createHash('sha256').update(content).digest('hex');
    // Permission bits and ownership must also match before storage is shared.
    const key = `${content.length}:${stat.mode}:${stat.uid}:${stat.gid}:${hash}`;
    const original = originals.get(key);
    if (!original) {
      originals.set(key, { filename, stat });
      continue;
    }
    if (stat.dev === original.stat.dev && stat.ino === original.stat.ino) continue;

    // Validate the actual newly created link, not the original pathname before
    // link creation. A substitution or hash collision must fail before rename.
    const temporary = `${filename}.dedup-${process.pid}`;
    fs.linkSync(original.filename, temporary);
    try {
      const linked = snapshot(temporary);
      if (!content.equals(linked.content) || linked.stat.mode !== stat.mode ||
          linked.stat.uid !== stat.uid || linked.stat.gid !== stat.gid) {
        throw new Error(`Artifact changed before link verification: ${filename}`);
      }
      fs.renameSync(temporary, filename);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    linkedFiles += 1;
    savedBytes += content.length;
  }
  return { scannedFiles: files.length, linkedFiles, savedBytes };
}

if (require.main === module) {
  console.log(JSON.stringify(deduplicateRuntimeArtifacts(path.resolve(__dirname, '../dist'))));
}

module.exports = { deduplicateRuntimeArtifacts };
