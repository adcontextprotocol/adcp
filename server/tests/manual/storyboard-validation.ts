/**
 * Storyboard validation against real agents.
 *
 * Usage:
 *   npx tsx server/tests/manual/storyboard-validation.ts
 *   npx tsx server/tests/manual/storyboard-validation.ts --storyboard media_buy_seller
 *   npx tsx server/tests/manual/storyboard-validation.ts --agent https://some-agent.example/mcp
 */

import {
  comply,
  filterToKnownScenarios,
  type ComplyResult,
} from '../../src/addie/services/compliance-testing.js';
import {
  listStoryboards,
  getStoryboard,
  extractScenariosFromStoryboard,
} from '../../src/services/storyboards.js';

const TEST_AGENT_URL = process.env.TEST_AGENT_URL || 'https://test-agent.adcontextprotocol.org/mcp';
const TEST_AGENT_TOKEN = process.env.TEST_AGENT_TOKEN || '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ';

const args = process.argv.slice(2);
const storyboardFilter = args.includes('--storyboard') ? args[args.indexOf('--storyboard') + 1] : undefined;
const agentUrl = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : TEST_AGENT_URL;

interface TrackDetail {
  track: string;
  status: string;
  scenarios: { scenario: string; passed: boolean; error?: string }[];
}

interface StoryboardResult {
  id: string;
  title: string;
  scenarios_extracted: string[];
  scenarios_known: string[];
  tracks_tested: string[];
  track_details: TrackDetail[];
  tracks_passed: number;
  tracks_failed: number;
  tracks_partial: number;
  tracks_skipped: number;
  duration_ms: number;
  observations: string[];
  error?: string;
}

