#!/usr/bin/env node
'use strict';

/**
 * Buyer-against-seller interop matrix for AdCP 3.3 reporting subscriptions and
 * account requests: {TS buyer, Python buyer} x {TS seller, Python seller}.
 *
 *   node tests/interop/matrix/run.cjs [--pairs ts:py,py:ts,ts:ts,py:py] [--out <dir>]
 *
 * A pair is buyer:seller. Cross-SDK pairs are the interop result; same-SDK pairs
 * run as controls only (they show a failure is not the harness). Each pair gets
 * a fresh seller on a virtual clock and walks one scripted timeline:
 *
 *   grant, two buys, subscribe (v1, local days); a version cutover to utc days
 *   (v2); revoke and re-grant inside status_retention_days; a cutover back
 *   (v3); deactivate and reactivate; and a DST change on the local offering
 *   (America/Santiago 2026-09-06 on the Python seller, America/New_York
 *   2026-11-01 on the TypeScript seller; see LOCAL_ALIGNMENT).
 *
 * At each checkpoint the buyer computes owed periods from wire reads only, with
 * its own SDK, and the harness asserts zero discrepancies against the seller's
 * own obligations (control op) and against the obligations the seller serves on
 * get_reporting_status. Then the account-request script runs: open (matched,
 * created, pending with a pending action, ambiguous, rejected, repeat open),
 * approval through the seller, refresh, and changes resolving updated, created
 * (separate account), in review then updated, and rejected.
 *
 * Process contract: CONTRACT.txt. Writes summary.json / summary.md to --out
 * (default $ADCP_INTEROP_OUT or tests/interop/matrix/out) and exits 1 on any
 * discrepancy or failed step in a cross-SDK pair (2 when only a control fails).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../lib/env.cjs');
const { startSeller, control, buyer } = require('./procs.cjs');

const ACCOUNT = 'acct_1';
const SUBSCRIPTION_ID = 'analytics-daily';
const START = '2026-09-01T00:00:00Z';

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[(i += 1)];
  }
  return out;
}

/**
 * The selector alignment that picks each seller's local-day offering. The Python seller publishes
 * off_daily_local as account_timezone days in the account zone (America/Santiago, whose 2026-09-06 DST
 * change skips local midnight). The TypeScript managed path refuses account_timezone offerings and
 * Santiago local days, so its seller publishes off_daily_local as source_timezone days pinned to
 * America/New_York (ts/seller.mjs explains); the timeline runs past New York's 2026-11-01 DST change so
 * both sellers' local offerings cross one.
 */
const LOCAL_ALIGNMENT = { py: 'account_timezone', ts: 'source_timezone' };

function subscription(alignment) {
  return {
    subscription_id: SUBSCRIPTION_ID,
    scope: { all_authorized_accounts: true },
    selector: { feed_purpose: 'analytics', period_duration: 'P1D', required_finality: 'official', alignment, dimensions: ['package'] },
    reconciliation_mode: 'delivery_only',
  };
}

function mediaBuy(id, confirmedAt, start, end, offerings) {
  return {
    media_buy_id: id,
    status: 'active',
    currency: 'USD',
    total_budget: 10000,
    revision: 1,
    confirmed_at: confirmedAt,
    start_time: start,
    end_time: end,
    packages: [{ package_id: `${id}_pkg_1`, reporting_delivery_offering_ids: offerings }],
  };
}

const key = row => JSON.stringify([row.subscription_version, row.media_buy_id, row.offering_id, Date.parse(row.period_start), Date.parse(row.period_end), row.stub === true]);

/** Rows only in a, rows only in b. */
function compareRows(a, b) {
  const setA = new Map(a.map(row => [key(row), row]));
  const setB = new Map(b.map(row => [key(row), row]));
  return {
    onlyA: [...setA].filter(([k]) => !setB.has(k)).map(([, row]) => row),
    onlyB: [...setB].filter(([k]) => !setA.has(k)).map(([, row]) => row),
  };
}

const fmt = row => `v${row.subscription_version} ${row.media_buy_id} ${row.offering_id} ${row.period_start}..${row.period_end}${row.stub ? ' stub' : ''}`;

