/**
 * Run `comply()` against an agent URL and print what
 * `deriveStoryboardStatuses` would produce. Read-only — no DB writes.
 *
 * Lets us validate the new SDK-6.x scenario-key parser against real agents
 * before merging. Mirrors what the compliance heartbeat does for the
 * storyboard-status piece, but prints to stdout instead of recording.
 *
 * Usage:
 *   npx tsx server/src/scripts/test-comply-storyboard-statuses.ts <agent-url>
 *   npx tsx server/src/scripts/test-comply-storyboard-statuses.ts <url1> <url2> ...
 */

import { AAO_UA_COMPLIANCE } from '../config/user-agents.js';
import {
  comply,
  deriveStoryboardStatuses,
  complianceResultToDbInput,
  type ComplyOptions,
} from '../addie/services/compliance-testing.js';
import { hostedComplianceTarget } from '../services/hosted-compliance-version.js';

const urls = process.argv.slice(2).filter(a => !a.startsWith('--'));
const complianceTarget = hostedComplianceTarget();

if (urls.length === 0) {
  console.error('Usage: test-comply-storyboard-statuses.ts <agent-url> [<agent-url> ...]');
  process.exit(1);
}

async function probe(agentUrl: string): Promise<void> {
  console.log(`\n${'='.repeat(80)}\nAgent: ${agentUrl}\n${'='.repeat(80)}`);
  const start = Date.now();

  const opts: ComplyOptions = {
    test_session_id: `local-probe-${Date.now()}`,
    timeout_ms: 90_000,
    userAgent: AAO_UA_COMPLIANCE,
  };

  let result;
  try {
    result = await comply(agentUrl, opts, complianceTarget);
  } catch (err) {
    console.log(`  comply() threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const duration = Date.now() - start;
  console.log(`\nOverall: ${result.overall_status}  (${duration}ms)`);
  console.log(`Compliance target: ${complianceTarget.requested}`);
  console.log(`Compliance version: ${result.adcp_version ?? complianceTarget.version}`);
  console.log(`Headline: ${result.summary.headline}`);
  console.log(`Declared specialisms: ${JSON.stringify(result.agent_profile?.specialisms ?? [])}`);
  console.log(`Storyboards executed: ${JSON.stringify(result.storyboards_executed ?? '(field absent)')}`);

  console.log(`\nTracks:`);
  for (const t of result.tracks) {
    console.log(`  ${t.track.padEnd(20)} status=${t.status.padEnd(8)} scenarios=${t.scenarios.length}`);
    for (const s of t.scenarios.slice(0, 6)) {
      const pass = s.overall_passed ? '✓' : '✗';
      const stepCount = s.steps?.length ?? 0;
      const stepsPassed = s.steps?.filter(st => st.passed).length ?? 0;
      console.log(`    ${pass} ${s.scenario.padEnd(50)} steps=${stepsPassed}/${stepCount}`);
    }
    if (t.scenarios.length > 6) {
      console.log(`    … +${t.scenarios.length - 6} more`);
    }
  }

  console.log(`\nderiveStoryboardStatuses() output (what the heartbeat would persist):`);
  const entries = deriveStoryboardStatuses(result);
  if (entries.length === 0) {
    console.log(`  (empty — nothing to persist)`);
  } else {
    for (const e of entries) {
      console.log(`  ${e.storyboard_id.padEnd(40)} ${e.status.padEnd(10)} steps=${e.steps_passed}/${e.steps_total}`);
    }
  }

  console.log(`\ncomplianceResultToDbInput().storyboard_statuses (full input shape):`);
  const dbInput = complianceResultToDbInput(result, agentUrl, 'production', 'manual');
  console.log(`  count: ${dbInput.storyboard_statuses?.length ?? 0}`);
  if (dbInput.storyboard_statuses?.length) {
    console.log(JSON.stringify(dbInput.storyboard_statuses, null, 2));
  }
}

async function main(): Promise<void> {
  for (const url of urls) {
    await probe(url);
  }
  console.log('');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
