#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'addie-tool-inventory-'));

try {
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
    path.join(repoRoot, 'scripts/build-addie-tool-surface-inventory.ts'),
    '--check',
  ], {
    cwd: temporaryDirectory,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  process.stdout.write('✓ Addie tool inventory is independent of the caller working directory.\n');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
