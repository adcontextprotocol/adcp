import { describe, expect, it } from 'vitest';
import {
  agentAdvertisesBadgeEligibleHostedComplianceTarget,
  badgeEligibleVersionsForHostedComplianceTarget,
  hostedComplianceTarget,
  selectCanonicalHostedComplianceTargetForSupportedVersions,
  selectHostedComplianceTargetForSupportedVersions,
} from '../server/src/services/hosted-compliance-version.js';

function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
  const [bMajor, bMinor, bPatch] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
}

describe('hosted compliance target selection', () => {
  it('grades the 3.2 GA bundle when an agent advertises 3.2 alongside older lines', () => {
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0', '3.1', '3.2']);

    expect(target.requested).toBe('3.2');
    expect(target.version).toMatch(/^3\.2\.[1-9]\d*$/);
    expect(target.version).toBe(hostedComplianceTarget('3.2').version);
  });

  it('grades the 3.2 GA bundle when an agent advertises patch-form 3.2.1', () => {
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.1', '3.2.1']);

    expect(target.requested).toBe('3.2');
    expect(target.version).toBe(hostedComplianceTarget('3.2').version);
  });

  it('prefers the 3.2 GA bundle over a 3.2 prerelease in preferred selection', () => {
    const target = selectHostedComplianceTargetForSupportedVersions(['3.1', '3.2']);

    expect(target.requested).toBe('3.2');
    expect(target.version).not.toContain('-');
  });

  // The v3.3.0 Version Packages PR registers 3.3.0 in published-versions.json.
  // Until it lands, the stable '3.3' alias does not resolve, so selection skips
  // it and a 3.3-advertising agent is graded on its newest registered line.
  it('skips the 3.3 stable alias until 3.3.0 is registered', () => {
    expect(() => hostedComplianceTarget('3.3')).toThrow(/No npm-published compliance version is registered for 3\.3/);

    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0', '3.1', '3.2', '3.3']);
    expect(target.requested).toBe('3.2');
    expect(target.version).toBe(hostedComplianceTarget('3.2').version);
  });

  it('keeps 3.2-only agents on the newest 3.2 bundle after the 3.3 line is added', () => {
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.1', '3.2']);

    expect(target.requested).toBe('3.2');
    expect(target.version).toBe(hostedComplianceTarget('3.2').version);
  });

  it('grades a 3.3 release candidate pin on its exact prerelease bundle', () => {
    const target = selectHostedComplianceTargetForSupportedVersions(['3.0', '3.3-rc.3']);

    expect(target.requested).toBe('3.3-rc');
    expect(target.version).toBe('3.3.0-rc.3');
    // Prereleases are diagnostic only, never badge eligible.
    expect(badgeEligibleVersionsForHostedComplianceTarget(target)).toEqual([]);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.3-rc.3'], target)).toBe(false);
    // Canonical selection keeps the public 3.0 default for a prerelease-only 3.3 pin.
    expect(selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0', '3.3-rc.3']).requested).toBe('3.0');
  });

  it('keeps 3.1 agents that do not advertise 3.2 on the latest 3.1 GA bundle', () => {
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0', '3.1']);

    expect(target.requested).toBe('3.1');
    expect(target.version).toMatch(/^3\.1\.\d+$/);
    expect(compareSemver(target.version, '3.1.24')).toBeGreaterThanOrEqual(0);
  });

  it('treats stable 3.2 as public badge eligible and prereleases as diagnostic only', () => {
    const stable = hostedComplianceTarget('3.2');
    const rc = hostedComplianceTarget('3.1-rc');

    expect(badgeEligibleVersionsForHostedComplianceTarget(stable)).toEqual(['3.2']);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.1', '3.2'], stable)).toBe(true);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.1'], stable)).toBe(false);
    expect(badgeEligibleVersionsForHostedComplianceTarget(rc)).toEqual([]);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.1-rc.14'], rc)).toBe(false);
    // The 3.2.0 prereleases are no longer hosted at all.
    expect(() => hostedComplianceTarget('3.2-rc')).toThrow();
  });

  it('selects the 3.1 GA target when an agent advertises both 3.0 and 3.1', () => {
    const stable31Target = hostedComplianceTarget('3.1');
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0', '3.1']);

    expect(target.requested).toBe('3.1');
    expect(target.version).toBe(stable31Target.version);
  });

  it('selects the 3.1 GA target when an agent advertises patch-form 3.1.0', () => {
    const stable31Target = hostedComplianceTarget('3.1');
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0', '3.1.0']);

    expect(target.requested).toBe('3.1');
    expect(target.version).toBe(stable31Target.version);
  });

  it('keeps 3.0-only agents on the 3.0 public target', () => {
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0']);

    expect(target.requested).toBe('3.0');
    expect(target.version.startsWith('3.0.')).toBe(true);
  });

  it('treats stable 3.1 as public badge eligible', () => {
    const target = hostedComplianceTarget('3.1');

    expect(badgeEligibleVersionsForHostedComplianceTarget(target)).toEqual(['3.1']);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.0', '3.1'], target)).toBe(true);
  });

  it('treats patch-form stable 3.1.0 advertisements as public badge eligible', () => {
    const target = hostedComplianceTarget('3.1');

    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.0', '3.1.0'], target)).toBe(true);
  });

  it('does not treat prerelease 3.1 targets as public badge eligible', () => {
    const target = hostedComplianceTarget('3.1-rc');

    expect(badgeEligibleVersionsForHostedComplianceTarget(target)).toEqual([]);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.1-rc.15'], target)).toBe(false);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.1.0-rc.15'], target)).toBe(false);
  });
});
