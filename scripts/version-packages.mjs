#!/usr/bin/env node

/**
 * Select the one exceptional 3.2 beta -> rc.0 versioning path, otherwise
 * delegate to Changesets. A reviewed withdrawn-release marker lets the
 * pre-exit cut skip a permanently withdrawn version number. Artifact
 * generation and signing remain in the package `version` script so every path
 * uses the same trusted workflow.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { versionPreparedRc } from './promote-release-candidate.mjs';
import { markerExists as withdrawnMarkerExists, versionWithWithdrawnMarker } from './skip-withdrawn-release.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const marker = resolve(root, '.changeset/rc-promotion.json');
const supersessionMarker = resolve(root, '.changeset/release-supersession.json');
const { isSelectableRelease } = createRequire(import.meta.url)('./build-schemas.cjs');

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

// Never generate a version number that release discovery treats as withdrawn
// or unpublished: its bytes may already be exposed and immutable on the CDN.
function assertSelectableGeneratedVersion() {
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  if (!isSelectableRelease(version)) {
    throw new Error(
      `Changesets generated ${version}, which release discovery marks withdrawn/unpublished. `
      + 'Ship over it with a reviewed .changeset/withdrawn-release.json marker (see RELEASING.md).',
    );
  }
}

if (existsSync(marker)) {
  versionPreparedRc(root);
  assertSelectableGeneratedVersion();
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
  if (withdrawnMarkerExists(root)) {
    await versionWithWithdrawnMarker(root, { runChangesetVersion: runChangesetsVersion });
  } else {
    runChangesetsVersion();
  }
  assertSelectableGeneratedVersion();
  if (existsSync(supersessionMarker)) {
    rmSync(supersessionMarker);
  }
}
