import { describe, expect, it } from 'vitest';
import { accountRefForResolution, isIdentitylessControllerRef } from '../../src/training-agent/v6-account-helpers.js';

describe('training-agent comply_test_controller account refs', () => {
  it('treats a 3.0 identity-less sandbox assertion as naming no account', () => {
    expect(isIdentitylessControllerRef({ sandbox: true }, 'comply_test_controller')).toBe(true);
  });

  it('keeps every other ref on the strict AccountRef path', () => {
    expect(isIdentitylessControllerRef({ sandbox: true }, 'get_signals')).toBe(false);
    expect(isIdentitylessControllerRef({ sandbox: false }, 'comply_test_controller')).toBe(false);
    expect(isIdentitylessControllerRef({ account_id: 'acc_luma_shared', sandbox: true }, 'comply_test_controller')).toBe(false);
    expect(isIdentitylessControllerRef({ brand: { domain: 'acme.example' }, operator: 'acme.example', sandbox: true }, 'comply_test_controller')).toBe(false);
    expect(isIdentitylessControllerRef(undefined, 'comply_test_controller')).toBe(false);
  });

  it('drops only the controller sandbox assertion from account_id refs', () => {
    expect(accountRefForResolution({ account_id: 'acc_luma_shared', sandbox: true }, 'comply_test_controller'))
      .toEqual({ account_id: 'acc_luma_shared' });
    expect(accountRefForResolution({ account_id: 'acc_luma_shared', sandbox: true }, 'list_creatives'))
      .toEqual({ account_id: 'acc_luma_shared', sandbox: true });
  });
});

describe('training-agent sync_accounts existing-account lookup refs', () => {
  const naturalKey = {
    brand: { domain: 'acme.example' },
    operator: 'pinnacle-agency.example',
    operator_unit: { id: 'unit-1' },
    currency: 'USD',
    timezone: 'America/New_York',
    sandbox: true,
  };

  it('keeps every natural-key field and strips sync settings from the entry SDK 16 passes to resolve', () => {
    const entry = { ...naturalKey, billing: 'operator', payment_terms: 'net_30', name: 'Acme', ext: { x: 1 } };
    expect(accountRefForResolution(entry, 'sync_accounts')).toEqual(naturalKey);
  });

  it('passes account_id refs through unchanged so strict validation still applies', () => {
    const ref = { account_id: 'acc_acme', billing: 'operator' };
    expect(accountRefForResolution(ref, 'sync_accounts')).toBe(ref);
  });

  it('leaves the same entry strict on every other tool', () => {
    const entry = { ...naturalKey, billing: 'operator' };
    expect(accountRefForResolution(entry, 'get_products')).toBe(entry);
    expect(accountRefForResolution(entry, undefined)).toBe(entry);
  });
});
