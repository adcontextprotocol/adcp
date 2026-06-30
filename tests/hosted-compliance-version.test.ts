import { describe, expect, it } from 'vitest';
import {
  agentAdvertisesBadgeEligibleHostedComplianceTarget,
  badgeEligibleVersionsForHostedComplianceTarget,
  hostedComplianceTarget,
  selectCanonicalHostedComplianceTargetForSupportedVersions,
} from '../server/src/services/hosted-compliance-version.js';

describe('hosted compliance target selection', () => {
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
