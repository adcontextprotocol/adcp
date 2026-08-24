import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAccountStore,
  handleListAccountChanges,
  recordAccountChange,
} from '../../src/training-agent/account-handlers.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

const account = { account_id: 'acc_luma_shared' };
const context: TrainingContext = { mode: 'open', principal: 'test:account-change-buyer' };

function call(args: Record<string, unknown>, ctx = context) {
  return handleListAccountChanges(args, ctx) as Record<string, any>;
}

describe('training account change feed', () => {
  beforeEach(() => clearAccountStore());

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
        keys: { creative_id: 'cr_external_001' },
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
});
