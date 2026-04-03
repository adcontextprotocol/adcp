import { describe, it, expect } from 'vitest';
import { normalizeEmail, getGoogleEmailAliases } from '../../src/utils/email-domain.js';

describe('normalizeEmail', () => {
  it('normalizes googlemail.com to gmail.com', () => {
    expect(normalizeEmail('user@googlemail.com')).toBe('user@gmail.com');
  });

  it('normalizes googlemail.co.uk to gmail.com', () => {
    expect(normalizeEmail('user@googlemail.co.uk')).toBe('user@gmail.com');
  });

  it('leaves gmail.com as-is', () => {
    expect(normalizeEmail('user@gmail.com')).toBe('user@gmail.com');
  });

  it('lowercases the entire address', () => {
    expect(normalizeEmail('User@GoogleMail.COM')).toBe('user@gmail.com');
  });

  it('trims whitespace', () => {
    expect(normalizeEmail('  user@googlemail.com  ')).toBe('user@gmail.com');
  });

  it('passes through non-Google emails unchanged (except lowercase)', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
    expect(normalizeEmail('User@Yahoo.com')).toBe('user@yahoo.com');
  });

  it('handles emails with no @ gracefully', () => {
    expect(normalizeEmail('nope')).toBe('nope');
  });

  it('does not treat gmail.co.uk as a Google alias', () => {
    expect(normalizeEmail('user@gmail.co.uk')).toBe('user@gmail.co.uk');
  });
});

describe('getGoogleEmailAliases', () => {
  it('returns all aliases for googlemail.com addresses', () => {
    const aliases = getGoogleEmailAliases('user@googlemail.com');
    expect(aliases).toContain('user@gmail.com');
    expect(aliases).toContain('user@googlemail.co.uk');
    expect(aliases).not.toContain('user@googlemail.com');
    expect(aliases).toHaveLength(2);
  });

  it('returns all aliases for gmail.com addresses', () => {
    const aliases = getGoogleEmailAliases('user@gmail.com');
    expect(aliases).toContain('user@googlemail.com');
    expect(aliases).toContain('user@googlemail.co.uk');
    expect(aliases).not.toContain('user@gmail.com');
    expect(aliases).toHaveLength(2);
  });

  it('returns all aliases for googlemail.co.uk addresses', () => {
    const aliases = getGoogleEmailAliases('user@googlemail.co.uk');
    expect(aliases).toContain('user@gmail.com');
    expect(aliases).toContain('user@googlemail.com');
    expect(aliases).not.toContain('user@googlemail.co.uk');
    expect(aliases).toHaveLength(2);
  });

  it('returns empty array for non-Google addresses', () => {
    expect(getGoogleEmailAliases('user@example.com')).toEqual([]);
    expect(getGoogleEmailAliases('user@yahoo.com')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const aliases = getGoogleEmailAliases('User@Gmail.COM');
    expect(aliases).toContain('user@googlemail.com');
    expect(aliases).toHaveLength(2);
  });

  it('returns empty array for invalid emails', () => {
    expect(getGoogleEmailAliases('nope')).toEqual([]);
  });

  it('does not treat gmail.co.uk as a Google alias', () => {
    expect(getGoogleEmailAliases('user@gmail.co.uk')).toEqual([]);
  });
});
