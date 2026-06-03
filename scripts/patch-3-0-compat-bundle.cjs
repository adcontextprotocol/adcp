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
