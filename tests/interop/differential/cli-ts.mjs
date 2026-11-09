#!/usr/bin/env node
/**
 * Coverage CLI for the TypeScript SDK: owedSubscriptionPeriodsV1 from
 * @adcp/sdk/reporting/advanced over scenarios in the canonical vector input
 * shape (static/compliance/source/test-vectors/reporting-subscriptions/case.schema.json).
 *
 *   stdin:  one input, one case ({ input }), or a JSON array of either
 *           (with --lines: one such JSON document per line, answered line by line)
 *   stdout: one result, or an array of results in the same order:
 *           { ok: true, rows, obligations } | { ok: false, error: { kind, code, detail, message } }
 *
 * Rows and obligations use the vectors' expected / expected_obligations shapes.
 * The SDK resolves zones through Intl, so start this with ICU_TIMEZONE_FILES_DIR
 * pointing at the pinned release (lib/env.cjs childEnv does); it refuses to run
 * on any other release.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const envDir = process.env.ADCP_INTEROP_ENV;
if (!envDir) throw new Error('ADCP_INTEROP_ENV is not set');
const want = process.env.ADCP_INTEROP_TZDATA;
if (want && process.versions.tz !== want && process.env.ADCP_INTEROP_ALLOW_TZDATA_MISMATCH !== '1') {
  throw new Error(`Node resolves zones from tzdata ${process.versions.tz}, not ${want}: set ICU_TIMEZONE_FILES_DIR`);
}
const sdkRequire = createRequire(path.join(envDir, 'node', 'package.json'));
const { owedSubscriptionPeriodsV1, groupOwedSubscriptionPeriodsV1, CoverageInputError } = sdkRequire('@adcp/sdk/reporting/advanced');

const z = text => {
  const iso = new Date(Date.parse(text)).toISOString();
  return iso.endsWith('.000Z') ? `${iso.slice(0, -5)}Z` : iso;
};

function run(item) {
  const input = structuredClone(item && typeof item === 'object' && 'input' in item ? item.input : item);
  try {
    const owed = owedSubscriptionPeriodsV1(input);
    return {
      ok: true,
      rows: owed.map(row => ({
        subscription_version: row.subscription_version,
        media_buy_id: row.media_buy_id,
        offering_id: row.offering_id,
        period_start: z(row.period_start),
        period_end: z(row.period_end),
        ...(row.stub ? { stub: true } : {}),
      })),
      obligations: groupOwedSubscriptionPeriodsV1(owed).map(group => ({
        subscription_version: group.subscription_version,
        offering_id: group.offering_id,
        period_start: z(group.period_start),
        period_end: z(group.period_end),
        ...(group.stub ? { stub: true } : {}),
        media_buy_ids: [...group.media_buy_ids],
      })),
    };
  } catch (error) {
    if (error instanceof CoverageInputError) {
      return { ok: false, error: { kind: 'coverage_input', code: error.code, detail: error.detail, message: error.message } };
    }
    if (error?.code === 'COVERAGE_BUDGET_EXCEEDED' || error instanceof RangeError) {
      return { ok: false, error: { kind: 'budget', code: 'COVERAGE_BUDGET_EXCEEDED', detail: null, message: error.message } };
    }
    return { ok: false, error: { kind: 'crash', code: error?.code ?? null, detail: error?.name ?? null, message: String(error?.message ?? error) } };
  }
}

const answer = payload => (Array.isArray(payload) ? payload.map(run) : run(payload));

if (process.argv.includes('--lines')) {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (line.trim()) process.stdout.write(`${JSON.stringify(answer(JSON.parse(line)))}\n`);
  }
} else {
  process.stdout.write(`${JSON.stringify(answer(JSON.parse(readFileSync(0, 'utf8'))))}\n`);
}
