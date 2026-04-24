import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { resolveWorkosUserForSubscription } from '../../src/billing/resolve-subscription-user.js';

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
}) {
  return {
    userManagement: {
      getUser: opts.getUser ?? vi.fn().mockRejectedValue(new Error('not configured')),
      listUsers: opts.listUsers ?? vi.fn().mockResolvedValue({ data: [] }),
    },
  } as any;
}

describe('resolveWorkosUserForSubscription', () => {
  it('resolves via subscription metadata when workos_user_id is present', async () => {
    const user = { id: 'user_1', email: 'a@b.com', firstName: 'Alice' };
    const workos = makeWorkos({ getUser: vi.fn().mockResolvedValue(user) });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'user_1' }),
      customer: makeCustomer({ email: 'unrelated@b.com' }),
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user, source: 'subscription_metadata' });
    expect(workos.userManagement.getUser).toHaveBeenCalledWith('user_1');
    expect(workos.userManagement.listUsers).not.toHaveBeenCalled();
  });

  it('falls back to customer metadata when subscription metadata is absent', async () => {
    const user = { id: 'user_2', email: 'b@c.com' };
    const workos = makeWorkos({
      getUser: vi.fn().mockImplementation(async (id) => {
        if (id === 'user_2') return user;
        throw new Error('missing');
      }),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: null, metadata: { workos_user_id: 'user_2' } }),
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user, source: 'customer_metadata' });
  });

  it('does not re-try the same id found in subscription metadata', async () => {
    const getUser = vi.fn().mockRejectedValue(new Error('no user'));
    const workos = makeWorkos({ getUser });
    await resolveWorkosUserForSubscription({
      subscription: makeSubscription({ workos_user_id: 'user_X' }),
      customer: makeCustomer({ metadata: { workos_user_id: 'user_X' } }),
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
      workos,
      logger: makeLogger(),
    });
    expect(result).toEqual({ user, source: 'email_lookup' });
    expect(listUsers).toHaveBeenCalledWith({ email: 'c@d.com' });
  });

  it('returns null when every source fails', async () => {
    const logger = makeLogger();
    const workos = makeWorkos({
      listUsers: vi.fn().mockResolvedValue({ data: [] }),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: 'none@nowhere.com' }),
      workos,
      logger,
    });
    expect(result).toBeNull();
  });

  it('returns null and logs when email lookup itself throws', async () => {
    const logger = makeLogger();
    const workos = makeWorkos({
      listUsers: vi.fn().mockRejectedValue(new Error('workos 500')),
    });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: 'x@y.com' }),
      workos,
      logger,
    });
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it('skips email lookup when customer has no email', async () => {
    const listUsers = vi.fn();
    const workos = makeWorkos({ listUsers });
    const result = await resolveWorkosUserForSubscription({
      subscription: makeSubscription(),
      customer: makeCustomer({ email: null }),
      workos,
      logger: makeLogger(),
    });
    expect(result).toBeNull();
    expect(listUsers).not.toHaveBeenCalled();
  });
});
