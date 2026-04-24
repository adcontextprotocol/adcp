import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { resolveWorkosUserForSubscription } from '../../src/billing/resolve-subscription-user.js';

const ORG_ID = 'org_test';

function makeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeSubscription(metadata: Record<string, string> = {}): Stripe.Subscription {
  return { id: 'sub_1', metadata, customer: 'cus_1' } as any;
}

function makeCustomer(opts: { email?: string | null; metadata?: Record<string, string> } = {}): Stripe.Customer {
  return {
    id: 'cus_1',
    email: opts.email ?? null,
    metadata: opts.metadata ?? {},
    deleted: false,
  } as any;
}

function makeWorkos(opts: {
  getUser?: (id: string) => Promise<any>;
  listUsers?: (args: { email: string }) => Promise<{ data: any[] }>;
  listOrganizationMemberships?: (args: { userId: string; organizationId: string }) => Promise<{ data: any[] }>;
}) {
  return {
    userManagement: {
      getUser: opts.getUser ?? vi.fn().mockRejectedValue(new Error('not configured')),
      listUsers: opts.listUsers ?? vi.fn().mockResolvedValue({ data: [] }),
      // Default: user is a member.
      listOrganizationMemberships: opts.listOrganizationMemberships ??
        vi.fn().mockResolvedValue({ data: [{ id: 'om_1' }] }),
    },
  } as any;
}

describe('resolveWorkosUserForSubscription', () => {
  it('resolves via subscription metadata when workos_user_id is present and user is org member', async () => {
    const user = { id: 'user_1', email: 'a@b.com', firstName: 'Alice' };
    const workos = makeWorkos({ getUser: vi.fn().mockResolvedValue(user) });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'user_1' }),
      customer: makeCustomer({ email: 'unrelated@b.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user, source: 'subscription_metadata' });
    expect(workos.userManagement.getUser).toHaveBeenCalledWith('user_1');
    expect(workos.userManagement.listOrganizationMemberships).toHaveBeenCalledWith({
      userId: 'user_1',
      organizationId: ORG_ID,
    });
    expect(workos.userManagement.listUsers).not.toHaveBeenCalled();
  });

  it('falls through when subscription-metadata user is not a member of the subscribing org', async () => {
    const subUser = { id: 'user_stale', email: 'stale@b.com' };
    const emailUser = { id: 'user_correct', email: 'right@b.com' };
    const listOrganizationMemberships = vi.fn().mockImplementation(async ({ userId }) => {
      if (userId === 'user_correct') return { data: [{ id: 'om' }] };
      return { data: [] };
    });
    const workos = makeWorkos({
      getUser: vi.fn().mockResolvedValue(subUser),
      listUsers: vi.fn().mockResolvedValue({ data: [emailUser] }),
      listOrganizationMemberships,
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'user_stale' }),
      customer: makeCustomer({ email: 'right@b.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user: emailUser, source: 'email_lookup' });
  });

  it('falls back to customer metadata when subscription metadata getUser throws', async () => {
    const user = { id: 'user_cust', email: 'c@b.com' };
    const getUser = vi.fn().mockImplementation(async (id) => {
      if (id === 'user_sub_gone') throw new Error('404 user deleted');
      if (id === 'user_cust') return user;
      throw new Error('unexpected');
    });
    const workos = makeWorkos({ getUser });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'user_sub_gone' }),
      customer: makeCustomer({ metadata: { workos_user_id: 'user_cust' } }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user, source: 'customer_metadata' });
  });

  it('does not re-fetch when subscription and customer metadata share the same id', async () => {
    const getUser = vi.fn().mockRejectedValue(new Error('no user'));
    const workos = makeWorkos({ getUser });
    await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'user_X' }),
      customer: makeCustomer({ metadata: { workos_user_id: 'user_X' } }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('falls back to email lookup when both metadata sources fail to resolve', async () => {
    const user = { id: 'user_3', email: 'c@d.com' };
    const listUsers = vi.fn().mockResolvedValue({ data: [user] });
    const getUser = vi.fn().mockRejectedValue(new Error('no such user'));
    const workos = makeWorkos({ getUser, listUsers });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'deleted_user' }),
      customer: makeCustomer({ email: 'c@d.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user, source: 'email_lookup' });
    expect(listUsers).toHaveBeenCalledWith({ email: 'c@d.com' });
  });

  it('picks the org-member when email lookup returns multiple users with the same email', async () => {
    const wrongOrgUser = { id: 'user_otherorg', email: 'shared@co.com' };
    const rightOrgUser = { id: 'user_thisorg', email: 'shared@co.com' };
    const listOrganizationMemberships = vi.fn().mockImplementation(async ({ userId }) => {
      if (userId === 'user_thisorg') return { data: [{ id: 'om' }] };
      return { data: [] };
    });
    const workos = makeWorkos({
      listUsers: vi.fn().mockResolvedValue({ data: [wrongOrgUser, rightOrgUser] }),
      listOrganizationMemberships,
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: 'shared@co.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user: rightOrgUser, source: 'email_lookup' });
  });

  it('returns null when every source fails', async () => {
    const workos = makeWorkos({
      listUsers: vi.fn().mockResolvedValue({ data: [] }),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: 'none@nowhere.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toBeNull();
  });

  it('returns null and logs context when email lookup itself throws', async () => {
    const logger = makeLogger();
    const workos = makeWorkos({
      listUsers: vi.fn().mockRejectedValue(new Error('workos 500')),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: 'x@y.com' }),
      organizationId: ORG_ID,
      workos,
      logger,
    });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'x@y.com', customerId: 'cus_1', subscriptionId: 'sub_1' }),
      expect.stringContaining('email lookup failed'),
    );
  });

  it('skips email lookup when customer has no email', async () => {
    const listUsers = vi.fn();
    const workos = makeWorkos({ listUsers });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: null }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toBeNull();
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('returns null when all email-match candidates belong to other orgs', async () => {
    const u1 = { id: 'user_a', email: 'shared@co.com' };
    const u2 = { id: 'user_b', email: 'shared@co.com' };
    const workos = makeWorkos({
      listUsers: vi.fn().mockResolvedValue({ data: [u1, u2] }),
      listOrganizationMemberships: vi.fn().mockResolvedValue({ data: [] }),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: 'shared@co.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toBeNull();
  });

  it('treats an empty-string subscription workos_user_id as absent', async () => {
    const user = { id: 'user_email', email: 'x@y.com' };
    const workos = makeWorkos({
      listUsers: vi.fn().mockResolvedValue({ data: [user] }),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: '' }),
      customer: makeCustomer({ email: 'x@y.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user, source: 'email_lookup' });
    expect(workos.userManagement.getUser).not.toHaveBeenCalled();
  });

  it('falls through when the membership check itself throws', async () => {
    const user = { id: 'user_1', email: 'a@b.com' };
    const emailUser = { id: 'user_fallback', email: 'fallback@b.com' };
    const workos = makeWorkos({
      getUser: vi.fn().mockResolvedValue(user),
      listUsers: vi.fn().mockResolvedValue({ data: [emailUser] }),
      listOrganizationMemberships: vi.fn().mockImplementation(async ({ userId }) => {
        if (userId === 'user_1') throw new Error('workos 503');
        return { data: [{ id: 'om' }] };
      }),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'user_1' }),
      customer: makeCustomer({ email: 'fallback@b.com' }),
      organizationId: ORG_ID,
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user: emailUser, source: 'email_lookup' });
  });
});
