import { beforeEach, describe, expect, it } from 'vitest';
import { clearSessions, flushDirtySessions, runWithSessionContext } from '../../src/training-agent/state.js';
import { executeTrainingAgentTool } from '../../src/training-agent/task-handlers.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const account = (accountId: string) => ({
  account_id: accountId,
  brand: { domain: `${accountId}.example` },
  operator: 'test-operator',
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

  it('gates the directive on the negotiated 3.2 release', async () => {
    const result = await call('comply_test_controller', {
      adcp_version: '3.1-rc.15',
      account: account('version-gate'),
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
      adcp_version: '3.2-beta.0',
      account: primaryAccount,
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
        adcp_version: '3.2-beta.0',
      },
    });

    const otherAccountResult = await call('get_products', {
      adcp_version: '3.2-beta.0',
      account: otherAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
    });
    expect(otherAccountResult.data).not.toMatchObject({ status: 'rejected' });

    const otherPrincipalResult = await call('get_products', {
      adcp_version: '3.2-beta.0',
      account: primaryAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
    }, 'buyer-b');
    expect(otherPrincipalResult.data).not.toMatchObject({ status: 'rejected' });

    const wholesaleResult = await call('get_products', {
      adcp_version: '3.2-beta.0',
      account: primaryAccount,
      buying_mode: 'wholesale',
    });
    expect(wholesaleResult.data).not.toMatchObject({ status: 'rejected' });

    const rejected = await call('get_products', {
      adcp_version: '3.2-beta.0',
      account: primaryAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
      context: { correlation_id: 'rejected-once' },
    });
    expect(rejected).toMatchObject({
      success: true,
      data: {
        status: 'rejected',
        adcp_version: '3.2-beta.0',
        reason,
        suggestions: ['Increase the campaign budget.'],
        context: { correlation_id: 'rejected-once' },
      },
    });

    const consumed = await call('get_products', {
      adcp_version: '3.2-beta.0',
      account: primaryAccount,
      buying_mode: 'brief',
      brief: 'Premium video',
    });
    expect(consumed.data).not.toMatchObject({ status: 'rejected' });
  });

  it('rejects empty suggestion arrays instead of emitting a schema-invalid response', async () => {
    const result = await call('comply_test_controller', {
      adcp_version: '3.2-beta.0',
      account: account('invalid-suggestions'),
      scenario: 'force_get_products_arm',
      params: { arm: 'rejected', reason: 'Declined.', suggestions: [] },
    });

    expect(result.data).toMatchObject({ success: false, error: 'INVALID_PARAMS' });
  });
});
