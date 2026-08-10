import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildRootSchemaDiscovery,
  getReleaseMetadata,
  isSelectableRelease,
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
