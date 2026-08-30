#!/usr/bin/env node

/**
 * Select the one exceptional 3.2 beta -> rc.0 versioning path, otherwise
 * delegate unchanged to Changesets. Artifact generation and signing remain in
 * the package `version` script so both paths use the same trusted workflow.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionPreparedRc } from './promote-release-candidate.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const marker = resolve(root, '.changeset/rc-promotion.json');

if (existsSync(marker)) {
  versionPreparedRc(root);
} else {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(npx, ['--no-install', 'changeset', 'version'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`changeset version failed with status ${result.status ?? 'unknown'}.`);
  }
}
