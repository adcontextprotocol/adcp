import { describe, it, expect } from 'vitest';
import { validateOrganizationName, validateEmail } from '../../src/middleware/validation.js';

describe('validateOrganizationName', () => {
  it('accepts basic ASCII names', () => {
    expect(validateOrganizationName('Acme Corp')).toEqual({ valid: true });
    expect(validateOrganizationName("Brian O'Kelley")).toEqual({ valid: true });
    expect(validateOrganizationName('Test-Org_123')).toEqual({ valid: true });
    expect(validateOrganizationName('Company Inc.')).toEqual({ valid: true });
  });

  it('accepts names with Unicode letters', () => {
    expect(validateOrganizationName("Florian Mühlhans's Workspace")).toEqual({ valid: true });
    expect(validateOrganizationName('José García')).toEqual({ valid: true });
    expect(validateOrganizationName('Ørsted Energy')).toEqual({ valid: true });
    expect(validateOrganizationName('Ñoño Corp')).toEqual({ valid: true });
    expect(validateOrganizationName('François Détienne')).toEqual({ valid: true });
    expect(validateOrganizationName('東京広告')).toEqual({ valid: true });
  });

  it('accepts names with curly/smart apostrophes from mobile keyboards', () => {
    expect(validateOrganizationName('O\u2019Kelley Corp')).toEqual({ valid: true });
    expect(validateOrganizationName('Florian M\u00FChlhans\u2019s Workspace')).toEqual({ valid: true });
  });

  it('rejects empty or whitespace-only names', () => {
    expect(validateOrganizationName('')).toMatchObject({ valid: false });
    expect(validateOrganizationName('   ')).toMatchObject({ valid: false });
  });

  it('rejects names shorter than 2 characters', () => {
    expect(validateOrganizationName('A')).toMatchObject({ valid: false });
  });

  it('rejects names longer than 100 characters', () => {
    expect(validateOrganizationName('A'.repeat(101))).toMatchObject({ valid: false });
  });

  it('rejects names starting with special characters', () => {
    expect(validateOrganizationName('-Dash First')).toMatchObject({ valid: false });
    expect(validateOrganizationName("'Quote First")).toMatchObject({ valid: false });
  });

  it('rejects names with consecutive spaces', () => {
    expect(validateOrganizationName('Too  Many  Spaces')).toMatchObject({ valid: false });
  });

  it('rejects names with HTML/XSS patterns', () => {
    expect(validateOrganizationName('<script>alert(1)</script>')).toMatchObject({
      valid: false,
      error: 'Organization name contains invalid characters',
    });
    expect(validateOrganizationName('A<script>alert(1)</script>')).toMatchObject({
      valid: false,
      error: 'Organization name contains invalid characters',
    });
  });

  it('accepts names at boundary lengths', () => {
    expect(validateOrganizationName('AB')).toEqual({ valid: true });
    expect(validateOrganizationName('A'.repeat(100))).toEqual({ valid: true });
  });

  it('rejects names with bidi override characters', () => {
    expect(validateOrganizationName('Test\u202Eorg')).toMatchObject({ valid: false });
    expect(validateOrganizationName('Test\u202Dorg')).toMatchObject({ valid: false });
  });

  it('rejects names with zero-width joiners', () => {
    expect(validateOrganizationName('Test\u200Dorg')).toMatchObject({ valid: false });
    expect(validateOrganizationName('Test\u200Corg')).toMatchObject({ valid: false });
  });

  it('rejects names with line/paragraph separators', () => {
    expect(validateOrganizationName('Test\u2028org')).toMatchObject({ valid: false });
    expect(validateOrganizationName('Test\u2029org')).toMatchObject({ valid: false });
  });

  it('normalizes combining characters via NFC', () => {
    // e + combining acute accent (NFD) should be treated same as e-acute (NFC)
    const nfd = 'Rene\u0301'; // "René" in NFD
    const nfc = 'Ren\u00E9';  // "René" in NFC
    expect(validateOrganizationName(nfd)).toEqual({ valid: true });
    expect(validateOrganizationName(nfc)).toEqual({ valid: true });
  });

  it('rejects non-string inputs', () => {
    expect(validateOrganizationName(null)).toMatchObject({ valid: false });
    expect(validateOrganizationName(123)).toMatchObject({ valid: false });
    expect(validateOrganizationName(undefined)).toMatchObject({ valid: false });
  });
});

describe('validateEmail', () => {
  it('accepts valid emails', () => {
    expect(validateEmail('test@example.com')).toEqual({ valid: true });
  });

  it('rejects invalid emails', () => {
    expect(validateEmail('not-an-email')).toMatchObject({ valid: false });
    expect(validateEmail('')).toMatchObject({ valid: false });
  });
});
