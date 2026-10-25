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
