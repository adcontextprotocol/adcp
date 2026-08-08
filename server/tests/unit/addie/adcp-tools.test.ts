import { describe, expect, it, vi } from 'vitest';

const executeTrainingAgentTool = vi.hoisted(() => vi.fn());

vi.mock('../../../src/training-agent/task-handlers.js', () => ({
  executeTrainingAgentTool,
}));
import {
  ADCP_TASK_REGISTRY,
  ADCP_TOOLS,
  createAdcpToolHandlers,
  validateAccountRefParam,
} from '../../../src/addie/mcp/adcp-tools.js';

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
});

describe('call_adcp_task handler validation boundary', () => {
  const callAdcpTask = createAdcpToolHandlers(null).get('call_adcp_task');

  it('does not reject proposal-mode create_media_buy as missing packages', async () => {
    await expect(callAdcpTask?.({
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
    })).resolves.toContain('Invalid agent URL format');
  });

  it('rejects mixed package and proposal create_media_buy modes before URL validation', async () => {
    await expect(callAdcpTask?.({
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
    })).resolves.toContain('Use either packages array or proposal_id + total_budget, not both');
  });

  it('rejects create_media_buy before URL validation when idempotency_key is missing', async () => {
    await expect(callAdcpTask?.({
      agent_url: 'http://example.com',
      task: 'create_media_buy',
      params: {
        account: { account_id: 'acct_123' },
        brand: { domain: 'acme.example' },
        packages: [{ product_id: 'prod_123', pricing_option_id: 'cpm', budget: 1000 }],
        start_time: 'asap',
        end_time: '2099-07-31T23:59:59Z',
      },
    })).resolves.toContain('idempotency_key is required');
  });

  it('rejects update_media_buy before URL validation when idempotency_key is missing', async () => {
    await expect(callAdcpTask?.({
      agent_url: 'http://example.com',
      task: 'update_media_buy',
      params: {
        account: { account_id: 'acct_123' },
        media_buy_id: 'mb_123',
      },
    })).resolves.toContain('idempotency_key is required');
  });

  it('rejects invalid update_media_buy account references before URL validation', async () => {
    await expect(callAdcpTask?.({
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
    })).resolves.toContain('account.operator must be a string domain, not an array');
  });
});

describe('call_adcp_task training module isolation', () => {
  it('passes the shared current module to the embedded training agent', async () => {
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
