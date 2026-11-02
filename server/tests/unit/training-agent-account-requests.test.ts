import { beforeEach, describe, expect, it } from 'vitest';

const { clearSessions, flushDirtySessions, runWithSessionContext } = await import('../../src/training-agent/state.js');
const { clearAccountStore, handleListAccounts } = await import('../../src/training-agent/account-handlers.js');
const {
  accountRequestsForListAccounts,
  handleRequestAccount,
} = await import('../../src/training-agent/account-requests.js');
const { handleReportingSubscriptionProbe } = await import('../../src/training-agent/subscription-probe.js');
const { STATUS_RETENTION_DAYS } = await import('../../src/training-agent/account-sandbox.js');

type Json = Record<string, any>;
type Ctx = Parameters<typeof handleRequestAccount>[1];

const ctx = (principal = 'static:buyer-a', servedAdcpVersion = '3.3-beta.3'): Ctx => ({
  mode: 'open',
  principal,
  servedAdcpVersion,
});

let keyCounter = 0;
const key = () => `account-request-key-${String(++keyCounter).padStart(6, '0')}`;

const inSession = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithSessionContext(async () => {
    const result = await fn();
    await flushDirtySessions();
    return result;
  });

const request = (args: Json, context: Ctx = ctx()) =>
  inSession(() => handleRequestAccount({ idempotency_key: key(), ...args } as never, context)) as Promise<Json>;

const probe = (params: Json, context: Ctx = ctx()) =>
  inSession(() => handleReportingSubscriptionProbe(params, context)) as Promise<Json>;

const listAccounts = (args: Json = {}, context: Ctx = ctx()) =>
  inSession(() => handleListAccounts(args as never, context)) as Promise<Json>;

const listRequests = (args: Json, context: Ctx = ctx()) =>
  inSession(() => accountRequestsForListAccounts(args as never, context)) as Promise<Json>;

const openArgs = (overrides: Json = {}): Json => ({
  brand: { domain: 'nova-athletics.example', countries: ['DE'] },
  operator: 'pinnacle-media.example',
  sandbox: true,
  billing: 'operator',
  payment_terms: 'net_30',
  ...overrides,
});

async function openAccount(overrides: Json = {}, context: Ctx = ctx()): Promise<string> {
  const result = await request(openArgs(overrides), context);
  expect(result.request).toMatchObject({ state: 'resolved' });
  return result.request.account_id as string;
}

async function readAccount(accountId: string, context: Ctx = ctx()): Promise<Json | undefined> {
  const result = await listAccounts({ account: { account_id: accountId } }, context);
  return result.accounts?.[0];
}

beforeEach(async () => {
  await clearSessions();
  clearAccountStore();
});

