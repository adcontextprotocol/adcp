import { describe, expect, it } from 'vitest';
import {
  accountRefFromCtx,
  taskOwnerScopeForPlatformContext,
  webhookTenantScopeForPlatformContext,
} from '../../src/training-agent/v6-sales-platform.js';
import { sessionKeyFromArgs } from '../../src/training-agent/state.js';

describe('framework account scope', () => {
  const naturalAccount = {
    brand: { domain: 'acmeoutdoor.example' },
    operator: 'pinnacle-agency.example',
  };

  it('preserves framework sandbox mode on an original natural account ref', () => {
    const account = accountRefFromCtx({
      mode: 'sandbox',
      ctx_metadata: { account_ref: naturalAccount },
    });

    expect(account).toEqual({ ...naturalAccount, sandbox: true });
    expect(sessionKeyFromArgs({ account }, 'open')).toBe(
      sessionKeyFromArgs({ account: { ...naturalAccount, sandbox: true } }, 'open'),
    );
  });

  it('does not add sandbox mode outside a trusted sandbox context', () => {
    const account = accountRefFromCtx({
      mode: 'production',
      ctx_metadata: { account_ref: naturalAccount },
    });

    expect(account).toEqual(naturalAccount);
    expect(sessionKeyFromArgs({ account }, 'open')).toBe(
      sessionKeyFromArgs({ account: naturalAccount }, 'open'),
    );
  });
});

describe('seller-managed task owner scope', () => {
  it('preserves captured session scope when an agent is also resolved', () => {
    expect(taskOwnerScopeForPlatformContext({
      sessionKey: 'buyer-session',
      agent: { agent_url: 'https://buyer-agent.example/mcp' },
      account: { ctx_metadata: { task_owner_scope: 'session:buyer-session' } },
    }, 'account-1')).toBe('session:buyer-session');
  });

  it('uses the canonical request precedence when no scope was captured', () => {
    expect(taskOwnerScopeForPlatformContext({
      sessionKey: 'buyer-session',
      agent: { agent_url: 'https://buyer-agent.example/mcp' },
    }, 'account-1')).toBe('session:buyer-session');
  });
});

describe('seller-managed webhook tenant scope', () => {
  it('uses the exact transport partition captured before RequestContext redaction', () => {
    const captured = JSON.stringify([
      'session', 'buyer-session', null, 'account-1', 'client:buyer-principal',
    ]);
    expect(webhookTenantScopeForPlatformContext({
      account: {
        id: 'account-1',
        authInfo: { principal: 'buyer-principal' },
        ctx_metadata: { webhook_tenant_scope: captured },
      },
    })).toBe(captured);
  });

  it('matches the SDK session/account/principal partition exactly', () => {
    expect(webhookTenantScopeForPlatformContext({
      sessionKey: 'buyer-session',
      authInfo: { clientId: 'buyer-principal' },
      account: { id: 'account-1', tenant_id: 'sales' },
    })).toBe(JSON.stringify([
      'session', 'buyer-session', 'sales', 'account-1', 'client:buyer-principal',
    ]));
  });

  it('matches the SDK outer transport partition before compact caller scope is added', () => {
    const callerMutationScope = {
      tenant_id: 'sales', principal_id: 'principal-1', account_id: 'account-1',
    };
    const first = webhookTenantScopeForPlatformContext({
      sessionKey: 'transport-a', callerMutationScope,
    });
    const reconnected = webhookTenantScopeForPlatformContext({
      sessionKey: 'transport-b', callerMutationScope,
    });
    expect(first).toBe(JSON.stringify(['session', 'transport-a', null, null, null]));
    expect(reconnected).toBe(JSON.stringify(['session', 'transport-b', null, null, null]));
  });
});
