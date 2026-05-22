/**
 * Guards against the "undefined undefined" credential bug — when a credential
 * is issued before the user's WorkOS profile populates first_name/last_name,
 * naive template interpolation produces the literal string "undefined undefined"
 * and that is what Certifier prints on the certificate (escalation #382).
 */
import { describe, it, expect } from 'vitest';
import { buildRecipientName } from '../../src/services/certifier-client.js';

describe('buildRecipientName', () => {
  it('joins first and last when both present', () => {
    expect(buildRecipientName({
      first_name: 'Tom',
      last_name: 'Hespos',
      email: 'tom@abydosmedia.com',
    })).toBe('Tom Hespos');
  });

  it('falls back to email when both name fields are undefined', () => {
    expect(buildRecipientName({
      first_name: undefined,
      last_name: undefined,
      email: 'tom@abydosmedia.com',
    })).toBe('tom@abydosmedia.com');
  });

  it('falls back to email when both name fields are null', () => {
    expect(buildRecipientName({
      first_name: null,
      last_name: null,
      email: 'tom@abydosmedia.com',
    })).toBe('tom@abydosmedia.com');
  });

  it('falls back to email when both name fields are empty strings', () => {
    expect(buildRecipientName({
      first_name: '',
      last_name: '',
      email: 'tom@abydosmedia.com',
    })).toBe('tom@abydosmedia.com');
  });

  it('returns first name only when last is missing', () => {
    expect(buildRecipientName({
      first_name: 'Tom',
      last_name: null,
      email: 'tom@abydosmedia.com',
    })).toBe('Tom');
  });

  it('returns last name only when first is missing', () => {
    expect(buildRecipientName({
      first_name: undefined,
      last_name: 'Hespos',
      email: 'tom@abydosmedia.com',
    })).toBe('Hespos');
  });

  it('trims whitespace from name fields', () => {
    expect(buildRecipientName({
      first_name: '  Tom  ',
      last_name: '  Hespos  ',
      email: 'tom@abydosmedia.com',
    })).toBe('Tom Hespos');
  });

  it('never returns the literal "undefined undefined"', () => {
    const result = buildRecipientName({
      first_name: undefined,
      last_name: undefined,
      email: 'fallback@example.com',
    });
    expect(result).not.toBe('undefined undefined');
    expect(result).not.toContain('undefined');
  });
});
