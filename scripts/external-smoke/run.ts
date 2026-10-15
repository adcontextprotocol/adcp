import type { TestOptions } from '@adcp/sdk/testing';
import { PUBLIC_TEST_AGENT } from '../../server/src/config/test-agent.js';
import {
  hostedComplianceTarget,
  hostedComplianceOptions,
  withHostedTestOptions,
} from '../../server/src/services/hosted-compliance-version.js';
import { checkProbe, type RepinProbe } from './check.js';

const url = process.env.ADCP_SMOKE_CHECK_URL || PUBLIC_TEST_AGENT.url;
const token = process.env.ADCP_SMOKE_CHECK_TOKEN || PUBLIC_TEST_AGENT.token;
const target = hostedComplianceTarget();
const resolverOptions = hostedComplianceOptions(target);
// When the agent serves a different release than the default pin, validate
// and resolve against this checkout's hosted bundle for the served release.
const repinFor = (base: Partial<TestOptions>): RepinProbe => release => {
  const served = hostedComplianceTarget(release);
  return { options: withHostedTestOptions(base, served), resolverOptions: hostedComplianceOptions(served) };
};

const authenticated: Partial<TestOptions> = { auth: { type: 'bearer', token } };
await checkProbe(url, withHostedTestOptions(authenticated, target), resolverOptions, false, {
  repin: repinFor(authenticated),
});
console.log('Authenticated discovery and storyboard resolution passed.');
const anonymous = await checkProbe(url, withHostedTestOptions({}, target), resolverOptions, true, {
  repin: repinFor({}),
});
console.log(`Anonymous discovery: ${anonymous}.`);
