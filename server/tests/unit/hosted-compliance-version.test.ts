import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { withServedReleaseSchemaRoots } from '@adcp/sdk/testing';
import {
  DEFAULT_HOSTED_COMPLIANCE_VERSION,
  hostedComplianceTarget,
  hostedSchemaRoot,
  hostedServedReleaseSchemaRoots,
  resolveHostedComplianceVersion,
  withHostedComplianceRunOptions,
  withHostedStoryboardRunOptions,
} from '../../src/services/hosted-compliance-version.js';

type HostedComplianceVersionModule = typeof import('../../src/services/hosted-compliance-version.js');

describe('resolveHostedComplianceVersion', () => {
  it('resolves the 3.1 line to a stable build, not a prerelease', () => {
    // Not pinned to an exact patch: new 3.1.x releases land regularly, and
    // this is a regression guard for #7356, not a version-pin test.
    expect(resolveHostedComplianceVersion('3.1')).toMatch(/^3\.1\.\d+$/);
  });

  it('resolves the default 3.0 line to the module-level default version', () => {
    expect(resolveHostedComplianceVersion('3.0')).toBe(DEFAULT_HOSTED_COMPLIANCE_VERSION);
  });

  describe('for a non-default line that has published RC builds but no stable build', () => {
    // Regression guard for #7356. Real release lines gain stable builds over
    // time (3.2 did with 3.2.1), so the RC-only line lives in an isolated
    // fixture tree instead of depending on the repo's current release state.
    const RC_ONLY_LINE = '3.3';
    const RC_ONLY_VERSION = '3.3.0-rc.1';
    const DEFAULT_LINE_STABLE_VERSION = '3.0.1';
    let fixtureRoot: string;
    let fixtureModule: HostedComplianceVersionModule;

    beforeAll(async () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'hosted-compliance-version-'));
      mkdirSync(join(fixtureRoot, 'static', 'compliance'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'static', 'compliance', 'published-versions.json'),
        JSON.stringify({
          schema_version: 1,
          published_versions: [DEFAULT_LINE_STABLE_VERSION, RC_ONLY_VERSION],
        }),
      );
      for (const version of [DEFAULT_LINE_STABLE_VERSION, RC_ONLY_VERSION]) {
        const dir = join(fixtureRoot, 'dist', 'compliance', version);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.json'), '{}');
      }

      // The resolver reads published-versions.json at import time and
      // dist/compliance on each call, both relative to process.cwd().
      vi.spyOn(process, 'cwd').mockReturnValue(fixtureRoot);
      vi.resetModules();
      fixtureModule = await import('../../src/services/hosted-compliance-version.js');
    });

    afterAll(() => {
      vi.restoreAllMocks();
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('has a resolvable RC build, so the bare-line case below is not vacuous', () => {
      expect(fixtureModule.DEFAULT_HOSTED_COMPLIANCE_VERSION).toBe(DEFAULT_LINE_STABLE_VERSION);
      expect(fixtureModule.resolveHostedComplianceVersion(`${RC_ONLY_LINE}-rc`)).toBe(RC_ONLY_VERSION);
    });

    it('throws rather than silently substituting the RC for the bare line alias', () => {
      // A bare line alias must throw here, not silently resolve to a
      // pre-release that callers (badge eligibility, an explicit
      // compliance_target: "3.3") would treat as if it were the stable
      // release for that line.
      expect(() => fixtureModule.resolveHostedComplianceVersion(RC_ONLY_LINE)).toThrow(
        /No npm-published compliance version is registered for 3\.3/,
      );
    });
  });
});

