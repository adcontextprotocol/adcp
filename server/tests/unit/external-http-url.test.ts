import { describe, expect, it } from 'vitest';
import {
  InvalidExternalHttpUrlError,
  normalizeOptionalExternalHttpUrl,
} from '../../src/utils/external-http-url.js';

describe('normalizeOptionalExternalHttpUrl', () => {
  it('accepts and normalizes absolute HTTP and HTTPS URLs', () => {
    expect(normalizeOptionalExternalHttpUrl(' https://example.com/path?q=1 '))
      .toBe('https://example.com/path?q=1');
    expect(normalizeOptionalExternalHttpUrl('http://example.com'))
      .toBe('http://example.com/');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/file',
    'https://user:password@example.com/',
    '//example.com/path',
    'not a URL',
  ])('rejects unsafe external URL %s', (value) => {
    expect(() => normalizeOptionalExternalHttpUrl(value)).toThrow(InvalidExternalHttpUrlError);
  });

  it('preserves update and clear semantics', () => {
    expect(normalizeOptionalExternalHttpUrl(undefined)).toBeUndefined();
    expect(normalizeOptionalExternalHttpUrl(null)).toBeNull();
    expect(normalizeOptionalExternalHttpUrl('   ')).toBeNull();
  });

  it('rejects values longer than the browser-facing limit', () => {
    expect(() => normalizeOptionalExternalHttpUrl(`https://example.com/${'a'.repeat(2048)}`))
      .toThrow(/2048 characters or fewer/);
  });
});
