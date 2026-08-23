#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const storyboardIds = (process.env.FIXTURE_STORYBOARDS ?? 'healthy').split(',').filter(Boolean);

if (args.includes('--list-applicable-json')) {
  console.log(`ADCP_STORYBOARD_LIST ${JSON.stringify({ version: 1, storyboard_ids: storyboardIds })}`);
  process.exit(0);
}

const idIndex = args.indexOf('--storyboard-id');
const storyboardId = idIndex === -1 ? undefined : args[idIndex + 1];
if (!storyboardId || !storyboardIds.includes(storyboardId)) process.exit(2);

const result = {
  version: 1,
  storyboard_id: storyboardId,
  summaries: [{
    id: storyboardId,
    title: storyboardId,
    passed: 1,
    failed: 0,
    skipped: 0,
    not_applicable: 0,
    has_error: false,
  }],
  totals: {
    clean: 1,
    total: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    not_applicable: 0,
  },
};

function spawnHangingDescendant() {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  if (process.env.FIXTURE_DESCENDANT_PID_FILE) {
    fs.writeFileSync(process.env.FIXTURE_DESCENDANT_PID_FILE, String(descendant.pid));
  }
}

if (storyboardId === 'hang') {
  spawnHangingDescendant();
  setInterval(() => {}, 1_000);
} else if (storyboardId === 'leak') {
  const retained = [];
  setInterval(() => {
    // Allocate and touch every page so RSS, rather than virtual memory, grows.
    retained.push(Buffer.alloc(16 * 1024 * 1024, 1));
  }, 10);
} else if (storyboardId === 'post_result_hang') {
  spawnHangingDescendant();
  console.log(`ADCP_STORYBOARD_RESULT ${JSON.stringify(result)}`);
  setInterval(() => {}, 1_000);
} else if (storyboardId === 'noisy') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
  setInterval(() => {}, 1_000);
} else if (storyboardId === 'log_commands') {
  process.stdout.write('stdout prefix\r::error::forged stdout command\n');
  process.stderr.write('stderr prefix\r::warning::forged stderr command\n');
  console.log(`ADCP_STORYBOARD_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
} else if (storyboardId === 'crash') {
  process.exit(17);
} else if (storyboardId === 'inconsistent_result') {
  console.log(`ADCP_STORYBOARD_RESULT ${JSON.stringify({
    ...result,
    totals: { ...result.totals, passed: 999 },
  })}`);
  process.exit(0);
} else if (storyboardId === 'signed_requests') {
  console.log(`ADCP_STORYBOARD_RESULT ${JSON.stringify({
    ...result,
    summaries: [{ ...result.summaries[0], id: 'signed_requests-strict' }],
  })}`);
  process.exit(0);
} else if (storyboardId === 'malformed_result') {
  console.log(`ADCP_STORYBOARD_RESULT ${JSON.stringify({
    version: 1,
    storyboard_id: storyboardId,
    totals: { clean: 1 },
  })}`);
  process.exit(0);
} else if (storyboardId === 'node_options') {
  console.log(`NODE_OPTIONS=${process.env.NODE_OPTIONS ?? ''}`);
  console.log(`ADCP_STORYBOARD_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
} else {
  console.log(`  ${storyboardId.padEnd(40)} ✓ 1P / 0S / 0N/A`);
  console.log(`ADCP_STORYBOARD_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}