async function runPair(buyerSdk, sellerSdk, root) {
  const label = `${buyerSdk} buyer -> ${sellerSdk} seller`;
  const control_ = buyerSdk === sellerSdk;
  const stateDir = fs.mkdtempSync(path.join(root, `${buyerSdk}-${sellerSdk}-`));
  const token = `buyer-${buyerSdk}`;
  const result = { pair: `${buyerSdk}:${sellerSdk}`, label, control: control_, checks: [], steps: [], accounts: [], failures: [] };
  const fail = (what, detail) => {
    result.failures.push({ what, detail });
    console.log(`  FAIL ${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 2000)}`);
  };
  console.log(`\n== ${label}${control_ ? ' (control: same SDK, not interop)' : ''}`);
  let seller;
  try {
    seller = await startSeller(sellerSdk, START, { stateDir });
    result.seller_version = seller.sdkVersion;
  } catch (error) {
    fail('seller start', error.message);
    return result;
  }
  const base = { url: seller.mcp, token };
  let now = START;
  const step = async (name, fn) => {
    try {
      const value = await fn();
      result.steps.push({ name, ok: true });
      return value;
    } catch (error) {
      result.steps.push({ name, ok: false, error: error.message });
      fail(name, error.message);
      return undefined;
    }
  };
  const call = async (command, extra) => {
    const out = await buyer(buyerSdk, command, { ...base, ...extra }, { stateDir });
    if (!out.ok) throw new Error(`${buyerSdk} buyer ${command}: ${out.error}${out.stderr ? `\n${out.stderr.slice(-1500)}` : ''}`);
    return out;
  };
  const at = async instant => {
    now = instant;
    await control(seller, { op: 'set_time', at: instant });
  };
  const cycle = async () => {
    const out = await control(seller, { op: 'run_cycle' });
    if (out.errors?.length) fail(`run_cycle at ${now}`, out.errors);
  };
  const check = async name => {
    const entry = { name, now };
    result.checks.push(entry);
    try {
      const owed = await call('owed', { subscription_id: SUBSCRIPTION_ID, account_id: ACCOUNT, now });
      const sellerRows = (await control(seller, { op: 'obligations', principal: token, account_id: ACCOUNT, subscription_id: SUBSCRIPTION_ID })).rows;
      entry.buyer_rows = owed.rows.length;
      entry.seller_rows = sellerRows.length;
      entry.wire_rows = owed.wire_obligations.length;
      const vsSeller = compareRows(owed.rows, sellerRows);
      const vsWire = compareRows(owed.rows, owed.wire_obligations);
      entry.discrepancies = {
        buyer_not_seller: vsSeller.onlyA.map(fmt),
        seller_not_buyer: vsSeller.onlyB.map(fmt),
        buyer_not_wire: vsWire.onlyA.map(fmt),
        wire_not_buyer: vsWire.onlyB.map(fmt),
      };
      const count = Object.values(entry.discrepancies).reduce((n, list) => n + list.length, 0);
      entry.ok = count === 0;
      console.log(`  ${entry.ok ? 'ok  ' : 'DIFF'} ${name} @ ${now}: buyer ${entry.buyer_rows}, seller ${entry.seller_rows}, wire ${entry.wire_rows}`);
      if (!entry.ok) {
        entry.input = owed.input;
        fail(`check ${name}`, entry.discrepancies);
      }
    } catch (error) {
      entry.ok = false;
      entry.error = error.message;
      fail(`check ${name}`, error.message);
    }
  };

  try {
    // -- subscription timeline ------------------------------------------------------------------
    const local = LOCAL_ALIGNMENT[sellerSdk];
    await step('grant', () => control(seller, { op: 'grant', principal: token, account_id: ACCOUNT, at: START }));
    await step('put_buy mb_1', () =>
      control(seller, { op: 'put_buy', account_id: ACCOUNT, buy: mediaBuy('mb_1', START, '2026-09-02T00:00:00Z', '2026-11-05T00:00:00Z', ['off_daily_local', 'off_daily_utc']) }));
    await step('put_buy mb_2', () =>
      control(seller, { op: 'put_buy', account_id: ACCOUNT, buy: mediaBuy('mb_2', '2026-09-03T12:00:00Z', '2026-09-04T00:00:00Z', '2026-09-12T00:00:00Z', ['off_daily_local']) }));
    const v1 = await step(`subscribe v1 (${local})`, () => call('subscribe', { subscription: subscription(local) }));
    if (v1 && v1.subscription_version !== 1) fail('subscribe v1', `subscription_version ${v1.subscription_version}`);
    await at('2026-09-04T12:00:00Z');
    await cycle();
    await check('v1 periods');

    const v2 = await step('subscribe v2 (utc): version cutover', () => call('subscribe', { subscription: subscription('utc') }));
    if (v2 && v2.subscription_version !== 2) fail('subscribe v2', `subscription_version ${v2?.subscription_version}`);
    await at('2026-09-08T06:00:00Z');
    await cycle();
    await check('v2 after the cutover');

    await step('revoke', () => control(seller, { op: 'revoke', principal: token, account_id: ACCOUNT, at: '2026-09-08T06:00:00Z' }));
    await at('2026-09-09T18:00:00Z');
    await cycle();
    await step('re-grant inside retention', () => control(seller, { op: 'grant', principal: token, account_id: ACCOUNT, at: '2026-09-09T18:00:00Z' }));
    await at('2026-09-12T12:00:00Z');
    await cycle();
    await check('after revoke and re-grant');

    const v3 = await step(`subscribe v3 (${local}): cutover back`, () => call('subscribe', { subscription: subscription(local) }));
    if (v3 && v3.subscription_version !== 3) fail('subscribe v3', `subscription_version ${v3?.subscription_version}`);
    await at('2026-09-16T00:00:00Z');
    await cycle();
    await check('v3 after the second cutover');

    await step('unsubscribe (deactivate)', () => call('unsubscribe', { subscription_id: SUBSCRIPTION_ID }));
    await at('2026-09-18T15:00:00Z');
    await cycle();
    await check('while inactive');
    await step('subscribe again (reactivate)', () => call('subscribe', { subscription: subscription(local) }));
    await at('2026-10-30T12:00:00Z');
    await cycle();
    await check('after reactivation');
    await at('2026-11-06T00:00:00Z');
    await cycle();
    await check('across the New York DST change, flight ended');

    // -- account requests -----------------------------------------------------------------------
    const expectOutcome = async (name, extra, want) => {
      const out = await step(name, () => call('account_open', extra));
      const entry = { name, want, got: out && { kind: out.kind, next_step: out.next_step, account_id: out.account_id, request_id: out.request_id } };
      result.accounts.push(entry);
      if (out && Object.entries(want).some(([k, v]) => (k === 'action_url' ? !out.action?.url : out[k] !== v))) {
        entry.ok = false;
        fail(name, { want, got: out });
      } else entry.ok = Boolean(out);
      return out;
    };
    const operator = 'agency.example';
    await expectOutcome('open: existing account (matched)', { brand: { domain: 'acme.example' }, operator }, { kind: 'ready', account_id: ACCOUNT });
    const created = await expectOutcome('open: new account (created)', { brand: { domain: 'ready.example' }, operator }, { kind: 'ready' });
    const pending = await expectOutcome('open: pending, buyer action', { brand: { domain: 'review.example' }, operator }, { kind: 'pending', next_step: 'send_human_to_url', action_url: true });
    const again = await expectOutcome('open: repeat returns the open request', { brand: { domain: 'review.example' }, operator }, { kind: 'pending' });
    if (pending && again && pending.request_id && again.request_id !== pending.request_id) fail('repeat open', `new request ${again.request_id} instead of ${pending.request_id}`);
    await expectOutcome('open: ambiguous', { brand: { domain: 'ambiguous.example' }, operator }, { kind: 'ambiguous', next_step: 'pick_candidate' });
    await expectOutcome('open: rejected', { brand: { domain: 'reject.example' }, operator }, { kind: 'rejected' });
    if (pending?.request_id) {
      await step('seller approves the pending request', () => control(seller, { op: 'account_request', request_id: pending.request_id, action: 'approve' }));
      const refreshed = await step('refresh after approval', () => call('account_refresh', {}));
      const moved = refreshed?.moved?.find(m => m.request_id === pending.request_id || m.kind === 'ready');
      result.accounts.push({ name: 'refresh: pending becomes ready', got: refreshed?.moved, ok: Boolean(moved && moved.kind === 'ready') });
      if (!moved || moved.kind !== 'ready') fail('refresh after approval', refreshed?.moved);
    }
    const changeTarget = created?.account_id;
    const expectChange = async (name, changes, want) => {
      if (!changeTarget) return undefined;
      const out = await step(name, () => call('account_change', { account_id: changeTarget, changes }));
      const ok = out && Object.entries(want).every(([k, v]) => (v === true ? out[k] !== undefined : out[k] === v));
      result.accounts.push({ name, want, got: out && { state: out.state, resolution: out.resolution, account_id: out.account_id, request_id: out.request_id }, ok: Boolean(ok) });
      if (out && !ok) fail(name, { want, got: out });
      return out;
    };
    await expectChange('change: timezone (updated)', { timezone: 'America/New_York' }, { state: 'resolved', resolution: 'updated' });
    await expectChange('change: currency (separate account)', { currency: 'EUR' }, { state: 'resolved', resolution: 'created', not_carried_over: true });
    const review = await expectChange('change: billing (in review)', { billing: 'agent' }, { state: 'in_review', pending_action: true });
    if (review?.request_id) {
      await step('seller approves the billing change', () => control(seller, { op: 'account_request', request_id: review.request_id, action: 'approve' }));
      const read = await step('read back the change request', () => call('account_requests', { request_ids: [review.request_id] }));
      const record = read?.requests?.find(r => r.request_id === review.request_id);
      const ok = record?.state === 'resolved' && record?.resolution === 'updated' && Boolean(record?.effective_at);
      result.accounts.push({ name: 'change: billing approved (updated, effective_at)', got: record, ok });
      if (!ok) fail('billing change read back', record);
    }
    await expectChange('change: sandbox (rejected)', { sandbox: true }, { state: 'rejected' });
  } finally {
    result.seller_stderr_tail = seller.stderr().split('\n').filter(line => /error|traceback|exception/i.test(line)).slice(-40);
    await seller.stop();
  }
  result.ok = result.failures.length === 0;
  return result;
}

