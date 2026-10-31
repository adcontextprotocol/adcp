#!/usr/bin/env node
// Publishes the older extension versions that the tests and storyboards pin, generated from the
// current package sources, so the registry's version history is reproducible rather than hand-kept.
//
//   npm run registry:reset   # build-extensions --clean-registry, then this script
//
// Each fixture is the current package (schema, spec, storyboards, reference code) with its
// manifest version set to an earlier number and its changelog cut to the entries up to that
// number. A fixture may also drop hooks: seller-adjustable-terms 1.0.0 has no media_buy_state
// readback, so a buyer pinned to it gets allowances only, and makegood-units before 1.4.0 has no
// request_makegood task. Every fixture has its own digest.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, coreRelease, extensionPackages, publish, writeRegistryIndex } from './build-extensions.mjs';
import { compareVersions } from '../lib/compat.mjs';

/** name -> fixtures, oldest first. `drop` removes hooks (extends entries and requires.points). */
export const HISTORY = {
  'seller-adjustable-terms': [{ version: '1.0.0', drop: ['media_buy_state'] }, { version: '1.1.0' }, { version: '1.2.0' }, { version: '1.3.0' }, { version: '1.4.0' }, { version: '1.5.0' }],
  'makegood-units': [...['1.0.0', '1.1.0', '1.2.0', '1.3.0'].map((version) => ({ version, drop: ['task'] })), { version: '1.4.0' }],
  'linear-tv-indexed-cpp': [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '1.2.0' }, { version: '1.3.0' }, { version: '1.4.0' }],
  'rate-card-index': [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '1.2.0' }, { version: '1.3.0' }, { version: '1.4.0' }],
  'daypart-codes': [{ version: '2.2.0' }, { version: '2.3.0' }, { version: '2.4.0' }, { version: '2.5.0' }],
};

export function fixtureManifest(manifest, { version, drop = [] }) {
  const m = structuredClone(manifest);
  m.version = version;
  m.extends = m.extends.filter((e) => !drop.includes(e.point));
  for (const point of drop) delete m.requires?.points?.[point];
  m.changelog = (m.changelog ?? []).filter((c) => compareVersions(c.version, version) <= 0);
  return m;
}

export function publishHistory() {
  const release = coreRelease();
  const published = [];
  for (const dir of extensionPackages()) {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'extension.json'), 'utf8'));
    for (const fixture of HISTORY[manifest.name] ?? []) {
      const tmp = mkdtempSync(path.join(tmpdir(), 'adcp-history-'));
      try {
        cpSync(dir, tmp, { recursive: true });
        writeFileSync(path.join(tmp, 'extension.json'), JSON.stringify(fixtureManifest(manifest, fixture), null, 2) + '\n');
        const built = buildBundle(tmp, release);
        publish(built);
        published.push(`${manifest.name}@${fixture.version} ${built.digest.slice(0, 19)}...${fixture.drop ? ` (without ${fixture.drop.join(', ')})` : ''}`);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    writeRegistryIndex(manifest.id);
  }
  return published;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const line of publishHistory()) console.log(line);
}
