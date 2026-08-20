import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { clearSessions, flushDirtySessions, runWithSessionContext } from '../../src/training-agent/state.js';
import { executeTrainingAgentTool } from '../../src/training-agent/task-handlers.js';
import {
  supportsGetProductsRejected,
  type TrainingContext,
} from '../../src/training-agent/types.js';

const account = (accountId: string) => ({
  account_id: accountId,
});

const controllerAccount = (accountId: string) => ({
  ...account(accountId),
  sandbox: true,
});

const call = async (
  toolName: string,
  args: Record<string, unknown>,
  principal = 'buyer-a',
) => runWithSessionContext(async () => {
  const result = await executeTrainingAgentTool(
    toolName,
    args,
    { mode: 'open', principal } satisfies TrainingContext,
  );
  await flushDirtySessions();
  return result;
});

describe('get_products rejected compliance arm', () => {
  beforeEach(async () => {
    await clearSessions();
  });

  it.each([
    ['3.1', false],
    ['3.2-beta.1', false],
    ['3.2-beta.2', true],
    ['3.2-beta.3', true],
    ['3.2', true],
  ] as const)('gates support at the exact %s release boundary', (version, expected) => {
    expect(supportsGetProductsRejected(version)).toBe(expected);
  });

  it('gates the directive on the negotiated 3.2 release', async () => {
    const result = await call('comply_test_controller', {
      adcp_version: '3.1-rc.15',
      account: controllerAccount('version-gate'),
      scenario: 'force_get_products_arm',
      params: { arm: 'rejected', reason: 'This brief is outside our commercial policy.' },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      success: false,
      error: 'UNKNOWN_SCENARIO',
      adcp_version: '3.1-rc.15',
    });
  });

  it('returns a transport-success rejection once without crossing principal or account scope', async () => {
    const primaryAccount = account('primary-account');
    const otherAccount = account('other-account');
    const reason = 'The requested budget is below the minimum for this inventory.';

    const forced = await call('comply_test_controller', {
      adcp_version: '3.2-beta.3',
      account: controllerAccount('primary-account'),
      scenario: 'force_get_products_arm',
      params: {
        arm: 'rejected',
        reason,
        suggestions: ['Increase the campaign budget.'],
      },
    });
    expect(forced).toMatchObject({
      success: true,
      data: {
        success: true,
        forced: { arm: 'rejected', reason },
        adcp_version: '3.2-beta.3',
      },
    });

    const otherAccountResult = await call('get_products', {
      adcp_version: '3.2-beta.3',
      idempotency_key: 'rejected-other-account-0001',
      account: otherAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
    });
    expect(otherAccountResult.data).not.toMatchObject({ status: 'rejected' });

    const otherPrincipalResult = await call('get_products', {
      adcp_version: '3.2-beta.3',
      idempotency_key: 'rejected-other-principal-0001',
      account: primaryAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
    }, 'buyer-b');
    expect(otherPrincipalResult.data).not.toMatchObject({ status: 'rejected' });

    const wholesaleResult = await call('get_products', {
      adcp_version: '3.2-beta.3',
      idempotency_key: 'rejected-wholesale-0001',
      account: primaryAccount,
      buying_mode: 'wholesale',
    });
    expect(wholesaleResult.data).not.toMatchObject({ status: 'rejected' });

    const rejected = await call('get_products', {
      adcp_version: '3.2-beta.3',
      idempotency_key: 'rejected-primary-0001',
      account: primaryAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
      context: { correlation_id: 'rejected-once' },
    });
    expect(rejected).toMatchObject({
      success: true,
      data: {
        status: 'rejected',
        adcp_version: '3.2-beta.3',
        reason,
        suggestions: ['Increase the campaign budget.'],
        context: { correlation_id: 'rejected-once' },
      },
    });

    const consumed = await call('get_products', {
      adcp_version: '3.2-beta.3',
      idempotency_key: 'rejected-consumed-0001',
      account: primaryAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
    });
    expect(consumed.data).not.toMatchObject({ status: 'rejected' });
  });

  it('atomically consumes a one-shot rejection across parallel brief reads', async () => {
    const primaryAccount = account('parallel-rejection-account');
    const reason = 'Only one concurrent request may consume this rejection.';
    const forced = await call('comply_test_controller', {
      adcp_version: '3.2-beta.3',
      account: controllerAccount('parallel-rejection-account'),
      scenario: 'force_get_products_arm',
      params: { arm: 'rejected', reason },
    });
    expect(forced.success).toBe(true);

    const replayScope = randomUUID();
    const outcomes = await Promise.all([0, 1].map(index => call('get_products', {
      adcp_version: '3.2-beta.3',
      idempotency_key: `parallel-rejection-${replayScope}-${index}`,
      account: primaryAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
    })));
    expect(outcomes.every(outcome => outcome.success)).toBe(true);
    expect(outcomes.filter(outcome => (
      outcome.data as { status?: string; reason?: string }
    ).status === 'rejected')).toHaveLength(1);
    expect(outcomes.find(outcome => (
      outcome.data as { status?: string }
    ).status === 'rejected')?.data).toMatchObject({ reason });
  });

  it('rejects empty suggestion arrays instead of emitting a schema-invalid response', async () => {
    const result = await call('comply_test_controller', {
      adcp_version: '3.2-beta.3',
      account: controllerAccount('invalid-suggestions'),
      scenario: 'force_get_products_arm',
      params: { arm: 'rejected', reason: 'Declined.', suggestions: [] },
    });

    expect(result.data).toMatchObject({ success: false, error: 'INVALID_PARAMS' });
  });
});
