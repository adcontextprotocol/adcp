#!/usr/bin/env node
/**
 * Same-SDK control for the TypeScript side of the interop matrix: TS buyer against TS seller.
 * This is a control, not interop; it only proves seller.mjs and buyer.mjs honor CONTRACT.txt.
 *
 *   ADCP_INTEROP_ENV=/tmp/interop-env node tests/interop/matrix/ts/selfcheck.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const env = require('../../lib/env.cjs');
env.checkEnv();
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'interop-ts-selfcheck-'));
const childEnv = env.childEnv({ ADCP_INTEROP_STATE_DIR: stateDir });
const START = '2026-10-20T00:00:00Z';
const TOKEN = 'buyer-ts';
const ACCOUNT = 'acct_1';
const SUB = 'analytics-daily';
const failures = [];
const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
  if (!condition) failures.push({ label, detail });
};

const seller = spawn(process.execPath, [path.join(here, 'seller.mjs'), '--start', START], { env: childEnv, stdio: ['ignore', 'pipe', 'inherit'] });
const ready = await new Promise((resolve, reject) => {
  readline.createInterface({ input: seller.stdout }).once('line', line => resolve(JSON.parse(line)));
  seller.once('exit', code => reject(new Error(`seller exited ${code}`)));
});
console.log('seller', JSON.stringify(ready));

const control = async body => {
  const response = await fetch(ready.control, { method: 'POST', body: JSON.stringify(body) });
  const json = await response.json();
  if (!json.ok) throw new Error(`control ${body.op}: ${json.error}`);
  return json;
};
const buyer = (command, args = {}) => {
  const child = spawnSync(process.execPath, [path.join(here, 'buyer.mjs'), command], {
    input: JSON.stringify({ url: ready.mcp, token: TOKEN, ...args }),
    env: childEnv,
    encoding: 'utf8',
  });
  if (child.status !== 0) throw new Error(`buyer ${command} exited ${child.status}: ${child.stderr}`);
  const reply = JSON.parse(child.stdout.trim().split('\n').pop());
  if (!reply.ok) console.error(`buyer ${command}:`, JSON.stringify(reply).slice(0, 2000), child.stderr.slice(-2000));
  return reply;
};
const key = row => JSON.stringify([row.subscription_version, row.media_buy_id, row.offering_id, row.period_start, row.period_end, row.stub === true]);
const same = (a, b) => JSON.stringify(a.map(key)) === JSON.stringify(b.map(key));

async function checkpoint(label, at) {
  await control({ op: 'set_time', at });
  const cycle = await control({ op: 'run_cycle' });
  check(`${label}: run_cycle without planning failures`, cycle.errors.length === 0, cycle.errors);
  const seller = await control({ op: 'obligations', principal: TOKEN, account_id: ACCOUNT, subscription_id: SUB });
  const owed = buyer('owed', { subscription_id: SUB, account_id: ACCOUNT, now: at });
  check(`${label}: buyer owed computed`, owed.ok, owed);
  if (!owed.ok) return;
  console.log(`     grants from the wire: ${JSON.stringify(owed.input.account.grants)}; coverage: ${JSON.stringify(owed.input.coverage ?? {})}`);
  check(`${label}: buyer rows == seller engine obligations (${owed.rows.length} vs ${seller.rows.length})`, same(owed.rows, seller.rows), { buyer: owed.rows, seller: seller.rows });
  // get_reporting_status treats an account the caller lost authority over as unknown: no wire obligations.
  if (!owed.input.account.grants.at(-1)?.unauthorized_at)
  check(`${label}: buyer rows == wire obligations (${owed.rows.length} vs ${owed.wire_obligations.length})`, same(owed.rows, owed.wire_obligations), {
    buyer: owed.rows,
    wire: owed.wire_obligations,
  });
}

try {
  await control({ op: 'grant', principal: TOKEN, account_id: ACCOUNT, at: '2026-10-19T00:00:00Z' });
  await control({
    op: 'put_buy',
    account_id: ACCOUNT,
    buy: {
      media_buy_id: 'mb_1',
      status: 'active',
      confirmed_at: '2026-10-20T00:00:00Z',
      start_time: '2026-10-21T00:00:00Z',
      end_time: '2026-11-10T00:00:00Z',
      packages: [{ package_id: 'pkg_1', reporting_delivery_offering_ids: ['off_daily_local', 'off_daily_utc'] }],
    },
  });
  const subscription = {
    subscription_id: SUB,
    scope: { all_authorized_accounts: true },
    selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'official', dimensions: ['package'], alignment: 'utc' },
    reconciliation_mode: 'delivery_only',
  };
  const subscribed = buyer('subscribe', { subscription });
  check('subscribe v1', subscribed.ok && subscribed.subscription_version === 1, subscribed);
  await checkpoint('day 4', '2026-10-24T00:00:00Z');
  // Version cutover: a utc schedule to a local one (source_timezone pinned to America/New_York).
  await control({ op: 'set_time', at: '2026-10-24T06:00:00Z' });
  const changed = buyer('subscribe', { subscription: { ...subscription, selector: { ...subscription.selector, alignment: 'source_timezone' } } });
  check('subscribe v2 (selector change bumps the version)', changed.ok && changed.subscription_version === 2, changed);
  await checkpoint('day 8 (after cutover, across the America/New_York DST end on 11-01)', '2026-11-03T00:00:00Z');
  // Revoke and re-grant inside retention.
  await control({ op: 'revoke', principal: TOKEN, account_id: ACCOUNT, at: '2026-11-03T12:00:00Z' });
  await checkpoint('revoked', '2026-11-04T00:00:00Z');
  await control({ op: 'grant', principal: TOKEN, account_id: ACCOUNT, at: '2026-11-04T12:00:00Z' });
  await checkpoint('re-granted', '2026-11-07T00:00:00Z');

  // Accounts.
  for (const [brand, expected] of [
    ['acme.example', 'ready'],
    ['ready.example', 'ready'],
    ['review.example', 'pending'],
    ['ambiguous.example', 'ambiguous'],
    ['reject.example', 'rejected'],
  ]) {
    const outcome = buyer('account_open', { brand: { domain: brand }, operator: 'agency.example' });
    check(`account_open ${brand} -> ${expected}`, outcome.ok && outcome.kind === expected, outcome);
    if (brand === 'review.example' && outcome.ok) {
      check('review.example pending carries a url for a person', outcome.next_step === 'send_human_to_url' && /^https:/.test(outcome.action?.url ?? ''), outcome);
      const again = buyer('account_open', { brand: { domain: brand }, operator: 'agency.example' });
      check('repeat open returns the same request', again.request_id === outcome.request_id, again);
      await control({ op: 'account_request', request_id: outcome.request_id, action: 'approve' });
      const refreshed = buyer('account_refresh');
      check('refresh after approval reports ready', refreshed.ok && refreshed.moved.some(m => m.request_id === outcome.request_id && m.kind === 'ready'), refreshed);
      const read = buyer('account_requests', { request_ids: [outcome.request_id] });
      check('account_requests reads the approved request back', read.ok && read.requests[0]?.state === 'resolved' && read.requests[0]?.resolution === 'created', read);
    }
  }
  for (const [changes, expected] of [
    [{ timezone: 'America/Los_Angeles' }, { state: 'resolved', resolution: 'updated' }],
    [{ currency: 'EUR' }, { state: 'resolved', resolution: 'created' }],
    [{ billing: 'advertiser' }, { state: 'in_review' }],
    [{ sandbox: true }, { state: 'rejected' }],
  ]) {
    const result = buyer('account_change', { account_id: ACCOUNT, changes, revision: 1 });
    check(`account_change ${Object.keys(changes)[0]} -> ${expected.state}${expected.resolution ? `/${expected.resolution}` : ''}`, result.ok && result.state === expected.state && (!expected.resolution || result.resolution === expected.resolution), result);
    if (changes.billing && result.ok) {
      const approved = await control({ op: 'account_request', request_id: result.request_id, action: 'approve' });
      check('billing change approved -> updated with effective_at', approved.request.resolution === 'updated' && approved.request.effective_at, approved);
    }
  }
} catch (error) {
  failures.push({ label: 'exception', detail: String(error?.stack ?? error) });
  console.error(error);
} finally {
  seller.kill('SIGTERM');
  rmSync(stateDir, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.log(`- ${failure.label}: ${JSON.stringify(failure.detail).slice(0, 1500)}`);
  process.exitCode = 1;
} else {
  console.log('\nselfcheck passed');
}
