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

  it('keeps 3.1 agents that do not advertise 3.2 on the latest 3.1 GA bundle', () => {
    const target = selectCanonicalHostedComplianceTargetForSupportedVersions(['3.0', '3.1']);

    expect(target.requested).toBe('3.1');
    expect(target.version).toMatch(/^3\.1\.\d+$/);
    expect(compareSemver(target.version, '3.1.24')).toBeGreaterThanOrEqual(0);
  });

  it('treats stable 3.2 as public badge eligible and 3.2 prereleases as diagnostic only', () => {
    const stable = hostedComplianceTarget('3.2');
    const rc = hostedComplianceTarget('3.2-rc');

    expect(badgeEligibleVersionsForHostedComplianceTarget(stable)).toEqual(['3.2']);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.1', '3.2'], stable)).toBe(true);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.1'], stable)).toBe(false);
    expect(badgeEligibleVersionsForHostedComplianceTarget(rc)).toEqual([]);
    expect(agentAdvertisesBadgeEligibleHostedComplianceTarget(['3.2-rc.7'], rc)).toBe(false);
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
