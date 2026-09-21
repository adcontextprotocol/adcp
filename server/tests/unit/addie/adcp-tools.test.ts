import { describe, expect, it, vi } from 'vitest';
import { extractAdcpErrorInfo } from '@adcp/sdk';

const executeTrainingAgentTool = vi.hoisted(() => vi.fn());

vi.mock('../../../src/training-agent/task-handlers.js', () => ({
  executeTrainingAgentTool,
}));
import {
  ADCP_TASK_REGISTRY,
  ADCP_TOOLS,
  CANONICAL_ADCP_TASK_NAMES,
  CUSTOM_ADCP_TASK_NAMES,
  LEGACY_ADCP_TASK_NAMES,
  adcpExecutionMode,
  createAdcpToolHandlers,
  executeWithTransientAdcpRetry,
  typedSdkTransientTransportResult,
  validateAccountRefParam,
  validateGetProductsParams,
} from '../../../src/addie/mcp/adcp-tools.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION } from '../../../src/training-agent/types.js';
import {
  ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE,
  AddieTransientTransportError,
} from '../../../src/utils/sdk-safe-fetch.js';

function modelContext(result: unknown): string {
  return typeof result === 'string'
    ? result
    : String((result as { model_context?: unknown } | undefined)?.model_context ?? '');
}

describe('AdCP SDK execution boundaries', () => {
  it('classifies every registered task in exactly one explicit SDK boundary', () => {
    const classifications = [
      ...CANONICAL_ADCP_TASK_NAMES,
      ...LEGACY_ADCP_TASK_NAMES,
      ...CUSTOM_ADCP_TASK_NAMES,
    ].filter(task => task !== 'get_adcp_capabilities');

    expect(classifications.sort()).toEqual(Object.keys(ADCP_TASK_REGISTRY).sort());
    expect(new Set(classifications).size).toBe(classifications.length);
  });

  it('uses canonical execution for primary AdCP tasks', () => {
    expect(adcpExecutionMode('get_products')).toBe('canonical');
    expect(adcpExecutionMode('list_products')).toBe('canonical');
    expect(adcpExecutionMode('request_proposals')).toBe('canonical');
    expect(adcpExecutionMode('refine_proposals')).toBe('canonical');
    expect(adcpExecutionMode('decline_proposals')).toBe('canonical');
    expect(adcpExecutionMode('buy_products')).toBe('canonical');
    expect(adcpExecutionMode('accept_proposal')).toBe('canonical');
    expect(adcpExecutionMode('control_media_buy')).toBe('canonical');
    expect(adcpExecutionMode('create_media_buy')).toBe('canonical');
    expect(adcpExecutionMode('sync_creatives')).toBe('canonical');
  });

  it('reserves legacy execution for compatibility-only standard tasks', () => {
    expect(adcpExecutionMode('list_creative_formats')).toBe('legacy');
    expect(adcpExecutionMode('build_creative')).toBe('legacy');
    expect(adcpExecutionMode('get_rights')).toBe('legacy');
  });

  it('routes unknown extension tasks through the custom-task boundary', () => {
    expect(adcpExecutionMode('sync_catalogs')).toBe('custom');
    expect(adcpExecutionMode('create_collection_list')).toBe('custom');
    expect(adcpExecutionMode('vendor_custom_task')).toBe('custom');
  });
});

