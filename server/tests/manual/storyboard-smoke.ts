/**
 * Storyboard smoke test: runs all storyboards against the training agent
 * using @adcp/sdk's storyboard runner over real MCP transport.
 *
 * Usage:
 *   npx tsx server/tests/manual/storyboard-smoke.ts
 *   npx tsx server/tests/manual/storyboard-smoke.ts --storyboard media_buy_seller
 *   npx tsx server/tests/manual/storyboard-smoke.ts --agent https://some-agent.example/mcp
 *   npx tsx server/tests/manual/storyboard-smoke.ts --storyboard media_buy_state_machine --brand acmeoutdoor.example
 *
 * `--brand` is recommended for storyboards that reference a `test_kit`
 * (e.g. media_buy_state_machine → acme-outdoor). See JSDoc on the
 * `brandDomain` resolution below for the runner's positive-path /
 * negative-path brand split that makes this matter.
 */

import {
  runStoryboard,
  listAllComplianceStoryboards,
  type StoryboardResult,
  type StoryboardStepResult,
} from '@adcp/sdk/testing';
import { PUBLIC_TEST_AGENT } from '../../src/config/test-agent.js';

const TEST_AGENT_URL = process.env.TEST_AGENT_URL || PUBLIC_TEST_AGENT.url;
const TEST_AGENT_TOKEN = process.env.TEST_AGENT_TOKEN || PUBLIC_TEST_AGENT.token;

const args = process.argv.slice(2);
const storyboardFilter = args.includes('--storyboard') ? args[args.indexOf('--storyboard') + 1] : undefined;
const agentUrl = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : TEST_AGENT_URL;
// Run-scoped brand. Storyboards that reference a test_kit are written to
// target the brand defined in that kit (e.g. acmeoutdoor.example for the
// media-buy state machine, sourced from test-kits/acme-outdoor.yaml). The
// SDK runner's `applyBrandInvariant` rewrites every step's brand to
// `options.brand` when set; without it, positive-path steps default to
// `test.example` via `resolveBrand`'s fallback while expect_error steps
// pass the YAML's literal brand through unchanged — split-brain that
// session-keys the create/update calls into different partitions and
// surfaces as MEDIA_BUY_NOT_FOUND on the negative-path probes. Pass
// `--brand acmeoutdoor.example` (or the kit-specific value) to align them.
const brandDomain = args.includes('--brand') ? args[args.indexOf('--brand') + 1] : undefined;

async function main() {
  console.log(`\n=== Storyboard Smoke Test ===`);
  console.log(`Agent: ${agentUrl}`);
  console.log(`Filter: ${storyboardFilter || '(all storyboards)'}\n`);

  const allStoryboards = listAllComplianceStoryboards()
    .filter(sb => !storyboardFilter || sb.id === storyboardFilter);

  if (allStoryboards.length === 0) {
    console.error(`No storyboards found${storyboardFilter ? ` matching "${storyboardFilter}"` : ''}`);
    process.exit(1);
  }

  const results: StoryboardResult[] = [];

  for (const storyboard of allStoryboards) {
    const stepCount = storyboard.phases.reduce((s, p) => s + p.steps.length, 0);
    process.stdout.write(`  ${storyboard.id} (${stepCount} steps)... `);

    try {
      const result = await runStoryboard(agentUrl, storyboard, {
        auth: { type: 'bearer', token: TEST_AGENT_TOKEN },
        ...(brandDomain && { brand: { domain: brandDomain } }),
        timeout_ms: 30_000,
        dry_run: false,
      });
      results.push(result);

      if (result.overall_passed) {
        console.log(`✅ ${result.passed_count} passed (${result.total_duration_ms}ms)`);
      } else {
        console.log(`❌ ${result.passed_count}P/${result.failed_count}F/${result.skipped_count}S (${result.total_duration_ms}ms)`);
        printFailures(result);
      }
    } catch (err: any) {
      console.log(`💥 ${err.message}`);
      results.push({
        storyboard_id: storyboard.id,
        storyboard_title: storyboard.title,
        agent_url: agentUrl,
        overall_passed: false,
        phases: [],
        context: {},
        total_duration_ms: 0,
        passed_count: 0,
        failed_count: stepCount,
        skipped_count: 0,
        tested_at: new Date().toISOString(),
        dry_run: false,
      });
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('\nStoryboard                          | Steps          | Duration');
  console.log('------------------------------------|----------------|----------');

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const r of results) {
    const name = r.storyboard_id.padEnd(35);
    const icon = r.overall_passed ? '✅' : '❌';
    const steps = `${r.passed_count}P/${r.failed_count}F/${r.skipped_count}S`.padEnd(14);
    const dur = `${r.total_duration_ms}ms`;
    console.log(`${icon} ${name} | ${steps} | ${dur}`);
    totalPassed += r.passed_count;
    totalFailed += r.failed_count;
    totalSkipped += r.skipped_count;
  }

  const allPassed = results.every(r => r.overall_passed);
  console.log(`\nTotal: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped`);

  process.exit(allPassed ? 0 : 1);
}

function printFailures(result: StoryboardResult) {
  for (const phase of result.phases) {
    for (const step of phase.steps) {
      if (!step.passed && !step.skipped) {
        const validationErrors = step.validations
          .filter(v => !v.passed)
          .map(v => v.error || v.description)
          .join('; ');
        console.log(`    ❌ ${step.step_id} (${step.task}): ${step.error || validationErrors}`);
      } else if (step.skipped) {
        console.log(`    ⏭  ${step.step_id} (${step.task}): ${step.skip_reason || 'skipped'}`);
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
