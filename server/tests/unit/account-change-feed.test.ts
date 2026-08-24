import { beforeEach, describe, expect, it, vi } from 'vitest';

const webhookMocks = vi.hoisted(() => ({
  emit: vi.fn(),
  proveControl: vi.fn(),
}));

vi.mock('../../src/training-agent/webhooks.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/training-agent/webhooks.js')>(),
  emitAccountNotificationWebhook: webhookMocks.emit,
}));

vi.mock('../../src/training-agent/webhook-challenge.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/training-agent/webhook-challenge.js')>(),
  proveAccountWebhookControl: webhookMocks.proveControl,
}));

import {
  clearAccountStore,
  emitAccountChangeRecordedWebhook,
  handleListAccountChanges,
  handleSyncAccounts,
  recordAccountChange,
  seedAccountFixture,
} from '../../src/training-agent/account-handlers.js';
import { handleComplyTestController } from '../../src/training-agent/comply-test-controller.js';
import { handleListCreatives, handleSyncCreatives } from '../../src/training-agent/task-handlers.js';
import { supportsAccountChangeFeed, type TrainingContext } from '../../src/training-agent/types.js';
import { toolsForTenant } from '../../src/training-agent/tenants/tool-catalog.js';

const account = { account_id: 'acc_luma_shared' };
const context: TrainingContext = { mode: 'open', principal: 'test:account-change-buyer' };

function call(args: Record<string, unknown>, ctx = context) {
  return handleListAccountChanges(args, ctx) as Record<string, any>;
}