describe('validateAccountRefParam', () => {
  it('accepts the account_id variant', () => {
    expect(validateAccountRefParam({ account_id: 'acct_123' })).toBeNull();
  });

  it('accepts the natural-key variant with operator as a string', () => {
    expect(validateAccountRefParam({
      brand: { domain: 'acme.example' },
      operator: 'operator.example',
    })).toBeNull();
  });

  it('rejects operator arrays with a targeted correction', () => {
    expect(validateAccountRefParam({
      brand: { domain: 'acme.example' },
      operator: ['operator.example'],
    })).toBe('account.operator must be a string domain, not an array. Use "operator.example", not ["operator.example"].');
  });

  it('rejects invalid natural-key domains', () => {
    expect(validateAccountRefParam({
      brand: { domain: 'not a domain' },
      operator: 'operator.example',
    })).toContain('account.brand.domain must be a valid lowercase domain');
  });

  it('rejects invalid operator domains', () => {
    expect(validateAccountRefParam({
      brand: { domain: 'acme.example' },
      operator: 'https://operator.example',
    })).toContain('account.operator must be a valid lowercase domain string');
  });

  it('rejects unknown nested BrandRef fields', () => {
    expect(validateAccountRefParam({
      brand: { domain: 'acme.example', unknown: true },
      operator: 'operator.example',
    })).toContain('fields not allowed by BrandRef');
  });

  it('rejects invalid values on allowed BrandRef fields', () => {
    expect(validateAccountRefParam({
      brand: { domain: 'acme.example', brand_id: 123 },
      operator: 'operator.example',
    })).toContain('account.brand.brand_id must be a lowercase alphanumeric string');

    expect(validateAccountRefParam({
      brand: { domain: 'acme.example', industries: 'retail' },
      operator: 'operator.example',
    })).toContain('account.brand.industries must be an array of strings');
  });

  it('gives a targeted correction for sandbox with account_id', () => {
    expect(validateAccountRefParam({
      account_id: 'acct_123',
      sandbox: true,
    })).toContain('account.sandbox is only valid with the natural-key AccountRef');
  });

  it('rejects merged AccountRef variants', () => {
    expect(validateAccountRefParam({
      account_id: 'acct_123',
      brand: { domain: 'acme.example' },
      operator: 'operator.example',
    })).toContain('exactly one AccountRef variant');
  });
});

describe('ADCP task registry account validation', () => {
  const baseCreateMediaBuyParams = {
    idempotency_key: 'create-media-buy-test-key',
    brand: { domain: 'acme.example' },
    packages: [{ product_id: 'prod_123', pricing_option_id: 'cpm', budget: 1000 }],
    start_time: 'asap',
    end_time: '2099-07-31T23:59:59Z',
  };

  it('requires account on create_media_buy', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.(baseCreateMediaBuyParams)).toContain('account is required');
  });

  it('requires idempotency_key on create_media_buy', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    const { idempotency_key: _idempotencyKey, ...withoutKey } = baseCreateMediaBuyParams;
    expect(validate?.({
      ...withoutKey,
      account: { account_id: 'acct_123' },
    })).toContain('idempotency_key is required');
  });

  it('rejects operator arrays on create_media_buy', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      ...baseCreateMediaBuyParams,
      account: {
        brand: { domain: 'acme.example' },
        operator: ['operator.example'],
      },
    })).toContain('account.operator must be a string domain, not an array');
  });

  it('accepts a natural-key account on create_media_buy', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      ...baseCreateMediaBuyParams,
      account: {
        brand: { domain: 'acme.example' },
        operator: 'operator.example',
      },
    })).toBeNull();
  });

  it('accepts proposal-mode create_media_buy without packages', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      idempotency_key: 'proposal-mode-test-key',
      account: { account_id: 'acct_123' },
      brand: { domain: 'acme.example' },
      proposal_id: 'proposal_123',
      total_budget: { amount: 50000, currency: 'USD' },
      start_time: 'asap',
      end_time: '2099-07-31T23:59:59Z',
    })).toBeNull();
  });

  it('requires total_budget for proposal-mode create_media_buy', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      idempotency_key: 'proposal-mode-test-key',
      account: { account_id: 'acct_123' },
      brand: { domain: 'acme.example' },
      proposal_id: 'proposal_123',
      start_time: 'asap',
      end_time: '2099-07-31T23:59:59Z',
    })).toContain('total_budget is required');
  });

  it('rejects malformed packages when present', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      ...baseCreateMediaBuyParams,
      account: { account_id: 'acct_123' },
      packages: {},
    })).toContain('packages must be a non-empty array');

    expect(validate?.({
      ...baseCreateMediaBuyParams,
      account: { account_id: 'acct_123' },
      packages: [],
    })).toContain('packages must be a non-empty array');
  });

  it('rejects malformed proposal-mode fields when present', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      idempotency_key: 'proposal-mode-test-key',
      account: { account_id: 'acct_123' },
      brand: { domain: 'acme.example' },
      proposal_id: '',
      total_budget: { amount: 50000, currency: 'USD' },
      start_time: 'asap',
      end_time: '2099-07-31T23:59:59Z',
    })).toContain('proposal_id must be a non-empty string');

    expect(validate?.({
      idempotency_key: 'proposal-mode-test-key',
      account: { account_id: 'acct_123' },
      brand: { domain: 'acme.example' },
      proposal_id: 'proposal_123',
      total_budget: {},
      start_time: 'asap',
      end_time: '2099-07-31T23:59:59Z',
    })).toContain('total_budget.amount must be a non-negative number');
  });

  it('rejects mixed package and proposal create_media_buy modes', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      ...baseCreateMediaBuyParams,
      account: { account_id: 'acct_123' },
      proposal_id: 'proposal_123',
      total_budget: { amount: 50000, currency: 'USD' },
    })).toContain('Use either packages array or proposal_id + total_budget, not both');
  });

  it('rejects total_budget outside proposal mode', () => {
    const validate = ADCP_TASK_REGISTRY.create_media_buy.validate;
    expect(validate?.({
      ...baseCreateMediaBuyParams,
      account: { account_id: 'acct_123' },
      total_budget: { amount: 50000, currency: 'USD' },
    })).toContain('total_budget is only valid with proposal_id');
  });
});

