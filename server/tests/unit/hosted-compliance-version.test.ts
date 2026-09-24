import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HOSTED_COMPLIANCE_VERSION,
  HostedComplianceTargetError,
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
    // (3.2.0-rc.x) and no published 3.2.x stable release (see
    // static/compliance/published-versions.json). A bare line alias
    // must throw here, not silently resolve to a pre-release that callers
    // (badge eligibility, an explicit compliance_target: "3.2") would treat
    // as if it were the stable release for that line.
    let thrown: unknown;
    try {
      resolveHostedComplianceVersion('3.2');
    } catch (error) {
      thrown = error;
    }

    // The caller-facing error names the prerelease aliases to send instead;
    // the operator-facing cache message stays attached as the cause.
    expect(thrown).toBeInstanceOf(HostedComplianceTargetError);
    expect((thrown as Error).message).toMatch(/No stable AdCP 3\.2\.x compliance release is published yet/);
    expect((thrown as Error).message).toContain('"3.2-rc"');
    expect(String((thrown as Error).cause)).toMatch(/No npm-published compliance version is registered for 3\.2/);
  });

  it('does not hand out prerelease advice for a line with no cache at all', () => {
    // An unknown line must stay behind the generic handler message: naming a
    // "-rc" alias that also fails would send the caller in a circle.
    let thrown: unknown;
    try {
      resolveHostedComplianceVersion('4.0');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(HostedComplianceTargetError);
  });
});
