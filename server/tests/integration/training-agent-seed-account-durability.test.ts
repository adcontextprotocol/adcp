import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const testUrl = process.env.DATABASE_URL;
const principal = `seed-durability-${randomUUID()}`;
const fixture = {
  brand: { domain: 'seed-process.example', brand_id: 'outdoor', countries: ['US'] },
  operator: 'buyer.example',
  operator_unit: { id: 'seed-unit' },
  currency: 'USD',
  timezone: 'America/New_York',
  sandbox: true,
};

// Clients share only PostgreSQL. Retaining one client also tests a genuinely
// warm web process while another process commits reset_state's account cleanup.
function processClient(options: { principal?: string; context?: Record<string, unknown> } = {}) {
  const program = `
    import { createInterface } from 'node:readline';
    import { initializeDatabase, closeDatabase } from ${JSON.stringify(new URL('../../src/db/client.ts', import.meta.url).href)};
    // Initialize shared tool schemas through the production router bootstrap
    // before loading its private account helpers in this fresh ESM process.
    await import(${JSON.stringify(new URL('../../src/training-agent/index.ts', import.meta.url).href)});
    const { seedAccountFixture, isNaturalAccountRefProvisioned, clearAccountStoreForSession,
      rehydrateAccountById, accountRefForId, handleListAccounts, handleSyncAccounts
    } = await import(${JSON.stringify(new URL('../../src/training-agent/account-handlers.ts', import.meta.url).href)});
    const { sessionKeyFromArgs } = await import(${JSON.stringify(new URL('../../src/training-agent/state.ts', import.meta.url).href)});
    const { principal, fixture, context } = JSON.parse(process.env.SEED_ACCOUNT_TEST_INPUT);
    const ctx = { mode: 'open', ...context, principal };
    initializeDatabase({ connectionString: process.env.DATABASE_URL });
    try {
      for await (const line of createInterface({ input: process.stdin })) {
        const { operation, accountId, overrides } = JSON.parse(line);
        const account = { ...fixture, ...overrides };
        let result;
        if (operation === 'seed') {
          result = await seedAccountFixture({ params: { account_id: accountId, fixture: account } }, ctx);
        } else if (operation === 'reset') {
          await clearAccountStoreForSession(sessionKeyFromArgs({}, ctx.mode, ctx.userId, ctx.moduleId), principal);
          result = { success: true };
        } else if (operation === 'provision') {
          const synced = await handleSyncAccounts({ accounts: [{ ...account, billing: 'operator' }] }, ctx);
          result = { accountId: synced.accounts?.[0]?.account_id };
        } else if (operation.startsWith('inspect')) {
          let opaque, listed, status;
          const byId = async () => {
            await rehydrateAccountById(principal, accountId);
            opaque = Boolean(accountRefForId(accountId, principal));
          };
          const list = async () => {
            const response = await handleListAccounts({ account: { account_id: accountId } }, ctx);
            const row = response.accounts?.find(row => row.account_id === accountId);
            listed = Boolean(row);
            status = row?.status;
          };
          if (operation === 'inspect_id') { await byId(); await list(); }
          else { await list(); await byId(); }
          result = { opaque, listed, provisioned: await isNaturalAccountRefProvisioned(principal, account),
            ...(operation === 'inspect_status' && { status }) };
        } else {
          result = {
            provisioned: await isNaturalAccountRefProvisioned(principal, account),
            wrongPrincipal: await isNaturalAccountRefProvisioned(principal + '-other', account),
            wrongOperator: await isNaturalAccountRefProvisioned(principal, { ...account, operator: 'other.example' }),
            wrongSandbox: await isNaturalAccountRefProvisioned(principal, { ...account, sandbox: false }),
          };
        }
        console.log('SEED_RESULT=' + JSON.stringify(result));
      }
    } finally { await closeDatabase(); }
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
    env: { ...process.env, SEED_ACCOUNT_TEST_INPUT: JSON.stringify({ principal, fixture, ...options }) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-16_384); });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const timeout = setTimeout(() => child.kill(), 60_000);
  return {
    async call(operation: string, accountId = '', overrides: Record<string, unknown> = {}) {
      child.stdin.write(JSON.stringify({ operation, accountId, overrides }) + '\n');
      for (;;) {
        const line = await lines.next();
        if (line.done) throw new Error(`Seed test child exited without a result: ${stderr}`);
        if (line.value.startsWith('SEED_RESULT=')) return JSON.parse(line.value.slice('SEED_RESULT='.length));
      }
    },
    async close() {
      child.stdin.end();
      try {
        const [code] = await exited;
        expect(code, stderr).toBe(0);
      } finally { clearTimeout(timeout); }
    },
  };
}

async function processCall(operation: string, accountId: string, overrides: Record<string, unknown> = {}) {
  const client = processClient();
  try { return await client.call(operation, accountId, overrides); }
  finally { await client.close(); }
}

describe.skipIf(!testUrl)('controller account seeding across real PostgreSQL processes', () => {
  let pool: Pool;
  beforeAll(() => {
    const url = new URL(testUrl!);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/adcp_test') {
      throw new Error('Tests require the migrated local adcp_test database.');
    }
    pool = new Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 5000 });
  });
  afterAll(async () => {
    if (!pool) return;
    try { await pool.query('DELETE FROM training_reporting_ledgers WHERE principal_scope = ANY($1::text[])', [[principal, `${principal}-neighbor`]]); }
    finally { await pool.end(); }
  });

  it('makes a seed discoverable to a fresh process and preserves fixture replay/refusal', async () => {
    expect(await processCall('seed', 'acc_cold')).toMatchObject({ success: true });
    expect(await processCall('read', 'acc_cold')).toEqual({
      provisioned: true, wrongPrincipal: false, wrongOperator: false, wrongSandbox: false,
    });
    expect(await processCall('seed', 'acc_cold')).toMatchObject({ success: true });
    expect(await processCall('seed', 'acc_cold', { status: 'suspended' })).toMatchObject({
      success: false, error: 'INVALID_STATE',
    });
  }, 120_000);

  it('allows only one conflicting fixture or account id to claim an identity concurrently', async () => {
    const competing = await Promise.all([
      processCall('seed', 'acc_race', { operator: 'race.example', status: 'active' }),
      processCall('seed', 'acc_race', { operator: 'race.example', status: 'suspended' }),
    ]);
    expect(competing.filter(result => result.success)).toHaveLength(1);
    expect(competing.filter(result => result.error === 'INVALID_STATE')).toHaveLength(1);

    const sameKey = await Promise.all([
      processCall('seed', 'acc_key_a', { operator: 'key-race.example' }),
      processCall('seed', 'acc_key_b', { operator: 'key-race.example' }),
    ]);
    expect(sameKey.filter(result => result.success)).toHaveLength(1);
    expect(sameKey.filter(result => result.error === 'INVALID_STATE')).toHaveLength(1);
    expect((await pool.query(
      'SELECT account_id FROM training_reporting_ledgers WHERE principal_scope = $1 AND account_id = ANY($2::text[])',
      [principal, ['acc_race', 'acc_key_a', 'acc_key_b']],
    )).rowCount).toBe(2);
  }, 120_000);

  it('invalidates warm natural/id/list views and permits reseeding after another process resets', async () => {
    const warm = processClient();
    const reset = processClient();
    const neighbor = processClient({ principal: `${principal}-neighbor` });
    const otherSession = processClient({ context: { mode: 'training', userId: 'seed-user', moduleId: 'seed-module' } });
    const warmFixture = { operator: 'warm-reset.example' };
    try {
      const ordinary = await warm.call('provision', '', { operator: 'ordinary-reset.example' });
      expect(ordinary.accountId).toEqual(expect.any(String));
      expect(await neighbor.call('seed', 'acc_neighbor')).toMatchObject({ success: true });
      expect(await otherSession.call('seed', 'acc_other_session', { operator: 'other-session.example' })).toMatchObject({ success: true });
      expect(await warm.call('seed', 'acc_warm', warmFixture)).toMatchObject({ success: true });
      expect(await warm.call('inspect_id', 'acc_warm', warmFixture)).toEqual({ opaque: true, listed: true, provisioned: true });
      expect(await reset.call('reset')).toMatchObject({ success: true });
      // No intervening read clears the stale local fixture before this replay.
      expect(await warm.call('seed', 'acc_warm', { ...warmFixture, status: 'paused' })).toMatchObject({ success: true });
      // List first: rehydrating by id first would refresh the stale brand-map
      // alias and mask it overriding the newly seeded default-map state.
      expect(await warm.call('inspect_status', 'acc_warm', warmFixture)).toEqual({
        opaque: true, listed: true, provisioned: true, status: 'paused',
      });
      expect(await reset.call('reset')).toMatchObject({ success: true });
      expect(await warm.call('inspect_id', 'acc_warm', warmFixture)).toEqual({ opaque: false, listed: false, provisioned: false });
      expect(await warm.call('seed', 'acc_warm', warmFixture)).toMatchObject({ success: true });
      expect(await warm.call('inspect_id', 'acc_warm', warmFixture)).toEqual({ opaque: true, listed: true, provisioned: true });
      expect(await reset.call('reset')).toMatchObject({ success: true });
      // Both reset and reseed happen on B. A must replace its retained-ID
      // aliases from the authoritative row before merging a list response.
      expect(await reset.call('seed', 'acc_warm', { ...warmFixture, status: 'paused' })).toMatchObject({ success: true });
      expect(await warm.call('inspect_status', 'acc_warm', warmFixture)).toEqual({
        opaque: true, listed: true, provisioned: true, status: 'paused',
      });
      expect(await reset.call('reset')).toMatchObject({ success: true });
      expect(await warm.call('inspect_list', 'acc_warm', warmFixture)).toEqual({ opaque: false, listed: false, provisioned: false });
      expect(await warm.call('inspect_id', ordinary.accountId, { operator: 'ordinary-reset.example' })).toEqual({ opaque: true, listed: true, provisioned: true });
      expect(await neighbor.call('inspect_id', 'acc_neighbor')).toEqual({ opaque: true, listed: true, provisioned: true });
      expect(await otherSession.call('inspect_id', 'acc_other_session', { operator: 'other-session.example' })).toEqual({ opaque: true, listed: true, provisioned: true });
    } finally { await Promise.all([warm.close(), reset.close(), neighbor.close(), otherSession.close()]); }
  }, 120_000);
});
