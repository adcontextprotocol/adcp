import { PUBLIC_TEST_AGENT } from '../../server/src/config/test-agent.js';
import {
  hostedComplianceTarget,
  hostedComplianceOptions,
  withHostedTestOptions,
} from '../../server/src/services/hosted-compliance-version.js';
import { checkProbe } from './check.js';

const url = process.env.ADCP_SMOKE_CHECK_URL || PUBLIC_TEST_AGENT.url;
const token = process.env.ADCP_SMOKE_CHECK_TOKEN || PUBLIC_TEST_AGENT.token;
const target = hostedComplianceTarget();
const resolverOptions = hostedComplianceOptions(target);

await checkProbe(url, withHostedTestOptions({ auth: { type: 'bearer', token } }, target), resolverOptions, false);
console.log('Authenticated discovery and storyboard resolution passed.');
const anonymous = await checkProbe(url, withHostedTestOptions({}, target), resolverOptions, true);
console.log(`Anonymous discovery: ${anonymous}.`);
