import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTaskRegistry, type TaskRegistry } from '@adcp/sdk/server';
import {
  settleAsyncGetProductsTask,
  validateAsyncGetProductsPushConfig,
} from '../../src/training-agent/v6-sales-platform.js';

const ACCOUNT_ID = 'account_async_products';
const OWNER_SCOPE = 'client:async-products-test';
const TASK_ID = 'task_async_products_test';
const TASK_SCOPE = { accountId: ACCOUNT_ID, ownerScope: OWNER_SCOPE };
const COMPLETION_SCOPE = {
  accountId: ACCOUNT_ID,
  ownerScope: OWNER_SCOPE,
  registryNamespace: 'training:sales',
};
const PUSH_CONFIG = {
  url: 'http://127.0.0.1:43123/webhook',
  operationId: 'op_async_products_test',
  token: '0123456789abcdef',
};

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

async function createTask() {
  const taskRegistry = createInMemoryTaskRegistry();
  const taskRef = await taskRegistry.create({
    tool: 'get_products',
    accountId: ACCOUNT_ID,
    ownerScope: OWNER_SCOPE,
    hasWebhook: true,
    overrideTaskId: TASK_ID,
  });
  return { taskRegistry, taskRef };
}

describe('async get_products task settlement', () => {
  it('keeps a completed task completed when completion-webhook delivery rejects', async () => {
    const { taskRegistry, taskRef } = await createTask();
    const result = { status: 'completed', products: [{ product_id: 'product_async' }] };
    const emitWebhook = vi.fn().mockRejectedValue(new Error('receiver unavailable'));

    await expect(settleAsyncGetProductsTask({
      accountId: ACCOUNT_ID,
      taskId: TASK_ID,
      taskRef,
      taskRegistry,
      completionScope: COMPLETION_SCOPE,
      pushConfig: PUSH_CONFIG,
      emitWebhook,
      waitForCompletion: vi.fn().mockResolvedValue(result),
    })).resolves.toBeUndefined();

    expect(await taskRegistry.getTask(TASK_ID, TASK_SCOPE)).toMatchObject({
      status: 'completed',
      result,
    });
    expect(emitWebhook).toHaveBeenCalledOnce();
    expect(emitWebhook.mock.calls[0]?.[0]).toMatchObject({
      delivery_id: `get_products.${ACCOUNT_ID}.${TASK_ID}.completed`,
      payload: {
        operation_id: PUSH_CONFIG.operationId,
        task_id: TASK_ID,
        status: 'completed',
        result,
      },
    });
  });

  it('persists failure and emits the required terminal failed webhook', async () => {
    const { taskRegistry, taskRef } = await createTask();
    const emitWebhook = vi.fn().mockResolvedValue({ delivered: true });

    await settleAsyncGetProductsTask({
      accountId: ACCOUNT_ID,
      taskId: TASK_ID,
      taskRef,
      taskRegistry,
      completionScope: COMPLETION_SCOPE,
      pushConfig: PUSH_CONFIG,
      emitWebhook,
      waitForCompletion: vi.fn().mockRejectedValue(new Error('curation worker failed')),
    });

    expect(await taskRegistry.getTask(TASK_ID, TASK_SCOPE)).toMatchObject({
      status: 'failed',
      error: {
        code: 'SERVICE_UNAVAILABLE',
        recovery: 'transient',
        message: 'curation worker failed',
      },
      result: {
        errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'curation worker failed' }],
      },
    });
    expect(emitWebhook).toHaveBeenCalledOnce();
    expect(emitWebhook.mock.calls[0]?.[0]).toMatchObject({
      delivery_id: `get_products.${ACCOUNT_ID}.${TASK_ID}.failed`,
      payload: {
        operation_id: PUSH_CONFIG.operationId,
        task_id: TASK_ID,
        task_type: 'get_products',
        protocol: 'media-buy',
        status: 'failed',
        message: 'curation worker failed',
        token: PUSH_CONFIG.token,
        result: {
          errors: [{
            code: 'SERVICE_UNAVAILABLE',
            recovery: 'transient',
            message: 'curation worker failed',
          }],
        },
      },
    });
  });

  it('marks the task failed when writing the completed result fails', async () => {
    const { taskRegistry, taskRef } = await createTask();
    const emitWebhook = vi.fn().mockResolvedValue({ delivered: true });
    const completionFailingRegistry = {
      complete: vi.fn().mockRejectedValue(new Error('completion store unavailable')),
      fail: taskRegistry.fail.bind(taskRegistry),
    } as unknown as TaskRegistry;

    await settleAsyncGetProductsTask({
      accountId: ACCOUNT_ID,
      taskId: TASK_ID,
      taskRef,
      taskRegistry: completionFailingRegistry,
      completionScope: COMPLETION_SCOPE,
      pushConfig: PUSH_CONFIG,
      emitWebhook,
      waitForCompletion: vi.fn().mockResolvedValue({ status: 'completed', products: [] }),
    });

    expect(await taskRegistry.getTask(TASK_ID, TASK_SCOPE)).toMatchObject({
      status: 'failed',
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'completion store unavailable',
      },
      result: {
        errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'completion store unavailable' }],
      },
    });
    expect(emitWebhook.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        status: 'failed',
        result: {
          errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'completion store unavailable' }],
        },
      },
    });
  });

  it('does not reject or change failed state when failure-webhook delivery rejects', async () => {
    const { taskRegistry, taskRef } = await createTask();

    await expect(settleAsyncGetProductsTask({
      accountId: ACCOUNT_ID,
      taskId: TASK_ID,
      taskRef,
      taskRegistry,
      completionScope: COMPLETION_SCOPE,
      pushConfig: PUSH_CONFIG,
      emitWebhook: vi.fn().mockRejectedValue(new Error('failure receiver unavailable')),
      waitForCompletion: vi.fn().mockRejectedValue(new Error('curation worker failed')),
    })).resolves.toBeUndefined();

    expect(await taskRegistry.getTask(TASK_ID, TASK_SCOPE)).toMatchObject({
      status: 'failed',
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });
});

