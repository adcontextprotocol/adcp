import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AccountRefValidationError,
  accountScopeFromRef,
  canonicalizeAccountRef,
} from '../../src/training-agent/account-scope.js';
import { getProductsSessionKeyFromArgs, sessionKeyFromArgs } from '../../src/training-agent/state.js';
import {
  customToolFor,
  deriveAccountScope,
} from '../../src/training-agent/tenants/custom-tool-helper.js';

describe('canonical AccountRef scope', () => {
  it('uses the account-id namespace verbatim', () => {
    expect(accountScopeFromRef({ account_id: 'acct_123' })).toBe('a:acct_123');
  });

  it('normalizes the natural identity and defaults sandbox to false', () => {
    expect(canonicalizeAccountRef({
      brand: { domain: 'House.Example', brand_id: 'spark' },
      operator: 'Pinnacle.Example',
    })).toEqual({
      kind: 'natural',
      brand: { domain: 'house.example', brand_id: 'spark' },
      operator: 'pinnacle.example',
      sandbox: false,
    });
    expect(accountScopeFromRef({
      brand: { domain: 'House.Example', brand_id: 'spark' },
      operator: 'Pinnacle.Example',
    })).toBe('n:house.example:spark:pinnacle.example:0');
  });

  it('partitions every natural-key discriminator', () => {
    const base = { brand: { domain: 'house.example' }, operator: 'one.example' };
    const scopes = new Set([
      accountScopeFromRef(base),
      accountScopeFromRef({ ...base, operator: 'two.example' }),
      accountScopeFromRef({ ...base, sandbox: true }),
      accountScopeFromRef({ ...base, brand: { ...base.brand, brand_id: 'spark' } }),
      accountScopeFromRef({ ...base, brand: { ...base.brand, market: 'NL' } }),
      accountScopeFromRef({ ...base, operator_region: 'emea' }),
    ]);
    expect(scopes.size).toBe(6);
  });

  it('represents a country-market brand under a regional operator', () => {
    const account = {
      brand: { domain: 'Nova-Athletics.Example', market: 'NL' },
      operator: 'Nova-Athletics.Example',
      operator_region: 'emea',
    };
    expect(canonicalizeAccountRef(account)).toEqual({
      kind: 'natural',
      brand: { domain: 'nova-athletics.example', market: 'NL' },
      operator: 'nova-athletics.example',
      operator_region: 'emea',
      sandbox: false,
    });
    expect(accountScopeFromRef(account))
      .toBe('n:nova-athletics.example:-:nova-athletics.example:0:m:NL:r:emea');
  });

  it.each([
    [{}, 'exactly one identity'],
    [{ account_id: 'acct_123', brand: { domain: 'house.example' }, operator: 'one.example' }, 'exactly one identity'],
    [{ account_id: 'acct_123', sandbox: false }, 'exactly one identity'],
    [{ brand: { domain: 'house.example' } }, 'exactly one identity'],
    [{ brand: { domain: 'house.example' }, operator: 'one.example', unexpected: true }, "field 'unexpected'"],
    [{ brand: { domain: 'house.example', market: 'nl' }, operator: 'one.example' }, 'ISO 3166-1'],
    [{ brand: { domain: 'house.example' }, operator: 'one.example', operator_region: 'EMEA' }, 'lowercase'],
    [{ account_id: 'acct_123', unexpected: true }, "field 'unexpected'"],
  ])('rejects invalid closed-union shape %#', (value, message) => {
    expect(() => canonicalizeAccountRef(value)).toThrow(AccountRefValidationError);
    expect(() => canonicalizeAccountRef(value)).toThrow(message);
  });
});

