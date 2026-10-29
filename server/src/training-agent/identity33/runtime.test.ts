import { describe, expect, it, vi } from 'vitest';

vi.mock('../account-handlers.js', async () => ({
  ...await vi.importActual<typeof import('../account-handlers.js')>('../account-handlers.js'),
  accountRefForId: (accountId: string, principal: string | undefined) =>
    accountId === 'acct-1' && principal === 'bound-principal'
      ? { brand: { domain: 'Nova-Motors-7k3q.com', brand_id: 'nova_motors', countries: ['US'] }, operator: 'pinnacle-agency-7k3q.com', sandbox: true }
      : undefined,
}));

const { resolveGrantClaims } = await import('./runtime.js');
const { identity33RouteEnabled } = await import('../tenants/router.js');

describe('identity route grant claims', () => {
  it('makes one media-buying claim per proposed sync_accounts row', () => {
    const claims = resolveGrantClaims('p', 'sync_accounts', {
      accounts: [
        { brand: { domain: 'NOVA-MOTORS-7k3q.com', brand_id: 'nova_motors', countries: ['US', 'GB'] }, operator: 'Pinnacle-Agency-7k3q.com', sandbox: true, billing: 'operator' },
        { brand: { domain: 'nova-brands-7k3q.com' }, operator: 'nova-brands-7k3q.com' },
        { account_id: 'settings-only' },
      ],
    });
    expect(claims).toEqual([
      {
        brand: { domain: 'nova-motors-7k3q.com', brand_id: 'nova_motors', countries: ['US', 'GB'] },
        accountOperator: 'pinnacle-agency-7k3q.com',
        scope: 'adcp:media_buying',
        sandbox: true,
        billing: 'operator',
      },
      { brand: { domain: 'nova-brands-7k3q.com' }, accountOperator: 'nova-brands-7k3q.com', scope: 'adcp:media_buying', sandbox: false },
    ]);
  });

  it("acts for the referenced account, resolved only within the caller's own accounts", () => {
    expect(resolveGrantClaims('bound-principal', 'create_media_buy', { account: { account_id: 'acct-1' } })).toEqual([{
      brand: { domain: 'nova-motors-7k3q.com', brand_id: 'nova_motors', countries: ['US'] },
      accountOperator: 'pinnacle-agency-7k3q.com',
      scope: 'adcp:media_buying',
      sandbox: true,
    }]);
    expect(resolveGrantClaims('someone-else', 'create_media_buy', { account: { account_id: 'acct-1' } })).toEqual([]);
  });

  it('yields no claim for calls without an account, which the SDK refuses as spend', () => {
    expect(resolveGrantClaims('p', 'create_media_buy', {})).toEqual([]);
    expect(resolveGrantClaims('p', 'sync_accounts', { accounts: 'nope' })).toEqual([]);
  });
});

describe('identity route availability', () => {
  it('is off in production unless explicitly enabled', () => {
    expect(identity33RouteEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(identity33RouteEnabled({ NODE_ENV: 'production', ENABLE_ADCP_3_3_IDENTITY_ROUTE: 'true' })).toBe(true);
    expect(identity33RouteEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(identity33RouteEnabled({ NODE_ENV: 'test', ENABLE_ADCP_3_3_IDENTITY_ROUTE: '0' })).toBe(false);
  });
});

describe('fixture world hosts', () => {
  it('serves only the exact fixture hosts, never a look-alike suffix', async () => {
    const { fixtureFetch, isFixtureDomain, FIXTURE_DOMAINS } = await import('./fixture-world.js');
    expect(isFixtureDomain(FIXTURE_DOMAINS.house)).toBe(true);
    expect(isFixtureDomain('buyer.pinnacle-agency-7k3q.com')).toBe(true);
    expect(isFixtureDomain('attacker-7k3q.com')).toBe(false);
    expect(isFixtureDomain(`evil.${FIXTURE_DOMAINS.house}`)).toBe(false);
    await expect(fixtureFetch('https://attacker-7k3q.com/.well-known/trust.json')).rejects.toThrow();
    expect((await fixtureFetch(`https://${FIXTURE_DOMAINS.house}/.well-known/trust.json`)).status).toBe(200);
  });
});

describe('lab route paths', () => {
  it('the router mounts exactly the lab paths the CSRF exemption lists', async () => {
    const { TRAINING_AGENT_LAB_MCP_PATHS } = await import('../lab-route-paths.js');
    const { IDENTITY33_ROUTE, PROPOSAL_NEGOTIATION_PROFILE_ROUTES } = await import('../tenants/router.js');
    const { CREATIVE33_ROUTE } = await import('../creative33/router.js');
    expect([...PROPOSAL_NEGOTIATION_PROFILE_ROUTES.map(route => route.path), IDENTITY33_ROUTE, CREATIVE33_ROUTE].sort())
      .toEqual([...TRAINING_AGENT_LAB_MCP_PATHS].sort());
  });
});

describe('identity route principal tools in production', () => {
  it('serves sync_principal and get_principal on the identity route even where production gates experimental tools', async () => {
    const { buildSalesTenantConfig } = await import('../tenants/sales.js');
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const tools = (options: Parameters<typeof buildSalesTenantConfig>[1]) => Object.keys(
        (buildSalesTenantConfig('https://test-agent.example', options).config.serverOptions as { customTools?: Record<string, unknown> })
          .customTools ?? {},
      );
      expect(tools({ identity33: { authorize: async () => {} } })).toEqual(expect.arrayContaining(['sync_principal', 'get_principal']));
      const publicSales = tools({});
      expect(publicSales).not.toContain('sync_principal');
      expect(publicSales).not.toContain('list_account_changes');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
