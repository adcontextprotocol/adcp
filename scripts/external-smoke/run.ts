import { PUBLIC_TEST_AGENT } from '../../server/src/config/test-agent.js';
import {
  hostedComplianceTarget,
  hostedComplianceOptions,
  withHostedTestOptions,
} from '../../server/src/services/hosted-compliance-version.js';
import { checkProbe, type ResolverForRelease } from './check.js';

const url = process.env.ADCP_SMOKE_CHECK_URL || PUBLIC_TEST_AGENT.url;
const token = process.env.ADCP_SMOKE_CHECK_TOKEN || PUBLIC_TEST_AGENT.token;
const target = hostedComplianceTarget();
const resolverOptions = hostedComplianceOptions(target);
// Resolve storyboards from this checkout's hosted bundle for the release the
// agent served, not the default pin's.
const resolverFor: ResolverForRelease = release => hostedComplianceOptions(hostedComplianceTarget(release));

await checkProbe(url, withHostedTestOptions({ auth: { type: 'bearer', token } }, target), resolverOptions, false, {
  resolverFor,
});
console.log('Authenticated discovery and storyboard resolution passed.');
const anonymous = await checkProbe(url, withHostedTestOptions({}, target), resolverOptions, true, { resolverFor });
console.log(`Anonymous discovery: ${anonymous}.`);
