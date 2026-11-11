import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('../../src/services/trust-lookup.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/trust-lookup.js')>(
    '../../src/services/trust-lookup.js'
  );
  return { ...actual, TrustLookupService: class { lookup = mocks.lookup; } };
});
vi.mock('../../src/db/brand-db.js', () => ({ brandDb: {}, BrandDatabase: class {} }));
vi.mock('../../src/db/member-db.js', () => ({ MemberDatabase: class {} }));
vi.mock('../../src/db/federated-index-db.js', () => ({ FederatedIndexDatabase: class {} }));
vi.mock('../../src/db/organization-db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/organization-db.js')>(
    '../../src/db/organization-db.js'
  );
  return { ...actual, OrganizationDatabase: class {} };
});
vi.mock('../../src/agent-service.js', () => ({ AgentService: class {} }));
vi.mock('../../src/validator.js', () => ({ AgentValidator: class {} }));
vi.mock('../../src/federated-index.js', () => ({ FederatedIndexService: class {} }));
vi.mock('../../src/brand-manager.js', () => ({ BrandManager: class {} }));
vi.mock('../../src/adagents-manager.js', () => ({ AdAgentsManager: class {} }));

const { MCPToolHandler, TOOL_DEFINITIONS } = await import('../../src/mcp-tools.js');
const { InvalidTrustLookupDomain, TrustLookupBusy, INVALID_DOMAIN_MESSAGE, LOOKUP_BUSY_MESSAGE } = await import(
  '../../src/services/trust-lookup.js'
);

const call = (args: Record<string, unknown>) =>
  new MCPToolHandler().handleToolCall('lookup_brand_authorization', args);
const text = (result: Awaited<ReturnType<typeof call>>) => {
  const first = result.content[0];
  return first.type === 'resource' && first.resource ? first.resource.text : (first as { text: string }).text;
};

describe('MCP lookup_brand_authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is listed with a required domain', () => {
    const tool = TOOL_DEFINITIONS.find(definition => definition.name === 'lookup_brand_authorization');
    expect(tool?.inputSchema.required).toEqual(['domain']);
  });

  it('returns the shared lookup result as a brand authorization resource', async () => {
    const lookup = { domain: 'nova-motors.com', status: 'not_found', claim_url: 'https://agenticadvertising.org/brand/builder?domain=nova-motors.com' };
    mocks.lookup.mockResolvedValue(lookup);
    const result = await call({ domain: 'nova-motors.com' });
    expect(mocks.lookup).toHaveBeenCalledWith('nova-motors.com');
    expect(result.isError).toBeUndefined();
    const first = result.content[0];
    expect(first.type === 'resource' && first.resource?.uri).toBe('brand://authorization/nova-motors.com');
    expect(JSON.parse(text(result))).toEqual(lookup);
  });

  it('rejects a missing domain without a lookup', async () => {
    const result = await call({});
    expect(result.isError).toBe(true);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it.each([
    [new InvalidTrustLookupDomain('internal detail'), INVALID_DOMAIN_MESSAGE],
    [new TrustLookupBusy('internal detail'), LOOKUP_BUSY_MESSAGE],
    [new Error('upstream secret'), 'The lookup could not be completed. Try again later.'],
  ])('returns a fixed caller-safe message for %s', async (error, message) => {
    mocks.lookup.mockRejectedValue(error);
    const result = await call({ domain: 'nova-motors.com' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(text(result))).toEqual({ error: message });
  });
});
