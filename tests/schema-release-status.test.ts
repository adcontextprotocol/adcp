import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildRootSchemaDiscovery,
  getReleaseMetadata,
  isSelectableRelease,
} = require('../scripts/build-schemas.cjs');

describe('curated stable release docs', () => {
  // Reviewed tag-owned sets: 341 files per tag, reconstructed with release link
  // rewrites. These exclude the 43 main-only pages in #7448/#7505's snapshots.
  // Each digest covers sorted [relative path, file SHA-256] pairs, so added
  // pages, omissions, and byte changes all fail without relying on Git in CI.
  it.each([
    ['3.1.22', 'ff417575ee56dda4dc95c5da3e7b7c891532a244510676313842d486936d4b26'],
    ['3.1.23', '67f0fe280aa5545d1ff2266481c59453c7df521e50201adb18aa4f093eabe80e'],
  ])('preserves the exact tag-owned %s docs snapshot', (version, expectedDigest) => {
    const root = fileURLToPath(new URL(`../dist/docs/${version}/`, import.meta.url));
    const paths = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
      .flatMap(entry => entry.isDirectory()
        ? paths(join(directory, entry.name)).map(child => `${entry.name}/${child}`)
        : [entry.name]);
    const files = paths(root).sort();
    const records = files.map(path => [
      path,
      createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
    ]);

    expect(files).toHaveLength(341);
    expect(createHash('sha256').update(JSON.stringify(records)).digest('hex')).toBe(expectedDigest);
  });
});

describe('schema release discovery status', () => {
  it('keeps committed discovery complete and selectors aligned with immutable releases', () => {
    const discovery = buildRootSchemaDiscovery();
    const readDiscovery = (name: string) => JSON.parse(readFileSync(
      new URL(`../dist/schemas/${name}.json`, import.meta.url), 'utf8',
    ));

    expect(readDiscovery('index')).toEqual(discovery);
    expect(readDiscovery('latest')).toEqual({
      latest: discovery.latest_stable,
      latest_stable: discovery.latest_stable,
      channel: 'stable',
      path: `/schemas/${discovery.latest_stable}/`,
      index: `/schemas/${discovery.latest_stable}/index.json`,
    });
  });

  it('keeps withdrawn and unpublished releases exact-addressable but non-selectable', () => {
    expect(isSelectableRelease('3.1.3')).toBe(false);
    expect(getReleaseMetadata('3.1.3')).toEqual({
      stability: 'withdrawn',
      prerelease: false,
      deprecated: true,
      withdrawn: true,
    });

    expect(isSelectableRelease('3.2.0')).toBe(false);
    expect(getReleaseMetadata('3.2.0')).toEqual({
      stability: 'unpublished',
      prerelease: false,
      deprecated: false,
      published: false,
    });
  });

  it('marks v2 releases deprecated without removing them from aliases', () => {
    expect(isSelectableRelease('2.5.3')).toBe(true);
    expect(getReleaseMetadata('2.5.3')).toEqual({
      stability: 'stable',
      prerelease: false,
      deprecated: true,
    });

    const discovery = buildRootSchemaDiscovery();
    expect(discovery.aliases.v2).toBe('2.5.3');
    expect(discovery.aliases['v2.5']).toBe('2.5.3');
    expect(discovery.versions.find(({ version }: { version: string }) => version === '2.5.3'))
      .toMatchObject({ deprecated: true });
  });

  it('excludes non-selectable versions from stable aliases and latest', () => {
    const discovery = buildRootSchemaDiscovery();
    const withdrawn = discovery.versions.find(({ version }: { version: string }) => version === '3.1.3');
    const aliasTargets = Object.values(discovery.aliases);

    expect(['3.1.3', '3.2.0']).not.toContain(discovery.latest_stable);
    expect(aliasTargets).not.toContain('3.1.3');
    expect(aliasTargets).not.toContain('3.2.0');
    expect(withdrawn).toMatchObject({
      stability: 'withdrawn',
      deprecated: true,
      withdrawn: true,
    });
  });
});