describe('training account change feed', () => {
  beforeEach(() => {
    clearAccountStore();
    webhookMocks.emit.mockReset();
    webhookMocks.emit.mockResolvedValue({ delivered: true });
    webhookMocks.proveControl.mockReset();
    webhookMocks.proveControl.mockImplementation(async (config: { url: string }) => ({
      ok: true,
      normalizedUrl: config.url,
    }));
  });

  it('supports latest bootstrap, durable drain, and empty-tail checkpoints', () => {
    const bootstrap = call({ account, starting_position: 'latest' });
    expect(bootstrap.changes).toEqual([]);
    expect(bootstrap.has_more).toBe(false);
    expect(bootstrap.cursor).toMatch(/^accchg_/);

    const change = recordAccountChange(context.principal, {
      resource: {
        type: 'creative',
        account_id: 'acc_luma_shared',
        resource_id: 'cr_external_001',
      },
      action: 'updated',
      origin: {
        kind: 'connected_platform',
        connection_id: 'conn_shared_training_platform',
      },
      changed_paths: ['/name'],
      repair: {
        task: 'list_creatives',
      },
    });

    const drained = call({ account, cursor: bootstrap.cursor });
    expect(drained.changes).toHaveLength(1);
    expect(drained.changes[0].change_id).toBe(change.change_id);
    expect(drained.changes[0].origin.kind).toBe('connected_platform');
    expect(drained.cursor).not.toBe(bootstrap.cursor);

    const tail = call({ account, cursor: drained.cursor });
    expect(tail.changes).toEqual([]);
    expect(tail.has_more).toBe(false);
    expect(tail.cursor).toMatch(/^accchg_/);
  });

  it('binds cursors to principal, account, and normalized filters', () => {
    const bootstrap = call({
      account,
      starting_position: 'latest',
      resource_types: ['creative', 'media_buy'],
    });

    const wrongPrincipal = call(
      { account, cursor: bootstrap.cursor, resource_types: ['media_buy', 'creative'] },
      { mode: 'open', principal: 'test:other-buyer' },
    );
    expect(wrongPrincipal.errors[0].code).toBe('INVALID_REQUEST');

    const wrongFilter = call({ account, cursor: bootstrap.cursor, resource_types: ['creative'] });
    expect(wrongFilter.errors[0].code).toBe('INVALID_REQUEST');
  });

  it('returns CURSOR_EXPIRED instead of silently restarting', () => {
    const response = call({ account, cursor: 'accchg_missing' });
    expect(response.errors[0].code).toBe('CURSOR_EXPIRED');
    expect(response.errors[0].recovery).toBe('correctable');
    expect(response.errors[0].details.restart_with).toEqual({ starting_position: 'latest' });
  });

  it('exposes the task only under 3.2-or-newer negotiation', () => {
    expect(supportsAccountChangeFeed('3.1')).toBe(false);
    expect(supportsAccountChangeFeed('3.2-beta.1')).toBe(true);
    expect(toolsForTenant('sales', { adcpVersion: '3.1' })).not.toContain('list_account_changes');
    expect(toolsForTenant('sales', { adcpVersion: '3.2-beta.1' })).toContain('list_account_changes');
  });

  it('discovers a creative added outside AdCP after the buyer checkpoint', async () => {
    const bootstrap = call({ account, starting_position: 'latest' });
    const creativeId = 'cr_connected_platform_added';

    const seeded = await handleComplyTestController({
      account: { account_id: account.account_id, sandbox: true },
      scenario: 'seed_creative',
      params: {
        creative_id: creativeId,
        fixture: {
          name: 'Connected platform creative',
          status: 'approved',
          format_kind: 'image',
          manifest: {
            format_kind: 'image',
            assets: {
              image: {
                asset_type: 'image',
                url: 'https://test-assets.adcontextprotocol.org/shared/connected.png',
                width: 300,
                height: 250,
              },
            },
          },
        },
      },
    }, context) as Record<string, any>;
    expect(seeded.success).toBe(true);

    const drained = call({ account, cursor: bootstrap.cursor });
    expect(drained.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'created',
        origin: expect.objectContaining({ kind: 'connected_platform' }),
        resource: expect.objectContaining({ type: 'creative', resource_id: creativeId }),
      }),
    ]));

    const snapshot = await handleListCreatives({
      account,
      filters: { creative_ids: [creativeId] },
    }, context) as Record<string, any>;
    expect(snapshot.creatives).toEqual(expect.arrayContaining([
      expect.objectContaining({ creative_id: creativeId, status: 'approved' }),
    ]));
  });

  it('does not share change history when two principals reuse one wire account id', () => {
    const accountId = 'acc_colliding_wire_id';
    const principalA: TrainingContext = { mode: 'open', principal: 'test:collision-a' };
    const principalB: TrainingContext = { mode: 'open', principal: 'test:collision-b' };
    for (const [ctx, domain] of [[principalA, 'alpha.example'], [principalB, 'beta.example']] as const) {
      expect(seedAccountFixture({
        params: {
          account_id: accountId,
          fixture: {
            brand: { domain },
            operator: 'buyer.example',
            sandbox: true,
          },
        },
      }, ctx).success).toBe(true);
    }

    const bCheckpoint = call(
      { account: { account_id: accountId }, starting_position: 'latest' },
      principalB,
    );
    recordAccountChange(principalA.principal, {
      resource: { type: 'creative', account_id: accountId, resource_id: 'cr_private_a' },
      action: 'created',
      origin: { kind: 'adcp' },
      repair: { task: 'list_creatives' },
    });

    const bDrain = call({ account: { account_id: accountId }, cursor: bCheckpoint.cursor }, principalB);
    expect(bDrain.changes).toEqual([]);
  });

  it('fans one logical change out to every proven shared-account subscriber', async () => {
    const principals = [
      { mode: 'open', principal: 'test:shared-subscriber-a' },
      { mode: 'open', principal: 'test:shared-subscriber-b' },
    ] satisfies TrainingContext[];

    for (const [index, subscriberContext] of principals.entries()) {
      const response = await handleSyncAccounts({
        accounts: [{
          account,
          notification_configs: [{
            subscriber_id: `subscriber-${index + 1}`,
            url: `https://buyer-${index + 1}.example.com/webhooks/account-changes`,
            event_types: ['account.change_recorded'],
            active: true,
          }],
        }],
      }, subscriberContext) as Record<string, any>;
      expect(response).toHaveProperty('accounts');
      expect(response.accounts[0]).toEqual(expect.objectContaining({ notification_configs: expect.any(Array) }));
      expect(response.accounts[0].notification_configs[0].active).toBe(true);
    }
    webhookMocks.emit.mockClear();

    const change = recordAccountChange(principals[0].principal, {
      resource: {
        type: 'creative',
        account_id: account.account_id,
        resource_id: 'cr_shared_fanout',
      },
      action: 'created',
      origin: { kind: 'connected_platform' },
      repair: { task: 'list_creatives' },
    });
    await emitAccountChangeRecordedWebhook(principals[0].principal, change);

    expect(webhookMocks.emit).toHaveBeenCalledTimes(2);
    const deliveries = webhookMocks.emit.mock.calls.map(([delivery]) => delivery);
    expect(deliveries.map(delivery => delivery.payload.subscriber_id).sort()).toEqual([
      'subscriber-1',
      'subscriber-2',
    ]);
    for (const delivery of deliveries) {
      expect(delivery.notificationType).toBe('account.change_recorded');
      expect(delivery.payload.notification_id).toBe(change.change_id);
      expect(delivery.payload.change_id).toBe(change.change_id);
      expect(delivery.payload.resource.resource_id).toBe('cr_shared_fanout');
    }
  });

  it('records an AdCP creative mutation once and suppresses an unchanged replay', async () => {
    const creative = {
      creative_id: 'cr_adcp_change_once',
      name: 'Stable creative',
      format_kind: 'image',
      assets: {
        image: {
          asset_type: 'image',
          url: 'https://test-assets.adcontextprotocol.org/shared/stable.png',
          width: 300,
          height: 250,
        },
      },
    };
    const bootstrap = call({ account, starting_position: 'latest' });
    await handleSyncCreatives({ account, creatives: [creative] }, context);
    const firstDrain = call({ account, cursor: bootstrap.cursor });
    expect(firstDrain.changes.filter((change: any) => change.resource.resource_id === creative.creative_id)).toHaveLength(1);

    await handleSyncCreatives({ account, creatives: [creative] }, context);
    const replayDrain = call({ account, cursor: firstDrain.cursor });
    expect(replayDrain.changes.filter((change: any) => change.resource.resource_id === creative.creative_id)).toHaveLength(0);
  });
});