describe('call_adcp_task tool reference', () => {
  it('shows account in the create_media_buy quick reference', () => {
    const tool = ADCP_TOOLS.find((candidate) => candidate.name === 'call_adcp_task');
    const params = tool?.input_schema.properties?.params as { description?: string } | undefined;
    expect(params?.description).toContain('create_media_buy: { idempotency_key, account:');
    expect(params?.description).toContain('operator: "operator.example"');
    expect(params?.description).toContain('proposal_id + total_budget');
  });

  it('publishes a typed get_products surface with the enforced stable key', () => {
    const tool = ADCP_TOOLS.find((candidate) => candidate.name === 'call_adcp_get_products');
    expect(tool?.input_schema.required).toEqual(['agent_url', 'idempotency_key', 'buying_mode']);
    expect(tool?.input_schema.additionalProperties).toBe(false);
    expect(tool?.input_schema.properties.idempotency_key).toMatchObject({
      type: 'string', minLength: 16,
    });
    expect(tool?.input_schema.properties.refine).toMatchObject({ type: 'array', minItems: 1 });
  });

  it('enforces get_products mode-specific requirements without JSON Schema conditionals', () => {
    const key = 'stable-products-request-key';
    expect(validateGetProductsParams({ idempotency_key: key, buying_mode: 'brief' })).toContain('brief is required');
    expect(validateGetProductsParams({ idempotency_key: key, buying_mode: 'brief', brief: 'Launch plan' })).toBeNull();
    expect(validateGetProductsParams({ idempotency_key: key, buying_mode: 'wholesale', brief: 'not allowed' })).toContain('not allowed');
    expect(validateGetProductsParams({ idempotency_key: key, buying_mode: 'refine', refine: [{ scope: 'product', product_id: 'p1', action: 'include' }] })).toBeNull();
  });
});

