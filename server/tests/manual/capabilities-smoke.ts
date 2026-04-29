/**
 * Smoke test: capability-driven storyboard resolution
 *
 * Hits a live agent, probes get_adcp_capabilities via testCapabilityDiscovery,
 * and resolves bundles via resolveStoryboardsForCapabilities. Verifies both:
 *   1. v3 agent that declares capabilities → bundles resolve cleanly
 *   2. v3 agent with no specialisms / v2 agent → coaching path
 *
 * Usage: npx tsx server/tests/manual/capabilities-smoke.ts [agent_url]
 */

import {
  testCapabilityDiscovery,
  resolveStoryboardsForCapabilities,
} from '@adcp/sdk/testing';
import { PUBLIC_TEST_AGENT } from '../../src/config/test-agent.js';

const agentUrl = process.argv[2] || PUBLIC_TEST_AGENT.url;
const token = process.env.AGENT_TOKEN || PUBLIC_TEST_AGENT.token;

function line() {
  console.log('='.repeat(70));
}

async function main() {
  console.log(`\nAgent: ${agentUrl}\n`);

  line();
  console.log('Step 1: testCapabilityDiscovery');
  line();

  const caps = await testCapabilityDiscovery(agentUrl, {
    auth: { type: 'bearer', token },
  });

  const profile = caps.profile;
  if (!profile) {
    console.log('No profile returned. Agent unreachable or probe crashed.');
    process.exit(1);
  }

  console.log('Name:                     ', profile.name ?? '(unknown)');
  console.log('adcp_version:             ', profile.adcp_version ?? '(unknown)');
  console.log('supported_protocols:      ', profile.supported_protocols ?? '(none)');
  console.log('specialisms:              ', profile.specialisms ?? '(none)');
  console.log('capabilities_probe_error: ', profile.capabilities_probe_error ?? '(none)');
  console.log('tools:                    ', profile.tools?.length ?? 0, 'tools');

  const supportedProtocols = profile.supported_protocols ?? [];
  const specialisms = profile.specialisms ?? [];

  line();
  console.log('Step 2: resolveStoryboardsForCapabilities');
  line();

  if (supportedProtocols.length === 0 && specialisms.length === 0) {
    console.log('\nAgent declares no capabilities. Coaching path would kick in here:');
    console.log('  → "Add supported_protocols and specialisms to your');
    console.log('     get_adcp_capabilities response so the runner can pick bundles."');
    console.log('\nResolving with empty capabilities to see what falls through...');
  }

  let resolved;
  try {
    resolved = resolveStoryboardsForCapabilities({
      supported_protocols: supportedProtocols,
      specialisms,
    });
  } catch (err) {
    console.log('\nResolution FAILED:', err instanceof Error ? err.message : err);
    console.log('→ /applicable-storyboards would return 422 unknown_specialism');
    process.exit(1);
  }

  const byKind: Record<string, typeof resolved.bundles> = {
    universal: [],
    domain: [],
    specialism: [],
  };
  for (const b of resolved.bundles) {
    (byKind[b.ref.kind] ??= []).push(b);
  }

  console.log(
    `\nTotal: ${resolved.bundles.length} bundles, ${resolved.storyboards.length} storyboards\n`,
  );

  for (const kind of ['universal', 'domain', 'specialism'] as const) {
    const bundles = byKind[kind];
    if (!bundles?.length) continue;
    console.log(`${kind.toUpperCase()} (${bundles.length}):`);
    for (const b of bundles) {
      console.log(
        `  ${b.ref.id}: ${b.storyboards.length} storyboards (${b.storyboards.map(s => s.id).join(', ')})`,
      );
    }
    console.log();
  }

  line();
  console.log('Smoke test complete');
  line();
}

main().catch(err => {
  console.error('\nSmoke test failed:', err);
  process.exit(1);
});
