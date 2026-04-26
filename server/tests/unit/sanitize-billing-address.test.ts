import { describe, it, expect } from 'vitest';
import { sanitizeBillingAddress } from '../../src/billing/billing-address.js';

describe('sanitizeBillingAddress', () => {
  it('returns a clean object when all required fields are present', () => {
    const result = sanitizeBillingAddress({
      line1: '123 Main',
      line2: 'Apt 5',
      city: 'Amsterdam',
      state: 'NH',
      postal_code: '1011',
      country: 'NL',
    });
    expect(result).toEqual({
      line1: '123 Main',
      line2: 'Apt 5',
      city: 'Amsterdam',
      state: 'NH',
      postal_code: '1011',
      country: 'NL',
    });
  });

  it('trims whitespace', () => {
    const result = sanitizeBillingAddress({
      line1: '  123 Main  ',
      city: ' Amsterdam ',
      state: ' NH ',
      postal_code: ' 1011 ',
      country: ' NL ',
    });
    expect(result?.line1).toBe('123 Main');
    expect(result?.city).toBe('Amsterdam');
  });

  it('omits line2 when empty or whitespace-only', () => {
    const result = sanitizeBillingAddress({
      line1: '123 Main',
      line2: '   ',
      city: 'Amsterdam',
      state: 'NH',
      postal_code: '1011',
      country: 'NL',
    });
    expect(result).not.toHaveProperty('line2');
  });

  it('rejects when any required field is missing', () => {
    expect(sanitizeBillingAddress({
      line1: '123 Main',
      city: 'Amsterdam',
      state: '',
      postal_code: '1011',
      country: 'NL',
    })).toBeNull();
  });

  it('rejects when any field exceeds 200 chars', () => {
    expect(sanitizeBillingAddress({
      line1: 'x'.repeat(201),
      city: 'Amsterdam',
      state: 'NH',
      postal_code: '1011',
      country: 'NL',
    })).toBeNull();
  });

  it('drops unknown keys (allowlist behaviour)', () => {
    const result = sanitizeBillingAddress({
      line1: '123 Main',
      city: 'Amsterdam',
      state: 'NH',
      postal_code: '1011',
      country: 'NL',
      // Extra attacker-controlled payload should not survive
      __proto__: { polluted: true },
      extra: 'x'.repeat(10_000),
      injected_script: '<script>',
    } as unknown);
    expect(result).toEqual({
      line1: '123 Main',
      city: 'Amsterdam',
      state: 'NH',
      postal_code: '1011',
      country: 'NL',
    });
    expect(result).not.toHaveProperty('extra');
    expect(result).not.toHaveProperty('injected_script');
  });

  it('returns null for non-object input', () => {
    expect(sanitizeBillingAddress(null)).toBeNull();
    expect(sanitizeBillingAddress(undefined)).toBeNull();
    expect(sanitizeBillingAddress('string')).toBeNull();
    expect(sanitizeBillingAddress(42)).toBeNull();
  });
});
