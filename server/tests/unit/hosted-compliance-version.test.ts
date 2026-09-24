import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HOSTED_COMPLIANCE_VERSION,
  resolveHostedComplianceVersion,
} from '../../src/services/hosted-compliance-version.js';

describe('resolveHostedComplianceVersion', () => {
  it('resolves the 3.1 line to a stable build, not a prerelease', () => {
    // Not pinned to an exact patch: new 3.1.x releases land regularly, and
    // this is a regression guard for #7356, not a version-pin test.
    expect(resolveHostedComplianceVersion('3.1')).toMatch(/^3\.1\.\d+$/);
  });

  it('resolves the default 3.0 line to the module-level default version', () => {
    expect(resolveHostedComplianceVersion('3.0')).toBe(DEFAULT_HOSTED_COMPLIANCE_VERSION);
  });

  it('throws rather than silently substituting an RC for a non-default line with no stable build', () => {
    // Regression guard for #7356: 3.2 currently has only RC builds cached
    // (3.2.0-rc.x) and no published 3.2.x stable release. A bare line alias
    // must throw here, not silently resolve to a pre-release that callers
    // (badge eligibility, an explicit compliance_target: "3.2") would treat
    // as if it were the stable release for that line.
    expect(() => resolveHostedComplianceVersion('3.2')).toThrow(
      /No npm-published compliance version is registered for 3\.2/,
    );
  });
});
