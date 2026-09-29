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
