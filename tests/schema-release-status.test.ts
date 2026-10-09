import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import * as middleware from '../server/src/schemas-middleware.js';
import * as worker from '../workers/artifact-cdn/src/index.js';

const require = createRequire(import.meta.url);
const {
  buildRootSchemaDiscovery,
  getReleaseMetadata,
  isSelectableRelease,
  RELEASE_STATUS_OVERRIDES,
  supersedingStableVersion,
} = require('../scripts/build-schemas.cjs');

describe('schema release discovery status', () => {
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

    expect(isSelectableRelease('3.2.0-rc.5')).toBe(false);
    expect(getReleaseMetadata('3.2.0-rc.5')).toEqual({
      stability: 'unpublished',
      prerelease: true,
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

    expect(['3.1.3', '3.2.0', '3.2.0-rc.5']).not.toContain(discovery.latest_stable);
    expect(aliasTargets).not.toContain('3.1.3');
    expect(aliasTargets).not.toContain('3.2.0');
    expect(aliasTargets).not.toContain('3.2.0-rc.5');
    expect(withdrawn).toMatchObject({
      stability: 'withdrawn',
      deprecated: true,
      withdrawn: true,
    });
  });
});

describe('withdrawn 3.2.0 and the 3.2.1 GA', () => {
  it('keeps release status overrides identical across build, server, and CDN worker', () => {
    const sorted = (entries: Iterable<[string, string]>) =>
      [...entries].sort(([a], [b]) => a.localeCompare(b));
    const build = sorted(RELEASE_STATUS_OVERRIDES);

    expect(build).toEqual([
      ['3.1.3', 'withdrawn'],
      ['3.2.0', 'unpublished'],
      ['3.2.0-rc.5', 'unpublished'],
    ]);
    expect(sorted(worker.releaseStatusOverrides())).toEqual(build);
    expect(sorted(middleware.RELEASE_STATUS_OVERRIDES)).toEqual(build);
  });

  it('never lets an unpublished stable number supersede its release candidates', () => {
    const known = ['3.2.0', '3.2.0-rc.7', '3.2.0-rc.5', '3.1.24'];
    expect(supersedingStableVersion('3.2.0-rc.7', known)).toBeUndefined();
    expect(getReleaseMetadata('3.2.0-rc.7', known)).toEqual({
      stability: 'rc',
      prerelease: true,
      deprecated: false,
    });
  });

  it('derives superseded_by from the first selectable stable release on the minor line', () => {
    const known = ['3.2.2', '3.2.1', '3.2.0', '3.2.0-rc.7', '3.2.0-beta.11', '3.3.0', '3.1.0', '3.1.0-rc.15'];
    expect(supersedingStableVersion('3.2.0-rc.7', known)).toBe('3.2.1');
    expect(getReleaseMetadata('3.2.0-rc.7', known)).toEqual({
      stability: 'rc',
      prerelease: true,
      deprecated: true,
      superseded_by: '3.2.1',
    });
    expect(getReleaseMetadata('3.2.0-beta.11', known)).toMatchObject({ superseded_by: '3.2.1' });
    // Unchanged for lines without a withdrawn number.
    expect(supersedingStableVersion('3.1.0-rc.15', known)).toBe('3.1.0');
  });

  it('lets 3.2.1 win latest_stable, v3, and v3.2 across every alias resolver', () => {
    const versions = ['3.2.1', '3.2.0', '3.2.0-rc.7', '3.1.24', '3.1.3'];
    const withoutGa = versions.filter((version) => version !== '3.2.1');

    for (const isSelectable of [isSelectableRelease, worker.isSelectableRelease, middleware.isSelectableRelease]) {
      expect(isSelectable('3.2.0')).toBe(false);
      expect(isSelectable('3.2.1')).toBe(true);
    }
    for (const find of [worker.findMatchingVersion, middleware.findMatchingVersion]) {
      expect(find(versions, 3)).toBe('3.2.1');
      expect(find(versions, 3, 2)).toBe('3.2.1');
      expect(find(withoutGa, 3, 2)).toBeUndefined();
      expect(find(withoutGa, 3)).toBe('3.1.24');
    }
    for (const fallback of [worker.resolvePinnedFallback, middleware.resolvePinnedFallback]) {
      expect(fallback(['3.2.0', '3.1.24'], '3.2.0')).toBe('3.1.24');
    }
  });
});
