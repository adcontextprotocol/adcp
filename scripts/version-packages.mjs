#!/usr/bin/env node

/**
 * Select the one exceptional 3.2 beta -> rc.0 versioning path, otherwise
 * delegate unchanged to Changesets. Artifact generation and signing remain in
 * the package `version` script so both paths use the same trusted workflow.
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionPreparedRc } from './promote-release-candidate.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const marker = resolve(root, '.changeset/rc-promotion.json');
const supersessionMarker = resolve(root, '.changeset/release-supersession.json');

function runChangesetsVersion() {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(npx, ['--no-install', 'changeset', 'version'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`changeset version failed with status ${result.status ?? 'unknown'}.`);
  }
}

if (existsSync(marker)) {
  versionPreparedRc(root);
} else {
  if (existsSync(supersessionMarker)) {
    const verification = spawnSync(
      process.execPath,
      ['scripts/check-release-supersession.cjs', 'verify'],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    if (verification.status !== 0) {
      throw new Error(
        `release supersession verification failed with status ${verification.status ?? 'unknown'}.`,
      );
    }
  }
  runChangesetsVersion();
  if (existsSync(supersessionMarker)) {
    rmSync(supersessionMarker);
  }
}
