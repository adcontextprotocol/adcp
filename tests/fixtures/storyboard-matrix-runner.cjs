#!/usr/bin/env node

'use strict';

/**
 * Fake storyboard runner for scripts/run-storyboards-matrix.sh and
 * scripts/run-storyboards-prepush.sh tests, injected with STORYBOARD_RUNNER_BIN.
 *
 * One file plays every role the matrix starts:
 *   monolithic  no --storyboard-id: print every planned row and one totals block
 *   discovery   --list-applicable-json: print the planned isolated IDs
 *   isolated    --storyboard-id <id>: print one row and its result envelope
 *   worker      --storyboard-worker: the isolated role for each id read from
 *               stdin (tests/fixtures/storyboard-runner-protocol.cjs)
 *
 * FAKE_STORYBOARD_PLAN is a JSON file keyed by "<surface>:<tenant>", where the
 * surface is "3.0-compat" when ADCP_COMPLIANCE_DIR names a 3.0.x bundle and
 * "current" otherwise, and the tenant is TENANT_PATH:
 *   { "mode": "monolithic", "rows": [{ "id", "passed", "skipped" }], "totals": { "clean", "total", "passed" } }
 *   { "mode": "isolated", "storyboards": [{ "id", "passed", "skipped", "behavior"? }] }
 * An isolated storyboard's optional behavior exercises the orchestrator's
 * failure reporting: "crash" exits 17 without a result, "malformed" prints an
 * incomplete envelope, "chatter" interleaves stdout and stderr lines before a
 * valid result. Healthy and "chatter" children join the live-marker probe.
 *
 * FAKE_EVENTS_LOG: append one JSON line per start (role, surface, tenant, the
 *   inputs the matrix passed, pid) and one per storyboard an isolated or
 *   worker process starts ({ event: 'run', pid, storyboard_id, sequence }).
 * FAKE_HANG_DIR: monolithic, isolated and worker runs record their pid and a
 *   descendant's pid there and hang (discovery still answers).
 * FIXTURE_MARKER_DIR: monolithic runs join the live-marker probe, grouped by
 *   surface; a worker joins it once, when it starts.
 */

const fs = require('node:fs');
const path = require('node:path');
const { hangWithDescendant, participate } = require('./storyboard-live-marker.cjs');
const { runStoryboards, storyboardMode } = require('./storyboard-runner-protocol.cjs');

const args = process.argv.slice(2);
const tenant = process.env.TENANT_PATH ?? '';
const complianceDir = process.env.ADCP_COMPLIANCE_DIR ?? '';
const surface = /^3\.0\.\d+$/.test(path.basename(complianceDir)) ? '3.0-compat' : 'current';
const idIndex = args.indexOf('--storyboard-id');
const storyboardId = idIndex === -1 ? undefined : args[idIndex + 1];
const mode = storyboardMode(args);
const role = args.includes('--list-applicable-json')
  ? 'discovery'
  : mode === 'worker' ? 'worker' : mode === 'single' ? 'isolated' : 'monolithic';

if (process.env.FAKE_EVENTS_LOG) {
  fs.appendFileSync(process.env.FAKE_EVENTS_LOG, `${JSON.stringify({
    event: 'start',
    role,
    surface,
    tenant,
    storyboard_id: storyboardId ?? null,
    pid: process.pid,
    candidate_version_mode: process.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE ?? null,
    compliance_dir: complianceDir || null,
    schema_root: process.env.ADCP_SCHEMA_ROOT ?? null,
    token: process.env.PUBLIC_TEST_AGENT_TOKEN ?? null,
    validator_cache_dir: process.env.ADCP_VALIDATOR_CACHE_DIR ?? null,
  })}\n`);
}

const plans = JSON.parse(fs.readFileSync(process.env.FAKE_STORYBOARD_PLAN, 'utf8'));
const plan = plans[`${surface}:${tenant}`];
if (!plan) {
  console.error(`fake runner: no plan for ${surface}:${tenant}`);
  process.exit(3);
}
const expectedMode = role === 'monolithic' ? 'monolithic' : 'isolated';
if (plan.mode !== expectedMode) {
  console.error(`fake runner: ${surface}:${tenant} is planned ${plan.mode} but ran as ${role}`);
  process.exit(3);
}

function row({ id, passed, skipped }) {
  return `  ${id.padEnd(56)} ✓ ${passed}P / ${skipped}S / 0N/A`;
}

if (role === 'discovery') {
  const ids = plan.storyboards.map(storyboard => storyboard.id);
  console.log(`ADCP_STORYBOARD_LIST ${JSON.stringify({
    version: 1,
    storyboard_ids: ids,
    selection: { corpus: ids.length, applicable: ids.length, not_applicable: 0, quarantined: 0 },
  })}`);
  process.exit(0);
}

if (process.env.FAKE_HANG_DIR) {
  hangWithDescendant(path.join(process.env.FAKE_HANG_DIR, `${process.pid}.json`), { role, surface, tenant });
} else if (role === 'isolated' || role === 'worker') {
  if (role === 'worker') participate(surface);
  runStoryboards({
    args,
    isApplicable: id => plan.storyboards.some(entry => entry.id === id),
    onRun: ({ storyboard_id: id, sequence }) => {
      if (!process.env.FAKE_EVENTS_LOG) return;
      fs.appendFileSync(process.env.FAKE_EVENTS_LOG, `${JSON.stringify({
        event: 'run',
        role,
        surface,
        tenant,
        storyboard_id: id,
        sequence,
        pid: process.pid,
      })}\n`);
    },
    handler: (id, ctx) => {
      const storyboard = plan.storyboards.find(entry => entry.id === id);
      if (storyboard.behavior === 'crash') {
        ctx.out(`  ${storyboard.id} starting`);
        process.exit(17);
      }
      if (storyboard.behavior === 'malformed') {
        ctx.result({ version: 1, storyboard_id: storyboard.id, totals: { clean: 1 } });
        return;
      }
      if (ctx.mode === 'single') participate(surface);
      if (storyboard.behavior === 'chatter') {
        for (let index = 0; index < 3; index += 1) {
          ctx.out(`  chatter stdout ${index}`);
          ctx.err(`chatter stderr ${index}`);
        }
      }
      ctx.out(row(storyboard));
      const summary = {
        id: storyboard.id,
        title: storyboard.id,
        passed: storyboard.passed,
        failed: 0,
        skipped: storyboard.skipped,
        not_applicable: 0,
        has_error: false,
      };
      ctx.result({
        version: 1,
        storyboard_id: storyboard.id,
        summaries: [summary],
        totals: { clean: 1, total: 1, passed: storyboard.passed, failed: 0, skipped: storyboard.skipped, not_applicable: 0 },
      });
    },
  });
} else {
  participate(surface);
  for (const entry of plan.rows) console.log(row(entry));
  console.log('\n--- Totals ---');
  console.log(`  storyboards: ${plan.totals.clean}/${plan.totals.total} clean`);
  console.log(
    `  selection: ${plan.totals.total} applicable | 0 not applicable | 0 quarantined | ${plan.totals.total} corpus`,
  );
  console.log(`  steps: ${plan.totals.passed} passed | 0 failed | 0 skipped | 0 not applicable`);
  process.exit(0);
}