describe('async get_products push registration admission', () => {
  it('accepts a complete loopback registration only in the test environment', async () => {
    process.env.NODE_ENV = 'test';
    await expect(validateAsyncGetProductsPushConfig({
      url: PUSH_CONFIG.url,
      operation_id: PUSH_CONFIG.operationId,
      token: PUSH_CONFIG.token,
    })).resolves.toEqual(PUSH_CONFIG);
  });

  it.each([
    {
      name: 'missing operation_id',
      config: { url: PUSH_CONFIG.url },
      field: 'push_notification_config.operation_id',
    },
    {
      name: 'malformed operation_id',
      config: { url: PUSH_CONFIG.url, operation_id: 'contains whitespace' },
      field: 'push_notification_config.operation_id',
    },
    {
      name: 'short token',
      config: { url: PUSH_CONFIG.url, operation_id: PUSH_CONFIG.operationId, token: 'too-short' },
      field: 'push_notification_config.token',
    },
    {
      name: 'non-string token',
      config: { url: PUSH_CONFIG.url, operation_id: PUSH_CONFIG.operationId, token: 42 },
      field: 'push_notification_config.token',
    },
    {
      name: 'oversized token',
      config: { url: PUSH_CONFIG.url, operation_id: PUSH_CONFIG.operationId, token: 't'.repeat(4097) },
      field: 'push_notification_config.token',
    },
    {
      name: 'control character in token',
      config: { url: PUSH_CONFIG.url, operation_id: PUSH_CONFIG.operationId, token: '0123456789abcde\n' },
      field: 'push_notification_config.token',
    },
    {
      name: 'non-webhook URL scheme',
      config: { url: 'file:///tmp/callback', operation_id: PUSH_CONFIG.operationId },
      field: 'push_notification_config.url',
    },
  ])('rejects $name before task admission', async ({ config, field }) => {
    process.env.NODE_ENV = 'test';
    await expect(validateAsyncGetProductsPushConfig(config)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      recovery: 'correctable',
      field,
    });
  });

  it('rejects loopback destinations under production policy', async () => {
    process.env.NODE_ENV = 'production';
    await expect(validateAsyncGetProductsPushConfig({
      url: 'https://127.0.0.1/webhook',
      operation_id: PUSH_CONFIG.operationId,
    })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      field: 'push_notification_config.url',
    });
  });
});
