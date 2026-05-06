import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { AuthenticationRequiredError } from '@adcp/sdk';
import {
  buildAgentOAuthAuthorizeUrl,
  isOAuthRequiredError,
} from '../../src/routes/helpers/agent-oauth-prompt.js';
import type { AgentContextDatabase } from '../../src/db/agent-context-db.js';

type StubbedDb = Pick<AgentContextDatabase, 'getByOrgAndUrl' | 'create'>;

function makeDb(): { [K in keyof StubbedDb]: ReturnType<typeof vi.fn> } {
  return {
    getByOrgAndUrl: vi.fn(),
    create: vi.fn(),
  };
}

const ORG = 'org_abc';
const AGENT = 'https://seller-platform.example.com/mcp';

describe('buildAgentOAuthAuthorizeUrl', () => {
  let db: ReturnType<typeof makeDb>;
  const ORIGINAL_BASE_URL = process.env.BASE_URL;

  beforeEach(() => {
    db = makeDb();
    process.env.BASE_URL = 'https://aao.example.org';
  });

  afterAll(() => {
    if (ORIGINAL_BASE_URL === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = ORIGINAL_BASE_URL;
  });

  const call = (organizationId: string | undefined, options?: Parameters<typeof buildAgentOAuthAuthorizeUrl>[3]) =>
    buildAgentOAuthAuthorizeUrl(AGENT, organizationId, db as unknown as AgentContextDatabase, options);

  it('returns null when there is no organization to scope the agent context to', async () => {
    expect(await call(undefined)).toBeNull();
    expect(db.getByOrgAndUrl).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });

  it('reuses an existing agent context row', async () => {
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx_existing' });

    const url = await call(ORG);

    expect(url).toBe('https://aao.example.org/api/oauth/agent/start?agent_context_id=ctx_existing');
    expect(db.create).not.toHaveBeenCalled();
  });

  it('creates a new agent context when none exists', async () => {
    db.getByOrgAndUrl.mockResolvedValueOnce(null);
    db.create.mockResolvedValueOnce({ id: 'ctx_new' });

    const url = await call(ORG);

    expect(db.create).toHaveBeenCalledWith({
      organization_id: ORG,
      agent_url: AGENT,
      agent_name: 'seller-platform.example.com',
      agent_type: 'unknown',
      protocol: 'mcp',
    });
    expect(url).toBe('https://aao.example.org/api/oauth/agent/start?agent_context_id=ctx_new');
  });

  it('threads pending_task and pending_params for auto-retry', async () => {
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx1' });

    const url = await call(ORG, {
      pendingTask: 'get_products',
      pendingParams: { brief: 'q4 holiday' },
    });

    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('pending_task')).toBe('get_products');
    expect(parsed.searchParams.get('pending_params')).toBe(JSON.stringify({ brief: 'q4 holiday' }));
  });

  it('drops billing_entity and invoice_recipient from pending_params before serializing into the URL', async () => {
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx1' });

    const url = await call(ORG, {
      pendingTask: 'create_media_buy',
      pendingParams: {
        brief: 'campaign',
        billing_entity: {
          name: 'Acme Inc',
          tax_id: 'SECRET-TAX',
          vat_id: 'SECRET-VAT',
          bank: { iban: 'SECRET-IBAN' },
        },
        invoice_recipient: {
          email: 'ap@acme.com',
          bank: { account: 'SECRET-ACCT' },
        },
      },
    });

    const parsed = new URL(url!);
    const sentParams = JSON.parse(parsed.searchParams.get('pending_params')!);
    expect(sentParams).toEqual({ brief: 'campaign' });
    expect(JSON.stringify(sentParams)).not.toMatch(/SECRET/);
  });

  it('passes return_to through verbatim', async () => {
    db.getByOrgAndUrl.mockResolvedValueOnce({ id: 'ctx1' });

    const url = await call(ORG, { returnTo: '/profile/edit' });

    expect(new URL(url!).searchParams.get('return_to')).toBe('/profile/edit');
  });

  it('returns null when context creation fails', async () => {
    db.getByOrgAndUrl.mockResolvedValueOnce(null);
    db.create.mockRejectedValueOnce(new Error('db down'));

    expect(await call(ORG)).toBeNull();
  });
});

describe('isOAuthRequiredError', () => {
  it('matches AuthenticationRequiredError', () => {
    const err = new AuthenticationRequiredError(AGENT, undefined, 'requires auth');
    expect(isOAuthRequiredError(err)).toBe(true);
  });

  it('matches an Error whose message carries the SDK OAuth phrasing', () => {
    const err = new Error(`Agent ${AGENT} requires OAuth authorization. Provide an OAuthFlowHandler.`);
    expect(isOAuthRequiredError(err)).toBe(true);
  });

  it('matches an AUTH_REQUIRED protocol error string', () => {
    expect(isOAuthRequiredError('AUTH_REQUIRED: please reauthorize')).toBe(true);
  });

  it('does not match a transport-level connection failure', () => {
    expect(isOAuthRequiredError(new Error('Failed to discover MCP endpoint'))).toBe(false);
    expect(isOAuthRequiredError('ETIMEDOUT')).toBe(false);
  });

  it('handles null/undefined safely', () => {
    expect(isOAuthRequiredError(null)).toBe(false);
    expect(isOAuthRequiredError(undefined)).toBe(false);
  });
});
