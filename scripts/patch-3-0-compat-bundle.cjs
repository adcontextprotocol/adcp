#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const bundleDir = process.argv[2];
if (!bundleDir) {
  console.error('Usage: node scripts/patch-3-0-compat-bundle.cjs <dist/compliance/3.0.x>');
  process.exit(1);
}

const indexPath = path.join(bundleDir, 'index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`Compliance bundle index not found: ${indexPath}`);
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const version = String(index.adcp_version || '');
if (!/^3\.0\.\d+$/.test(version)) {
  process.exit(0);
}

const idempotencyPath = path.join(bundleDir, 'universal', 'idempotency.yaml');
let idempotencyFd;
try {
  idempotencyFd = fs.openSync(idempotencyPath, 'r+');
} catch (err) {
  if (err && err.code === 'ENOENT') {
    process.exit(0);
  }
  throw err;
}

// The frozen 3.0.15 idempotency storyboard authored fixed 2026 flight dates.
// Once those dates became stale, @adcp/sdk's fixture-aware create_media_buy
// enricher replaced them with per-step dynamic defaults. That makes the
// initial/replay payloads differ before they reach the agent and turns the
// compatibility check into a runner-fixture failure instead of an idempotency
// regression check. Patch only the temp compatibility bundle so the old
// storyboard keeps exercising stable same-payload replay semantics.
try {
  const before = fs.readFileSync(idempotencyFd, 'utf8');
  const after = before.replace(/\b2026-/g, '2099-');

  if (after !== before) {
    fs.ftruncateSync(idempotencyFd, 0);
    fs.writeSync(idempotencyFd, after, 0, 'utf8');
    console.log(`Patched stale 3.0 compatibility dates in ${idempotencyPath}`);
  }
} finally {
  fs.closeSync(idempotencyFd);
}

const webhookEmissionPath = path.join(bundleDir, 'universal', 'webhook-emission.yaml');
let webhookEmissionFd;
try {
  webhookEmissionFd = fs.openSync(webhookEmissionPath, 'r+');
} catch (err) {
  if (err && err.code === 'ENOENT') {
    process.exit(0);
  }
  throw err;
}

// The frozen 3.0.16 webhook-emission storyboard's synthetic branch-set
// assertion is unconditional even when an agent does not expose get_products.
// The two optional branch probes correctly skip on agents without that tool,
// but the final assert_contribution step still fails because no branch could
// have contributed. Patch only the temp compatibility bundle by removing the
// obsolete assertion phase; current-source storyboards still exercise the
// synchronous completion branch-set semantics.
try {
  const before = fs.readFileSync(webhookEmissionFd, 'utf8');
  const after = before.replace(
    /\n  - id: synchronous_completion_assertion\n[\s\S]*?\n  - id: idempotency_key_stability\n/,
    '\n  - id: idempotency_key_stability\n',
  );

  if (after !== before) {
    fs.ftruncateSync(webhookEmissionFd, 0);
    fs.writeSync(webhookEmissionFd, after, 0, 'utf8');
    console.log(`Patched 3.0 compatibility webhook assertion phase in ${webhookEmissionPath}`);
  }
} finally {
  fs.closeSync(webhookEmissionFd);
}

for (const rel of [
  path.join('protocols', 'media-buy', 'state-machine.yaml'),
  path.join('domains', 'media-buy', 'state-machine.yaml'),
]) {
  const stateMachinePath = path.join(bundleDir, rel);
  let stateMachineFd;
  try {
    stateMachineFd = fs.openSync(stateMachinePath, 'r+');
  } catch (err) {
    if (err && err.code === 'ENOENT') continue;
    throw err;
  }

  // The frozen 3.0.16 media-buy state-machine storyboard predates the
  // create/update response split between protocol-envelope `status` and
  // lifecycle `media_buy_status`. Patch the temp compatibility copy to assert
  // the lifecycle field, matching current source without rewriting dist.
  try {
    const before = fs.readFileSync(stateMachineFd, 'utf8');
    const after = before.replace(/\n            path: "status"\n/g, '\n            path: "media_buy_status"\n');

    if (after !== before) {
      fs.ftruncateSync(stateMachineFd, 0);
      fs.writeSync(stateMachineFd, after, 0, 'utf8');
      console.log(`Patched 3.0 compatibility media-buy status assertions in ${stateMachinePath}`);
    }
  } finally {
    fs.closeSync(stateMachineFd);
  }
}