describe('bounded AdCP transport retry', () => {
  const transient = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
  const sdkTransportFailure = (retryAfterMs?: number) => {
    const error = new AddieTransientTransportError(
      retryAfterMs === undefined ? {} : { retryAfterMs },
    );
    return {
      success: false,
      status: 'failed',
      error: error.message,
      // This is the exact projection used by @adcp/sdk's TaskExecutor.createErrorResult.
      adcpError: extractAdcpErrorInfo(error.data),
    };
  };

  it('retries a read exactly once after a typed transient failure', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(executeWithTransientAdcpRetry({ task: 'list_products', params: {}, execute, sleep }))
      .resolves.toEqual({ value: 'ok', attempts: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('does not retry validation/application errors or unkeyed mutations', async () => {
    const validation = vi.fn().mockRejectedValue(new Error('invalid request'));
    await expect(executeWithTransientAdcpRetry({ task: 'list_products', params: {}, execute: validation }))
      .rejects.toThrow('invalid request');
    expect(validation).toHaveBeenCalledTimes(1);

    const mutation = vi.fn().mockRejectedValue(transient);
    await expect(executeWithTransientAdcpRetry({ task: 'create_media_buy', params: {}, execute: mutation }))
      .rejects.toBe(transient);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('retries get_products as a read while preserving its adapter-required key and request object', async () => {
    const params = { idempotency_key: 'same-logical-operation-key', buying_mode: 'wholesale' };
    const seen: Record<string, unknown>[] = [];
    const execute = vi.fn(async () => {
      seen.push(params);
      if (seen.length === 1) throw transient;
      return 'ok';
    });
    await executeWithTransientAdcpRetry({ task: 'get_products', params, execute, sleep: async () => undefined });
    expect(seen).toEqual([params, params]);
  });

  it('retries a true mutation only with its exact valid idempotency key', async () => {
    const params = { idempotency_key: 'same-mutating-operation-key' };
    const seen: Record<string, unknown>[] = [];
    const execute = vi.fn(async () => {
      seen.push(params);
      if (seen.length === 1) throw transient;
      return 'ok';
    });
    await executeWithTransientAdcpRetry({ task: 'create_media_buy', params, execute, sleep: async () => undefined });
    expect(seen).toEqual([params, params]);
  });

  it('honors only bounded retry-after delays', async () => {
    const failure = Object.assign(new Error('busy'), { status: 503, retryAfterMs: 2_001 });
    const execute = vi.fn().mockRejectedValue(failure);
    await expect(executeWithTransientAdcpRetry({ task: 'list_products', params: {}, execute }))
      .rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retries an SDK-converted typed transport result exactly once', async () => {
    const failure = sdkTransportFailure(125);
    expect(typedSdkTransientTransportResult(failure)).toEqual({ retryAfterMs: 125 });
    const execute = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ success: true, status: 'completed', data: { products: [] } });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(executeWithTransientAdcpRetry({ task: 'get_products', params: {}, execute, sleep }))
      .resolves.toMatchObject({ attempts: 2, value: { success: true } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(125);
  });

  it('does not retry seller protocol results or unfenced mutations', async () => {
    const protocolFailure = {
      success: false,
      status: 'failed',
      error: 'Seller is temporarily unavailable',
      adcpError: { code: 'SERVICE_UNAVAILABLE', recovery: 'transient', retryAfterMs: 100 },
    };
    const protocolExecute = vi.fn().mockResolvedValue(protocolFailure);
    await expect(executeWithTransientAdcpRetry({ task: 'get_products', params: {}, execute: protocolExecute }))
      .resolves.toEqual({ value: protocolFailure, attempts: 1 });
    expect(protocolExecute).toHaveBeenCalledTimes(1);

    const mutationExecute = vi.fn().mockResolvedValue(sdkTransportFailure());
    await expect(executeWithTransientAdcpRetry({ task: 'create_media_buy', params: {}, execute: mutationExecute }))
      .resolves.toMatchObject({ attempts: 1 });
    expect(mutationExecute).toHaveBeenCalledTimes(1);
  });

  it('does not exceed two attempts when an SDK-style retry throws', async () => {
    const retryFailure = Object.assign(new Error('socket reset again'), { code: 'ECONNRESET' });
    const execute = vi.fn()
      .mockResolvedValueOnce(sdkTransportFailure())
      .mockRejectedValueOnce(retryFailure);
    await expect(executeWithTransientAdcpRetry({ task: 'get_products', params: {}, execute, sleep: async () => undefined }))
      .rejects.toMatchObject({ name: 'AdcpTransientRetryExhaustedError', attempts: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('call_adcp_task handler validation boundary', () => {
  const callAdcpTask = createAdcpToolHandlers(null).get('call_adcp_task');

  it('does not reject proposal-mode create_media_buy as missing packages', async () => {
    expect(modelContext(await callAdcpTask?.({
      agent_url: 'not-a-url',
      task: 'create_media_buy',
      params: {
        idempotency_key: 'proposal-mode-handler-test-key',
        account: { account_id: 'acct_123' },
        brand: { domain: 'acme.example' },
        proposal_id: 'proposal_123',
        total_budget: { amount: 50000, currency: 'USD' },
        start_time: 'asap',
        end_time: '2099-07-31T23:59:59Z',
      },
    }))).toContain('Invalid agent URL format');
  });

  it('rejects mixed package and proposal create_media_buy modes before URL validation', async () => {
    expect(modelContext(await callAdcpTask?.({
      agent_url: 'http://example.com',
      task: 'create_media_buy',
      params: {
        idempotency_key: 'mixed-mode-handler-test-key',
        account: { account_id: 'acct_123' },
        brand: { domain: 'acme.example' },
        packages: [{ product_id: 'prod_123', pricing_option_id: 'cpm', budget: 1000 }],
        proposal_id: 'proposal_123',
        total_budget: { amount: 50000, currency: 'USD' },
        start_time: 'asap',
        end_time: '2099-07-31T23:59:59Z',
      },
    }))).toContain('Use either packages array or proposal_id + total_budget, not both');
  });

  it('rejects create_media_buy before URL validation when idempotency_key is missing', async () => {
    expect(modelContext(await callAdcpTask?.({
      agent_url: 'http://example.com',
      task: 'create_media_buy',
      params: {
        account: { account_id: 'acct_123' },
        brand: { domain: 'acme.example' },
        packages: [{ product_id: 'prod_123', pricing_option_id: 'cpm', budget: 1000 }],
        start_time: 'asap',
        end_time: '2099-07-31T23:59:59Z',
      },
    }))).toContain('idempotency_key is required');
  });

  it('rejects get_products before URL validation when idempotency_key is missing', async () => {
    expect(modelContext(await callAdcpTask?.({
      agent_url: 'http://example.com',
      task: 'get_products',
      params: {
        buying_mode: 'wholesale',
        account: { account_id: 'acct_123' },
      },
    }))).toContain('idempotency_key is required');
  });

  it('rejects update_media_buy before URL validation when idempotency_key is missing', async () => {
    expect(modelContext(await callAdcpTask?.({
      agent_url: 'http://example.com',
      task: 'update_media_buy',
      params: {
        account: { account_id: 'acct_123' },
        media_buy_id: 'mb_123',
      },
    }))).toContain('idempotency_key is required');
  });

  it('rejects invalid update_media_buy account references before URL validation', async () => {
    expect(modelContext(await callAdcpTask?.({
      agent_url: 'http://example.com',
      task: 'update_media_buy',
      params: {
        idempotency_key: 'update-media-buy-test-key',
        account: {
          brand: { domain: 'acme.example' },
          operator: ['operator.example'],
        },
        media_buy_id: 'mb_123',
      },
    }))).toContain('account.operator must be a string domain, not an array');
  });
});

describe('call_adcp_task training module isolation', () => {
  it('limits anonymous demo execution to the training agent', async () => {
    const handlers = createAdcpToolHandlers(
      null,
      undefined,
      { trainingAgentOnly: true },
    );
    const getCapabilities = handlers.get('get_adcp_capabilities');

    expect(modelContext(await getCapabilities?.({
      agent_url: 'https://sales-agent.example/mcp',
    }))).toContain('anonymous demo can only call the AdCP training agent');
  });

  it('allows anonymous demo execution against a proposal training profile', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({ success: true, data: { tasks: [] } });
    const handlers = createAdcpToolHandlers(
      null,
      undefined,
      { trainingAgentOnly: true },
    );
    const getCapabilities = handlers.get('get_adcp_capabilities');

    await getCapabilities?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/profiles/typed-negotiation/mcp',
    });

    expect(executeTrainingAgentTool).toHaveBeenCalledWith(
      'get_adcp_capabilities',
      { adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION, adcp_major_version: 3 },
      expect.objectContaining({ proposalNegotiationProfile: 'typed-negotiation' }),
    );
  });

  it('passes the request-scoped anonymous principal into training execution', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({ success: true, data: { tasks: [] } });
    const handlers = createAdcpToolHandlers(
      null,
      undefined,
      {
        trainingAgentOnly: true,
        trainingPrincipal: 'anonymous-chat:thread-one',
      },
    );

    await handlers.get('get_adcp_capabilities')?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/profiles/typed-negotiation/mcp',
    });

    expect(executeTrainingAgentTool).toHaveBeenCalledWith(
      'get_adcp_capabilities',
      expect.any(Object),
      expect.objectContaining({ principal: 'anonymous-chat:thread-one' }),
    );
  });

  it('preserves the proposal profile selected by the training-agent URL', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({ success: true, data: { results: [] } });
    const handlers = createAdcpToolHandlers({
      workos_user: { workos_user_id: 'user_training' },
    } as any, { moduleId: 'S1' });
    const callAdcpTask = handlers.get('call_adcp_task');
    const params = {
      adcp_version: '3.2-rc.0',
      adcp_major_version: 3,
      idempotency_key: 'proposal-refinement-key',
      refinements: [{ proposal_id: 'proposal_123', action: 'finalize' }],
    };

    await callAdcpTask?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/profiles/constrained-seller/mcp',
      task: 'refine_proposals',
      params,
    });

    expect(executeTrainingAgentTool).toHaveBeenCalledWith(
      'refine_proposals',
      params,
      expect.objectContaining({
        mode: 'training',
        userId: 'user_training',
        moduleId: 'S1',
        proposalNegotiationProfile: 'constrained-seller',
      }),
    );
  });

  it('preserves the tenant selected by the training-agent URL', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({ success: true, data: { session_id: 'si_test' } });
    const callAdcpTask = createAdcpToolHandlers(null).get('call_adcp_task');

    await callAdcpTask?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/si/mcp',
      task: 'si_initiate_session',
      params: {
        idempotency_key: 'si-tenant-routing-test-key',
        intent: 'Compare electric vehicles',
        identity: { consent_granted: false },
      },
    });

    expect(executeTrainingAgentTool).toHaveBeenCalledWith(
      'si_initiate_session',
      expect.any(Object),
      expect.objectContaining({ tenantId: 'si' }),
    );
  });

  it('does not label an SI protocol error as a successful sandbox demo', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({
      success: true,
      data: { errors: [{ code: 'INVALID_OFFERING_TOKEN', message: 'Call si_get_offering first.' }] },
    });
    const callAdcpTask = createAdcpToolHandlers(null).get('call_adcp_task');

    const output = await callAdcpTask?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/si/mcp',
      task: 'si_initiate_session',
      params: {
        idempotency_key: 'si-error-rendering-test-key',
        intent: 'Compare electric vehicles',
        identity: { consent_granted: false },
        offering_token: 'invalid-token',
      },
    });

    expect(modelContext(output)).toContain('protocol error');
    expect(modelContext(output)).toContain('INVALID_OFFERING_TOKEN');
    expect(modelContext(output)).not.toContain('succeeded');
    expect(output).toMatchObject({
      status: 'error',
      telemetry: {
        operation: 'si_initiate_session', error_code: 'INVALID_OFFERING_TOKEN',
        error_category: 'protocol', retryable: false, attempts: 1,
      },
    });
  });

  it('redacts credential-shaped protocol data from model-visible success output', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({
      success: true,
      data: { access_token: 'secret-token-value', note: 'Bearer top-secret-value' },
    });
    const output = await createAdcpToolHandlers(null).get('call_adcp_task')?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/mcp',
      task: 'list_products',
      params: {},
    });
    expect(modelContext(output)).toContain('[redacted]');
    expect(modelContext(output)).not.toContain('secret-token-value');
    expect(modelContext(output)).not.toContain('top-secret-value');
  });

  it('uses the current prerelease when Addie discovers an unpinned proposal profile', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({ success: true, data: { media_buy: {} } });
    const handlers = createAdcpToolHandlers(null);
    const getCapabilities = handlers.get('get_adcp_capabilities');

    await getCapabilities?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/profiles/typed-negotiation/mcp',
    });

    expect(executeTrainingAgentTool).toHaveBeenCalledWith(
      'get_adcp_capabilities',
      { adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION, adcp_major_version: 3 },
      expect.objectContaining({
        mode: 'training',
        proposalNegotiationProfile: 'typed-negotiation',
      }),
    );
  });

  it('forwards the exact caller-owned get_products idempotency key', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({ success: true, data: { products: [] } });
    const handlers = createAdcpToolHandlers({
      workos_user: { workos_user_id: 'user_training' },
    } as any, { moduleId: 'S2' });
    const callAdcpTask = handlers.get('call_adcp_task');
    const params = {
      idempotency_key: 'caller-owned-products-key',
      buying_mode: 'wholesale',
      account: { account_id: 'acct_123' },
    };

    await callAdcpTask?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/mcp',
      task: 'get_products',
      params,
    });

    expect(executeTrainingAgentTool).toHaveBeenCalledWith(
      'get_products',
      params,
      expect.objectContaining({ mode: 'training', userId: 'user_training', moduleId: 'S2' }),
    );
  });

  it('passes the shared current module to the embedded training agent', async () => {
    executeTrainingAgentTool.mockReset();
    executeTrainingAgentTool.mockResolvedValue({ success: true, data: { formats: [] } });
    const trainingModuleContext = { moduleId: 'S1' };
    const handlers = createAdcpToolHandlers({
      workos_user: { workos_user_id: 'user_training' },
    } as any, trainingModuleContext);
    const callAdcpTask = handlers.get('call_adcp_task');

    await callAdcpTask?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/sales/mcp',
      task: 'list_creative_formats',
      params: {},
    });
    trainingModuleContext.moduleId = 'S4';
    await callAdcpTask?.({
      agent_url: 'https://test-agent.adcontextprotocol.org/governance/mcp',
      task: 'list_creative_formats',
      params: {},
    });

    expect(executeTrainingAgentTool).toHaveBeenNthCalledWith(
      1,
      'list_creative_formats',
      {},
      expect.objectContaining({ mode: 'training', userId: 'user_training', moduleId: 'S1' }),
    );
    expect(executeTrainingAgentTool).toHaveBeenNthCalledWith(
      2,
      'list_creative_formats',
      {},
      expect.objectContaining({ mode: 'training', userId: 'user_training', moduleId: 'S4' }),
    );
  });
});
