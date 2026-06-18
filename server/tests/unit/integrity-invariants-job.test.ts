import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectEnvMismatch: vi.fn(),
  runAllInvariants: vi.fn(),
  notifySystemError: vi.fn(),
  getPool: vi.fn(() => ({ query: vi.fn() })),
  getWorkos: vi.fn(() => ({})),
}));

async function loadJob(stripeValue: unknown = { customers: {} }) {
  vi.resetModules();

  vi.doMock('../../src/audit/integrity/index.js', () => ({
    ALL_INVARIANTS: [{ name: 'stripe-customer-resolves' }],
    runAllInvariants: mocks.runAllInvariants,
  }));
  vi.doMock('../../src/audit/integrity/env-mismatch.js', () => ({
    detectEnvMismatch: mocks.detectEnvMismatch,
  }));
  vi.doMock('../../src/db/client.js', () => ({
    getPool: mocks.getPool,
  }));
  vi.doMock('../../src/billing/stripe-client.js', () => ({
    stripe: stripeValue,
  }));
  vi.doMock('../../src/auth/workos-client.js', () => ({
    getWorkos: mocks.getWorkos,
  }));
  vi.doMock('../../src/addie/error-notifier.js', () => ({
    notifySystemError: mocks.notifySystemError,
  }));

  return import('../../src/addie/jobs/integrity-invariants.js');
}

describe('runIntegrityInvariantsJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.detectEnvMismatch.mockReturnValue(undefined);
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 0,
      violations_by_severity: { critical: 0, warning: 0, info: 0 },
      violations: [],
    });
  });

  it('notifies when the invariant runner is skipped due to environment mismatch', async () => {
    mocks.detectEnvMismatch.mockReturnValue('live Stripe key against staging database');
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      ran: false,
      skippedReason: 'live Stripe key against staging database',
    }));
    expect(mocks.runAllInvariants).not.toHaveBeenCalled();
    expect(mocks.notifySystemError).toHaveBeenCalledWith({
      source: 'integrity-invariants',
      errorMessage: 'Integrity invariants skipped: live Stripe key against staging database',
    });
  });

  it('notifies when Stripe is not configured', async () => {
    const { runIntegrityInvariantsJob } = await loadJob(null);

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      ran: false,
      skippedReason: 'STRIPE_SECRET_KEY not set',
    }));
    expect(mocks.runAllInvariants).not.toHaveBeenCalled();
    expect(mocks.notifySystemError).toHaveBeenCalledWith({
      source: 'integrity-invariants',
      errorMessage: 'Integrity invariants skipped: STRIPE_SECRET_KEY not set',
    });
  });

  it('notifies with a critical violation summary when invariants find stale Stripe state', async () => {
    mocks.runAllInvariants.mockResolvedValue({
      total_violations: 1,
      violations_by_severity: { critical: 1, warning: 0, info: 0 },
      violations: [{
        invariant: 'stripe-customer-resolves',
        severity: 'critical',
        subject_type: 'organization',
        subject_id: 'org_1',
        message: 'Org references non-existent Stripe customer cus_missing',
      }],
    });
    const { runIntegrityInvariantsJob } = await loadJob();

    const result = await runIntegrityInvariantsJob();

    expect(result).toEqual(expect.objectContaining({
      ran: true,
      totalViolations: 1,
      criticalViolations: 1,
    }));
    expect(mocks.notifySystemError).toHaveBeenCalledWith({
      source: 'integrity-invariants',
      errorMessage: expect.stringContaining('stripe-customer-resolves'),
    });
  });
});
