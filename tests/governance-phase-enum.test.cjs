#!/usr/bin/env node
/**
 * Schema-invariant guard for audit finding T1-4 (NS-GOV-001).
 *
 * The JWS governance profile (docs/building/by-layer/L1/security.mdx) treats
 * `phase` as a load-bearing claim with four values: intent, purchase,
 * modification, delivery. The `governance-phase` enum — $ref'd by
 * check-governance-request.phase — must carry all four, or the buyer cannot
 * express an intent-phase check and the intent/execution token separation
 * collapses at the schema layer.
 *
 * This is the deterministic enforcement that keeps the enum from drifting back
 * to a subset of what the prose mandates. See specs/spec-anti-drift.md.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ENUM_PATH = path.join(__dirname, '../static/schemas/source/enums/governance-phase.json');
const REQUIRED_PHASES = ['intent', 'purchase', 'modification', 'delivery'];

const schema = JSON.parse(fs.readFileSync(ENUM_PATH, 'utf8'));

for (const phase of REQUIRED_PHASES) {
  assert.ok(
    Array.isArray(schema.enum) && schema.enum.includes(phase),
    `governance-phase enum MUST include "${phase}" (JWS profile phase claim). Got: ${JSON.stringify(schema.enum)}`,
  );
}

console.log(`✓ governance-phase enum carries all ${REQUIRED_PHASES.length} JWS-profile phases`);
