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

function walkYamlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkYamlFiles(fullPath));
    } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function patchFile(filePath, transform, label) {
  let before;
  try {
    before = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  const after = transform(before);
  if (after === before) return false;
  fs.writeFileSync(filePath, after, 'utf8');
  if (label) console.log(label);
  return true;
}

// Frozen 3.0.x storyboards authored concrete 2026/2027 active-window dates.
// As wall-clock time advances those fixtures start failing calendar guards
// before they can exercise the protocol behavior they were written for
// (TERMS_REJECTED, GOVERNANCE_DENIED, idempotency replay, etc.). Patch only
// window/validity keys in the temp compatibility bundle so legacy storyboards
// keep testing behavior rather than date drift. Historical/event timestamps
// such as accepted_at, finalized_at, and event_time are intentionally left
// alone, and JSON test vectors are excluded because some fixed dates are
// canonicalization preimages.
const staleDateLineRe = /^(\s*(?:start_time|end_time|start|end|start_date|end_date|valid_from|valid_until|expires_at):\s*["']?)(?:2026|2027)-(?=\d{2}-\d{2}(?:T|\b))/gm;
let staleDateFiles = 0;
for (const yamlPath of walkYamlFiles(bundleDir)) {
  if (patchFile(yamlPath, text => text.replace(staleDateLineRe, (_match, prefix) => `${prefix}2099-`))) {
    staleDateFiles += 1;
  }
}
if (staleDateFiles > 0) {
  console.log(`Patched stale 3.0 compatibility dates in ${staleDateFiles} YAML file(s)`);
}

const schemaValidationPath = path.join(bundleDir, 'universal', 'schema-validation.yaml');
let schemaValidationFd;
try {
  schemaValidationFd = fs.openSync(schemaValidationPath, 'r+');
} catch (err) {
  if (err && err.code === 'ENOENT') {
    schemaValidationFd = undefined;
  } else {
    throw err;
  }
}

// Older frozen 3.0.x schema-validation bundles used the branch-set shorthand
// `contributes: true` for the past-start reject/adjust branches. Modern
// runners normalize that shorthand in the loader, but older runner paths can
// inspect `contributes_to` directly when evaluating the final synthetic
// assert_contribution step. Patch only the temp compatibility bundle to emit
// the explicit flag so a passing branch reliably contributes
// `past_start_handled`.
if (schemaValidationFd !== undefined) try {
  const before = fs.readFileSync(schemaValidationFd, 'utf8');
  let after = before;
  for (const { phaseId, stepId } of [
    { phaseId: 'past_start_reject_path', stepId: 'create_buy_past_start_reject' },
    { phaseId: 'past_start_adjust_path', stepId: 'create_buy_past_start_adjust' },
  ]) {
    const pattern = new RegExp(
      `(\\n  - id: ${phaseId}\\n[\\s\\S]*?\\n      - id: ${stepId}\\n[\\s\\S]*?\\n)` +
      `        contributes: true\\n`,
    );
    after = after.replace(pattern, `$1        contributes_to: past_start_handled\n`);
  }

  if (after !== before) {
    fs.ftruncateSync(schemaValidationFd, 0);
    fs.writeSync(schemaValidationFd, after, 0, 'utf8');
    console.log(`Patched 3.0 compatibility schema-validation past-start contributions in ${schemaValidationPath}`);
  }
} finally {
  fs.closeSync(schemaValidationFd);
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
    const after = before
      .replace(/\n          start_time: "2099-05-01T00:00:00Z"\n          end_time: "2099-05-31T23:59:59Z"\n/g, '\n          start_time: "asap"\n          end_time: "2099-05-31T23:59:59Z"\n')
      .replace(/\n            path: "status"\n/g, '\n            path: "media_buy_status"\n');

    if (after !== before) {
      fs.ftruncateSync(stateMachineFd, 0);
      fs.writeSync(stateMachineFd, after, 0, 'utf8');
      console.log(`Patched 3.0 compatibility media-buy status assertions in ${stateMachinePath}`);
    }
  } finally {
    fs.closeSync(stateMachineFd);
  }
}