async function runStoryboard(storyboardId: string): Promise<StoryboardResult> {
  const sb = getStoryboard(storyboardId);
  if (!sb) {
    return {
      id: storyboardId, title: '(not found)', scenarios_extracted: [],
      scenarios_known: [], tracks_tested: [], tracks_passed: 0,
      tracks_failed: 0, tracks_partial: 0, tracks_skipped: 0,
      duration_ms: 0, error: 'Storyboard not found',
    };
  }

  const extracted = extractScenariosFromStoryboard(sb);
  const known = filterToKnownScenarios(extracted);

  if (known.length === 0) {
    return {
      id: storyboardId, title: sb.title,
      scenarios_extracted: extracted, scenarios_known: [],
      tracks_tested: [], track_details: [], tracks_passed: 0, tracks_failed: 0,
      tracks_partial: 0, tracks_skipped: 0, duration_ms: 0, observations: [],
      error: 'No known scenarios — storyboard documents the flow but has no test coverage yet',
    };
  }

  try {
    const result: ComplyResult = await comply(agentUrl, {
      scenarios: known,
      dry_run: true,
      timeout_ms: 90_000,
      auth: { type: 'bearer', token: TEST_AGENT_TOKEN },
    });

    const trackDetails: TrackDetail[] = result.tracks.map(t => ({
      track: t.track,
      status: t.status,
      scenarios: t.scenarios.map(s => ({
        scenario: s.scenario,
        passed: s.overall_passed,
        ...(s.steps?.some(st => !st.passed) && {
          error: s.steps.filter(st => !st.passed).map(st => `${st.step}: ${st.error || 'failed'}`).join('; '),
        }),
      })),
    }));

    return {
      id: storyboardId,
      title: sb.title,
      scenarios_extracted: extracted,
      scenarios_known: known,
      tracks_tested: result.tracks.map(t => t.track),
      track_details: trackDetails,
      tracks_passed: result.summary.tracks_passed,
      tracks_failed: result.summary.tracks_failed,
      tracks_partial: result.summary.tracks_partial,
      tracks_skipped: result.summary.tracks_skipped,
      duration_ms: result.total_duration_ms,
      observations: result.observations.map(o => `[${o.severity}] ${o.category}: ${o.message}`),
    };
  } catch (err) {
    return {
      id: storyboardId, title: sb.title,
      scenarios_extracted: extracted, scenarios_known: known,
      tracks_tested: [], track_details: [], tracks_passed: 0, tracks_failed: 0,
      tracks_partial: 0, tracks_skipped: 0, duration_ms: 0, observations: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log(`\nAgent: ${agentUrl}`);
  console.log(`Filter: ${storyboardFilter || '(all storyboards)'}\n`);

  const all = listStoryboards();
  const storyboardIds = storyboardFilter
    ? [storyboardFilter]
    : all.map(s => s.id);

  const results: StoryboardResult[] = [];

  for (const id of storyboardIds) {
    process.stdout.write(`  ${id}... `);
    const result = await runStoryboard(id);
    results.push(result);

    if (result.error) {
      console.log(`⚠ ${result.error}`);
    } else if (result.tracks_failed === 0 && result.tracks_partial === 0) {
      console.log(`✓ ${result.tracks_passed} tracks passed (${result.duration_ms}ms)`);
    } else {
      console.log(`✗ ${result.tracks_passed}P/${result.tracks_failed}F/${result.tracks_partial}partial (${result.duration_ms}ms)`);
    }
  }

  // Summary table
  console.log('\n--- Summary ---\n');
  console.log('Storyboard                          | Scenarios | Result           | Duration');
  console.log('------------------------------------|-----------|------------------|----------');
  for (const r of results) {
    const name = r.id.padEnd(35);
    const scenarios = `${r.scenarios_known.length}/${r.scenarios_extracted.length}`.padEnd(9);
    let status: string;
    if (r.error) {
      status = `⚠ ${r.error.slice(0, 16)}`;
    } else if (r.tracks_failed === 0 && r.tracks_partial === 0) {
      status = `✓ ${r.tracks_passed} passed`;
    } else {
      status = `✗ ${r.tracks_passed}P/${r.tracks_failed}F/${r.tracks_partial}pt`;
    }
    const dur = r.error ? '-' : `${r.duration_ms}ms`;
    console.log(`${name} | ${scenarios} | ${status.padEnd(16)} | ${dur}`);
  }

  // Totals
  const withTests = results.filter(r => !r.error);
  const allPassed = withTests.filter(r => r.tracks_failed === 0 && r.tracks_partial === 0);
  const noTests = results.filter(r => r.error);
  console.log(`\nTestable: ${withTests.length}/${results.length} | All passed: ${allPassed.length}/${withTests.length} | No test coverage: ${noTests.length}`);

  // Detail section for failures and interesting cases
  const interesting = results.filter(r => r.tracks_failed > 0 || r.tracks_partial > 0 || r.observations.length > 0);
  if (interesting.length > 0) {
    console.log('\n--- Detail (failures and observations) ---\n');
    for (const r of interesting) {
      console.log(`### ${r.id}`);
      for (const td of r.track_details) {
        console.log(`  Track: ${td.track} → ${td.status}`);
        for (const s of td.scenarios) {
          console.log(`    ${s.passed ? '✓' : '✗'} ${s.scenario}${s.error ? ` — ${s.error}` : ''}`);
        }
      }
      for (const obs of r.observations) {
        console.log(`  ${obs}`);
      }
      console.log();
    }
  }

  // Detail for "0 passed, 0 failed" (all skipped)
  const allSkipped = withTests.filter(r => r.tracks_passed === 0 && r.tracks_failed === 0 && r.tracks_partial === 0);
  if (allSkipped.length > 0) {
    console.log('\n--- All tracks skipped (scenario ran but no track results) ---\n');
    for (const r of allSkipped) {
      console.log(`  ${r.id}: scenarios=${r.scenarios_known.join(',')} tracks=${r.track_details.map(t => `${t.track}:${t.status}`).join(',') || 'none'}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