async function main() {
  const opts = args();
  env.checkEnv();
  const outDir = path.resolve(opts.out || process.env.ADCP_INTEROP_OUT || path.join(__dirname, 'out'));
  fs.mkdirSync(outDir, { recursive: true });
  const pairs = String(opts.pairs || 'ts:py,py:ts,ts:ts,py:py').split(',').map(p => p.split(':'));
  const versions = env.versions();
  console.log(`interop matrix: @adcp/sdk ${versions.ts}, adcp ${versions.py}, tzdata ${versions.tzdata}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-interop-matrix-'));
  const results = [];
  for (const [b, s] of pairs) results.push(await runPair(b, s, root));
  fs.rmSync(root, { recursive: true, force: true });

  const summary = { versions, start: START, results };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = [
    '## Reporting subscriptions and account requests: buyer x seller interop',
    '',
    `@adcp/sdk ${versions.ts} · adcp ${versions.py} · tzdata ${versions.tzdata}`,
    '',
    '| Buyer | Seller | Kind | Coverage checks | Account steps | Failures |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const checks = `${r.checks.filter(c => c.ok).length}/${r.checks.length}`;
    const accounts = `${r.accounts.filter(a => a.ok).length}/${r.accounts.length}`;
    lines.push(`| ${r.pair.split(':')[0]} | ${r.pair.split(':')[1]} | ${r.control ? 'control' : 'interop'} | ${checks} | ${accounts} | ${r.failures.length} |`);
  }
  for (const r of results.filter(x => x.failures.length)) {
    lines.push('', `### ${r.label}${r.control ? ' (control)' : ''}`, '');
    for (const f of r.failures) lines.push(`- **${f.what}**: \`${(typeof f.detail === 'string' ? f.detail : JSON.stringify(f.detail)).slice(0, 600).replace(/`/g, "'")}\``);
  }
  fs.writeFileSync(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}`);
  const interopFailed = results.some(r => !r.control && !r.ok);
  const controlFailed = results.some(r => r.control && !r.ok);
  process.exitCode = interopFailed ? 1 : controlFailed ? 2 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 3;
});