describe('canonical session scope', () => {
  it('uses the complete account identity without requiring a principal', () => {
    expect(getProductsSessionKeyFromArgs({
      account: {
        brand: { domain: 'House.Example', brand_id: 'spark' },
        operator: 'Pinnacle.Example',
        sandbox: true,
      },
    }, 'open')).toBe('open:n:house.example:spark:pinnacle.example:1');
    expect(getProductsSessionKeyFromArgs({ account: { account_id: 'acct_123' } }, 'open'))
      .toBe('open:a:acct_123');
    expect(getProductsSessionKeyFromArgs({
      account: { brand: { domain: 'house.example' }, operator: 'house.example' },
    }, 'open')).toBe('open:house.example');
  });

  it('keeps account-id identities disjoint from fallback and natural-account namespaces', () => {
    expect(getProductsSessionKeyFromArgs({ account: { account_id: 'default' } }, 'open'))
      .not.toBe(getProductsSessionKeyFromArgs({}, 'open'));
    expect(getProductsSessionKeyFromArgs({ account: { account_id: 'house.example' } }, 'open'))
      .not.toBe(getProductsSessionKeyFromArgs({
        account: { brand: { domain: 'house.example' }, operator: 'house.example' },
      }, 'open'));
  });

  it('uses hashed principal plus the complete canonical account scope when supplied', () => {
    const base = {
      account: {
        brand: { domain: 'house.example' },
        operator: 'one.example',
      },
    };
    const first = sessionKeyFromArgs(base, 'open', undefined, undefined, 'workos:org_one');
    const same = sessionKeyFromArgs(base, 'open', undefined, undefined, 'workos:org_one');
    const otherPrincipal = sessionKeyFromArgs(base, 'open', undefined, undefined, 'workos:org_two');
    const otherOperator = sessionKeyFromArgs({
      account: { ...base.account, operator: 'two.example' },
    }, 'open', undefined, undefined, 'workos:org_one');

    expect(first).toBe(same);
    expect(first).toMatch(/^open:p:[a-f0-9]{64}:n:house\.example:-:one\.example:0$/);
    expect(new Set([first, otherPrincipal, otherOperator]).size).toBe(3);
  });

  it('keeps top-level brand and plans fallbacks compatible in authenticated mode', () => {
    const topLevel = sessionKeyFromArgs(
      { brand: { domain: 'House.Example' } },
      'open', undefined, undefined, 'buyer-one',
    );
    const plan = sessionKeyFromArgs(
      { plans: [{ brand: { domain: 'house.example' } }] },
      'open', undefined, undefined, 'buyer-one',
    );
    expect(topLevel).toBe(plan);
    expect(topLevel).toMatch(/:b:house\.example$/);
  });

  it('rejects malformed AccountRef before deriving an authenticated key', () => {
    expect(() => sessionKeyFromArgs({
      account: {
        account_id: 'acct_123',
        brand: { domain: 'house.example' },
        operator: 'one.example',
      },
    }, 'open', undefined, undefined, 'buyer-one')).toThrow(AccountRefValidationError);
  });
});

describe('custom-tool account scoping', () => {
  it('reuses the shared canonical scope for top-level and usage accounts', () => {
    const account = {
      brand: { domain: 'House.Example', brand_id: 'spark' },
      operator: 'Pinnacle.Example',
      sandbox: true,
    };
    expect(deriveAccountScope({ account }))
      .toBe('n:house.example:spark:pinnacle.example:1');
    expect(deriveAccountScope({ usage: [{ account }] }))
      .toBe('n:house.example:spark:pinnacle.example:1');
  });

  it('does not silently fall through an explicit invalid top-level account', () => {
    expect(() => deriveAccountScope({
      account: null,
      usage: [{ account: { account_id: 'acct_usage' } }],
    })).toThrow(AccountRefValidationError);
  });

  it('returns INVALID_REQUEST before an idempotency-protected handler sees a mixed ref', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const tool = customToolFor('test_mutation', 'test', z.any(), handler, {
      enforceIdempotency: true,
    });
    const response = await (tool.handler as any)({
      idempotency_key: 'test-account-scope-key-0001',
      account: {
        account_id: 'acct_123',
        brand: { domain: 'house.example' },
        operator: 'one.example',
      },
    }, { authInfo: { clientId: 'buyer-one' } });

    expect(response.isError).toBe(true);
    expect(response.structuredContent.adcp_error).toMatchObject({
      code: 'INVALID_REQUEST',
      field: 'account',
      recovery: 'correctable',
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