describe('request_account: opening', () => {
  it('refuses callers below the 3.3 wire', async () => {
    const result = await request(openArgs(), ctx('static:buyer-a', '3.2'));
    expect(result).toMatchObject({ status: 'failed', errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
  });

  it('creates a sandbox account at once and matches a repeated open to it', async () => {
    const first = await request(openArgs());
    expect(first.request).toMatchObject({
      state: 'resolved',
      resolution: 'created',
      requested: { operator: 'pinnacle-media.example', billing: 'operator' },
      account: { billing: 'operator', payment_terms: 'net_30', revision: 1 },
    });
    expect(first.request.request_id).toMatch(/^areq_/);
    const again = await request(openArgs());
    expect(again.request).toMatchObject({ state: 'resolved', resolution: 'matched', account_id: first.request.account_id });
    expect(again.request.request_id).not.toBe(first.request.request_id);

    const account = await readAccount(first.request.account_id);
    expect(account).toMatchObject({ revision: 1, authorization: { read_only: false } });
    expect(account!.authorization.allowed_tasks).toContain('request_account');
    expect(Date.parse(account!.authorization.authorized_at)).not.toBeNaN();
  });

  it('answers several matching accounts as ambiguous and resolves a picked candidate as matched', async () => {
    const de = await openAccount();
    const fr = await openAccount({ brand: { domain: 'nova-athletics.example', countries: ['FR'] } });
    const ambiguous = await request(openArgs({ brand: { domain: 'nova-athletics.example' } }));
    expect(ambiguous.request.state).toBe('ambiguous');
    expect(ambiguous.request.candidates.map((candidate: Json) => candidate.account_id).sort()).toEqual([de, fr].sort());
    expect(ambiguous.request.account_id).toBeUndefined();

    const picked = await request({ request_id: ambiguous.request.request_id, account_id: fr });
    expect(picked.request).toMatchObject({ request_id: ambiguous.request.request_id, state: 'resolved', resolution: 'matched', account_id: fr });
  });

  it('rejects a request for an operator the seller declines', async () => {
    const result = await request(openArgs({ operator: 'pinnacle-declined.example' }));
    expect(result.request).toMatchObject({ state: 'rejected', errors: [{ code: 'POLICY_VIOLATION' }] });
    expect(result.request.account_id).toBeUndefined();
  });

  it('reviews on the seller side and resolves when the sandbox clock passes the review', async () => {
    const opened = await request(openArgs({ operator: 'pinnacle-review.example' }));
    expect(opened.request).toMatchObject({ state: 'in_review', pending_action: { waiting_on: 'seller', kind: 'review' } });
    expect(opened.request.account_id).toBeUndefined();

    const now = Date.parse(opened.request.created_at);
    const advanced = await probe({ operation: 'advance_time', target_time: new Date(now + 2 * 3_600_000).toISOString() });
    expect(advanced.success).toBe(true);

    const read = await listRequests({ request_ids: [opened.request.request_id] });
    expect(read.account_requests).toHaveLength(1);
    expect(read.account_requests[0]).toMatchObject({ state: 'resolved', resolution: 'created' });
    expect(read.account_requests[0].account.account_id).toBe(read.account_requests[0].account_id);
  });

  it('hands sign-up to the buyer, completes on account_id, and expires unanswered actions', async () => {
    const holder = await openAccount();
    const signUp = await request(openArgs({ operator: 'pinnacle-signup.example' }));
    expect(signUp.request).toMatchObject({ state: 'in_review', pending_action: { waiting_on: 'buyer', kind: 'sign_up' } });
    expect(signUp.request.pending_action.url).toMatch(/^https:\/\//);
    const completed = await request({ request_id: signUp.request.request_id, account_id: holder });
    expect(completed.request).toMatchObject({ state: 'resolved', resolution: 'matched', account_id: holder });

    const lapsed = await request(openArgs({ operator: 'other-signup.example' }));
    await probe({ operation: 'advance_time', target_time: new Date(Date.parse(lapsed.request.created_at) + 8 * 86_400_000).toISOString() });
    const read = await listRequests({ request_ids: [lapsed.request.request_id] });
    expect(read.account_requests[0]).toMatchObject({ state: 'rejected', errors: [{ code: 'ACCOUNT_SETUP_REQUIRED' }] });
  });

  it('pages requests separately from accounts, newest first', async () => {
    for (const country of ['DE', 'FR', 'IT']) await openAccount({ brand: { domain: 'nova-athletics.example', countries: [country] } });
    const first = await listRequests({ include_requests: true, requests_pagination: { max_results: 2 } });
    expect(first.account_requests).toHaveLength(2);
    expect(first.account_requests_pagination).toMatchObject({ has_more: true, total_count: 3 });
    const second = await listRequests({ requests_pagination: { max_results: 2, cursor: first.account_requests_pagination.cursor } });
    expect(second.account_requests).toHaveLength(1);
    expect(second.account_requests_pagination.has_more).toBe(false);
    expect(first.account_requests[0].updated_at >= first.account_requests[1].updated_at).toBe(true);
  });

  it('keeps one caller from seeing another caller\'s requests', async () => {
    const mine = await request(openArgs());
    const theirs = await listRequests({ request_ids: [mine.request.request_id] }, ctx('static:buyer-b'));
    expect(theirs.account_requests).toEqual([]);
  });
});

describe('request_account: changing', () => {
  it('validates the change before touching the account', async () => {
    const accountId = await openAccount();
    expect(await request({ account_id: accountId, operator: 'pinnacle-media.example' }))
      .toMatchObject({ status: 'failed', errors: [{ code: 'INVALID_REQUEST', field: 'operator' }] });
    expect(await request({ account_id: accountId, payment_terms: 'net_45' }))
      .toMatchObject({ status: 'failed', errors: [{ code: 'INVALID_REQUEST', field: 'revision' }] });
    expect(await request({ account_id: accountId, revision: 7, billing: 'agent' }))
      .toMatchObject({ status: 'failed', errors: [{ code: 'CONFLICT' }] });
    expect(await request({ account_id: accountId, currency: 'EUR' }))
      .toMatchObject({ status: 'failed', errors: [{ code: 'UNSUPPORTED_FEATURE', field: 'currency' }] });
    expect(await request({ account_id: accountId, sandbox: false }))
      .toMatchObject({ status: 'failed', errors: [{ code: 'UNSUPPORTED_FEATURE', field: 'sandbox' }] });
    expect(await request({ account_id: accountId, brand: { domain: 'other-brand.example', countries: ['DE'] } }))
      .toMatchObject({ status: 'failed', errors: [{ code: 'INVALID_REQUEST', field: 'brand' }] });
    expect((await readAccount(accountId))?.revision).toBe(1);
  });

  it('answers an unknown account exactly like an unreachable one', async () => {
    const accountId = await openAccount();
    const unknown = await request({ account_id: 'acc_does_not_exist', brand: { domain: 'nova-athletics.example', countries: ['DE', 'AT'] } });
    const otherCaller = await request({ account_id: accountId, brand: { domain: 'nova-athletics.example', countries: ['DE', 'AT'] } }, ctx('static:buyer-b'));
    for (const result of [unknown, otherCaller]) {
      expect(result.request).toMatchObject({ state: 'rejected', errors: [{ code: 'ACCOUNT_NOT_FOUND' }] });
    }
  });

  it('applies countries and money changes with a new revision and effective_at', async () => {
    const accountId = await openAccount();
    const countries = await request({ account_id: accountId, revision: 1, brand: { domain: 'nova-athletics.example', countries: ['DE', 'AT'] } });
    expect(countries.request).toMatchObject({ state: 'resolved', resolution: 'updated', account_id: accountId, account: { revision: 2, brand: { countries: ['DE', 'AT'] } } });
    expect(countries.request.effective_at).toBeUndefined();

    const billing = await request({ account_id: accountId, revision: 2, billing: 'agent', billing_entity: { legal_name: 'Pinnacle Media GmbH', bank: { iban: 'DE00' } } });
    expect(billing.request).toMatchObject({ resolution: 'updated', account: { billing: 'agent', revision: 3 } });
    expect(billing.request.requested.billing_entity).toEqual({ legal_name: 'Pinnacle Media GmbH' });
    expect(billing.request.account.billing_entity).toEqual({ legal_name: 'Pinnacle Media GmbH' });
    const effective = new Date(billing.request.effective_at);
    expect(effective.getUTCDate()).toBe(1);
    expect(effective.getTime()).toBeGreaterThan(Date.parse(billing.request.updated_at));
  });

  it('opens a separate account only when the buyer allows it', async () => {
    const accountId = await openAccount({ operator_unit: { id: 'seat-a' } });
    const refused = await request({ account_id: accountId, operator_unit: { id: 'seat-b' } });
    expect(refused.request).toMatchObject({ state: 'rejected', errors: [{ code: 'ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT' }] });

    const separate = await request({ account_id: accountId, operator_unit: { id: 'seat-b' }, allow_separate_account: true });
    expect(separate.request).toMatchObject({ state: 'resolved', resolution: 'created', not_carried_over: [] });
    expect(separate.request.account_id).not.toBe(accountId);
    expect(separate.request.account.operator_unit).toEqual({ id: 'seat-b' });
    const named = await readAccount(accountId);
    expect(named).toMatchObject({ operator_unit: { id: 'seat-a' }, revision: 1 });

    const again = await request({ account_id: accountId, operator_unit: { id: 'seat-b' }, allow_separate_account: true });
    expect(again.request).toMatchObject({ resolution: 'matched', account_id: separate.request.account_id });
  });

  it('matches a change that would duplicate another account the caller holds', async () => {
    const named = await openAccount();
    const other = await openAccount({ brand: { domain: 'nova-athletics.example', countries: ['DE', 'AT'] } });
    const result = await request({ account_id: named, revision: 1, brand: { domain: 'nova-athletics.example', countries: ['AT', 'DE'] } });
    expect(result.request).toMatchObject({ state: 'resolved', resolution: 'matched', account_id: other });
    expect((await readAccount(named))?.brand.countries).toEqual(['DE']);
  });

  it('reviews payment terms, supersedes an open change, and re-checks revision on resolution', async () => {
    const accountId = await openAccount();
    const first = await request({ account_id: accountId, revision: 1, payment_terms: 'net_60' });
    expect(first.request).toMatchObject({ state: 'in_review', pending_action: { waiting_on: 'seller', kind: 'credit_application' } });
    const second = await request({ account_id: accountId, revision: 1, payment_terms: 'net_45' });
    expect(second.request.state).toBe('in_review');
    const superseded = await listRequests({ request_ids: [first.request.request_id] });
    expect(superseded.account_requests[0]).toMatchObject({
      state: 'rejected',
      errors: [{ code: 'CONFLICT', details: { superseded_by: second.request.request_id } }],
    });

    // The account changes outside request_account while the review runs, so
    // the review fails its revision re-check.
    await probe({ operation: 'set_account_timezone', account_id: accountId, timezone: 'Europe/Berlin' });
    await probe({ operation: 'advance_time', target_time: new Date(Date.parse(second.request.created_at) + 2 * 3_600_000).toISOString() });
    const reviewed = await listRequests({ request_ids: [second.request.request_id] });
    expect(reviewed.account_requests[0]).toMatchObject({ state: 'rejected', errors: [{ code: 'CONFLICT', field: 'revision' }] });
    expect((await readAccount(accountId))?.payment_terms).toBe('net_30');
  });

  it('keeps an open review when a later change is refused', async () => {
    const accountId = await openAccount({ operator_unit: { id: 'seat-a' } });
    const pending = await request({ account_id: accountId, revision: 1, payment_terms: 'net_60' });
    expect(pending.request.state).toBe('in_review');
    const refused = await request({ account_id: accountId, operator_unit: { id: 'seat-b' } });
    expect(refused.request).toMatchObject({ state: 'rejected', errors: [{ code: 'ACCOUNT_CHANGE_REQUIRES_NEW_ACCOUNT' }] });
    const still = await listRequests({ request_ids: [pending.request.request_id] });
    expect(still.account_requests[0].state).toBe('in_review');
  });

  it('applies reviewed payment terms with effective_at when the account did not change', async () => {
    const accountId = await openAccount();
    const pending = await request({ account_id: accountId, revision: 1, payment_terms: 'net_60' });
    await probe({ operation: 'advance_time', target_time: new Date(Date.parse(pending.request.created_at) + 2 * 3_600_000).toISOString() });
    const reviewed = await listRequests({ request_ids: [pending.request.request_id] });
    expect(reviewed.account_requests[0]).toMatchObject({ state: 'resolved', resolution: 'updated', account: { payment_terms: 'net_60', revision: 2 } });
    expect(reviewed.account_requests[0].effective_at).toBeDefined();
  });
});

describe('reporting_subscription_probe: grants, timezone, clock', () => {
  it('reduces a grant: dropped tasks are refused, the account stays listed', async () => {
    const accountId = await openAccount();
    const reduced = await probe({ operation: 'reduce_grant', account_id: accountId, allowed_tasks: ['get_reporting_status', 'sync_reporting_receipts'] });
    expect(reduced).toMatchObject({ success: true, simulated: { account_id: accountId, allowed_tasks: ['get_reporting_status', 'sync_reporting_receipts'] } });
    expect(await request({ account_id: accountId, timezone: 'Europe/Berlin' }))
      .toMatchObject({ status: 'failed', errors: [{ code: 'SCOPE_INSUFFICIENT' }] });
    expect((await readAccount(accountId))?.authorization.allowed_tasks).toEqual(['get_reporting_status', 'sync_reporting_receipts']);
  });

  it('revokes a grant, and a re-grant within retention continues the chain', async () => {
    const accountId = await openAccount();
    const authorizedAt = (await readAccount(accountId))!.authorization.authorized_at;
    const start = Date.parse(authorizedAt);
    await probe({ operation: 'advance_time', target_time: new Date(start + 86_400_000).toISOString() });
    const revoked = await probe({ operation: 'revoke_grant', account_id: accountId });
    expect(revoked.simulated.unauthorized_at).toBe(new Date(start + 86_400_000).toISOString());
    expect(await probe({ operation: 'revoke_grant', account_id: accountId })).toEqual(revoked);
    expect(await readAccount(accountId)).toBeUndefined();
    expect((await request({ account_id: accountId, timezone: 'Europe/Berlin' })).request)
      .toMatchObject({ state: 'rejected', errors: [{ code: 'ACCOUNT_NOT_FOUND' }] });

    await probe({ operation: 'advance_time', target_time: new Date(start + 3 * 86_400_000).toISOString() });
    const regranted = await probe({ operation: 'regrant', account_id: accountId });
    expect(regranted.simulated).toMatchObject({ chain: 'continued', authorized_at: authorizedAt, regranted_at: new Date(start + 3 * 86_400_000).toISOString() });
    expect((await readAccount(accountId))?.authorization).toMatchObject({ authorized_at: authorizedAt, regranted_at: regranted.simulated.regranted_at });
  });

  it('starts a new chain when the re-grant comes after the retention window', async () => {
    const accountId = await openAccount();
    const start = Date.parse((await readAccount(accountId))!.authorization.authorized_at);
    await probe({ operation: 'advance_time', target_time: new Date(start + 86_400_000).toISOString() });
    await probe({ operation: 'revoke_grant', account_id: accountId });
    const late = new Date(start + (STATUS_RETENTION_DAYS + 2) * 86_400_000).toISOString();
    await probe({ operation: 'advance_time', target_time: late });
    const regranted = await probe({ operation: 'regrant', account_id: accountId });
    expect(regranted.simulated).toMatchObject({ chain: 'new', authorized_at: late });
    expect(regranted.simulated.regranted_at).toBeUndefined();
    const authorization = (await readAccount(accountId))!.authorization;
    expect(authorization.authorized_at).toBe(late);
    expect(authorization.regranted_at).toBeUndefined();
  });

  it('changes the account timezone as an applied account change', async () => {
    const accountId = await openAccount({ timezone: 'America/New_York' });
    const changed = await probe({ operation: 'set_account_timezone', account_id: accountId, timezone: 'America/Los_Angeles' });
    expect(changed.simulated).toMatchObject({ account_id: accountId, previous_timezone: 'America/New_York', timezone: 'America/Los_Angeles' });
    expect(await readAccount(accountId)).toMatchObject({ timezone: 'America/Los_Angeles', revision: 2 });
    expect(await probe({ operation: 'set_account_timezone', account_id: accountId, timezone: '+05:00' }))
      .toMatchObject({ success: false, error: 'INVALID_PARAMS' });
  });

  it('moves the clock only forward and acts only on the caller\'s own accounts', async () => {
    await probe({ operation: 'advance_time', target_time: '2031-01-01T00:00:00Z' });
    expect(await probe({ operation: 'advance_time', target_time: '2030-12-31T00:00:00Z' }))
      .toMatchObject({ success: false, error: 'INVALID_PARAMS' });
    const accountId = await openAccount();
    expect(await probe({ operation: 'revoke_grant', account_id: accountId }, ctx('static:buyer-b')))
      .toMatchObject({ success: false, error: 'NOT_FOUND' });
    expect((await readAccount(accountId))?.authorization.authorized_at).toBe('2031-01-01T00:00:00.000Z');
  });
});
