/**
 * External-endpoint smoke check for release gate.
 *
 * Verifies the hosted verifier can discover, resolve, and classify errors
 * for a real external agent. Uses the public test agent by default; override
 * via ADCP_SMOKE_CHECK_URL / ADCP_SMOKE_CHECK_TOKEN.
 *
 * Run:
 *   npx vitest run server/tests/integration/external-smoke-check.test.ts
 *
 * Against a custom endpoint:
 *   ADCP_SMOKE_CHECK_URL=https://example.com/mcp \
 *   ADCP_SMOKE_CHECK_TOKEN=sk-... \
 *     npx vitest run server/tests/integration/external-smoke-check.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  testCapabilityDiscovery,
  resolveStoryboardsForCapabilities,
} from '@adcp/sdk/testing';
import { PUBLIC_TEST_AGENT } from '../../src/config/test-agent.js';
import {
  hostedComplianceTarget,
  hostedComplianceOptions,
  withHostedTestOptions,
} from '../../src/services/hosted-compliance-version.js';

const SMOKE_URL = process.env.ADCP_SMOKE_CHECK_URL || PUBLIC_TEST_AGENT.url;
const SMOKE_TOKEN = process.env.ADCP_SMOKE_CHECK_TOKEN || PUBLIC_TEST_AGENT.token;
const complianceTarget = hostedComplianceTarget();
const complianceOptions = hostedComplianceOptions(complianceTarget);

describe('external endpoint smoke check', () => {
  it('discovers capabilities from external endpoint', async () => {
    const result = await testCapabilityDiscovery(SMOKE_URL, withHostedTestOptions({
      auth: { type: 'bearer', token: SMOKE_TOKEN },
    }, complianceTarget));

    expect(result.profile).toBeDefined();
    expect(result.profile!.tools!.length).toBeGreaterThan(0);
    expect(result.profile!.adcp_supported_versions ?? result.profile!.adcp_version).toBeDefined();
  }, 30_000);

  it('resolves applicable storyboards for discovered capabilities', async () => {
    const caps = await testCapabilityDiscovery(SMOKE_URL, withHostedTestOptions({
      auth: { type: 'bearer', token: SMOKE_TOKEN },
    }, complianceTarget));

    const profile = caps.profile!;
    const resolved = resolveStoryboardsForCapabilities({
      supported_protocols: profile.supported_protocols ?? [],
      specialisms: profile.specialisms ?? [],
      major_versions: profile.adcp_major_versions,
      supported_versions: profile.adcp_supported_versions,
    }, complianceOptions);

    expect(resolved.storyboards.length).toBeGreaterThan(0);
    expect(resolved.bundles.length).toBeGreaterThan(0);
  }, 30_000);

  it('classifies auth-required agents distinctly from discovery failure', async () => {
    const unauthResult = await testCapabilityDiscovery(SMOKE_URL, withHostedTestOptions({
      // no auth — anonymous probe
    }, complianceTarget));

    if (unauthResult.profile) {
      // Public agent — anon discovery succeeds, no auth error to classify
      expect(unauthResult.profile.tools).toBeDefined();
    } else {
      // Auth-gated agent — steps should show auth failure, not generic crash
      const failedSteps = unauthResult.steps.filter(s => !s.passed);
      expect(failedSteps.length).toBeGreaterThan(0);
      const hasAuthIndicator = failedSteps.some(s =>
        /auth|401|unauthorized|forbidden/i.test(s.error ?? '') ||
        /auth|401|unauthorized|forbidden/i.test(s.step_id ?? ''),
      );
      expect(hasAuthIndicator).toBe(true);
    }
  }, 30_000);
});
