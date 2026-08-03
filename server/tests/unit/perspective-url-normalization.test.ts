import { describe, expect, it } from 'vitest';
import {
  formatPerspectiveUrlAsMarkdownDestination,
  normalizePerspectiveExternalUrl,
} from '../../src/utils/perspective-url.js';

describe('perspective external URL normalization', () => {
  it('returns the canonical href for valid credential-free HTTPS URLs', () => {
    expect(normalizePerspectiveExternalUrl(
      'https://Publisher.Example:443/articles/agentic media?q=(roundup)',
    )).toBe('https://publisher.example/articles/agentic%20media?q=(roundup)');
  });

  it.each([
    '\thttps://publisher.example/article',
    'https://publisher.example/article\n',
    'https://publisher.example/article\r\n- [Injected](https://attacker.example)',
    'https://publisher.example/ar\u0000ticle',
    'https://publisher.example/ar\u001Fticle',
    'https://publisher.example/ar\u007Fticle',
  ])('rejects C0 and DEL characters instead of allowing URL to strip them: %j', (value) => {
    expect(normalizePerspectiveExternalUrl(value)).toBeNull();
  });

  it.each([
    'https://publisher.example/a\\b',
    'https://publisher.example/a<b',
    'https://publisher.example/a>b',
  ])('rejects raw URL/Markdown boundary delimiters: %s', (value) => {
    expect(normalizePerspectiveExternalUrl(value)).toBeNull();
  });

  it('formats valid parentheses as an unambiguous CommonMark destination', () => {
    expect(formatPerspectiveUrlAsMarkdownDestination(
      'https://publisher.example/reports/agentic_(roundup)',
    )).toBe('<https://publisher.example/reports/agentic_(roundup)>');
  });
});