describe('hostedServedReleaseSchemaRoots', () => {
  it('maps each other hosted line in the major to its hosted schema bundle', () => {
    const target = hostedComplianceTarget('3.0');
    const v31 = resolveHostedComplianceVersion('3.1');
    const v32 = resolveHostedComplianceVersion('3.2');

    expect(hostedServedReleaseSchemaRoots(target.version)).toEqual({
      [v32]: hostedSchemaRoot(v32),
      [v31]: hostedSchemaRoot(v31),
    });
  });

  it('skips the target release itself', () => {
    const v32 = resolveHostedComplianceVersion('3.2');
    const roots = hostedServedReleaseSchemaRoots(v32);

    expect(Object.keys(roots)).not.toContain(v32);
    expect(Object.keys(roots)).toEqual(
      expect.arrayContaining([resolveHostedComplianceVersion('3.1'), DEFAULT_HOSTED_COMPLIANCE_VERSION]),
    );
  });

  it('has no entries for a target in another major', () => {
    expect(hostedServedReleaseSchemaRoots('2.5.3')).toEqual({});
  });

  it('is a map the SDK accepts: every root matches its release', () => {
    for (const line of ['3.0', '3.1', '3.2']) {
      const roots = hostedServedReleaseSchemaRoots(resolveHostedComplianceVersion(line));
      expect(Object.keys(roots).length).toBeGreaterThan(0);
      expect(withServedReleaseSchemaRoots(roots, () => 'ran')).toBe('ran');
    }
  });

  describe('when a hosted release has no schema bundle', () => {
    let fixtureRoot: string;
    let fixtureModule: HostedComplianceVersionModule;

    beforeAll(async () => {
      fixtureRoot = mkdtempSync(join(tmpdir(), 'hosted-served-release-roots-'));
      mkdirSync(join(fixtureRoot, 'static', 'compliance'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'static', 'compliance', 'published-versions.json'),
        JSON.stringify({ schema_version: 1, published_versions: ['3.0.1', '3.1.1', '3.2.1'] }),
      );
      for (const version of ['3.0.1', '3.1.1', '3.2.1']) {
        const dir = join(fixtureRoot, 'dist', 'compliance', version);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.json'), '{}');
      }
      // 3.1.1 has a compliance cache but no hosted schema bundle.
      for (const version of ['3.0.1', '3.2.1']) {
        mkdirSync(join(fixtureRoot, 'dist', 'schemas', version, 'bundled'), { recursive: true });
      }

      vi.spyOn(process, 'cwd').mockReturnValue(fixtureRoot);
      vi.resetModules();
      fixtureModule = await import('../../src/services/hosted-compliance-version.js');
    });

    afterAll(() => {
      vi.restoreAllMocks();
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('leaves that release out', () => {
      expect(fixtureModule.resolveHostedComplianceVersion('3.1')).toBe('3.1.1');
      expect(fixtureModule.hostedServedReleaseSchemaRoots('3.0.1')).toEqual({
        '3.2.1': join(fixtureRoot, 'dist', 'schemas', '3.2.1'),
      });
    });
  });
});

describe('hosted run options register the served-release schema roots', () => {
  const target = hostedComplianceTarget('3.0');

  it('sets them for comply()', () => {
    const options = withHostedComplianceRunOptions({}, target);
    expect(options.schemaRoot).toBe(target.schemaRoot);
    expect(options.servedReleaseSchemaRoots).toEqual(hostedServedReleaseSchemaRoots(target.version));
  });

  it('sets the same map for storyboard and step re-runs', () => {
    const options = withHostedStoryboardRunOptions({}, target);
    expect(options.schemaRoot).toBe(target.schemaRoot);
    expect(options.servedReleaseSchemaRoots).toEqual(hostedServedReleaseSchemaRoots(target.version));
  });

  it('keeps a caller-supplied map', () => {
    const custom = { '3.2.1': '/custom/3.2.1' };
    expect(withHostedComplianceRunOptions({ servedReleaseSchemaRoots: custom }, target).servedReleaseSchemaRoots)
      .toBe(custom);
    expect(withHostedStoryboardRunOptions({ servedReleaseSchemaRoots: custom }, target).servedReleaseSchemaRoots)
      .toBe(custom);
  });
});
