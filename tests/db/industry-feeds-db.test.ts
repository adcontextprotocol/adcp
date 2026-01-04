import { normalizeUrl } from '../../server/src/db/industry-feeds-db.js';

describe('normalizeUrl', () => {
  it('removes trailing slashes', () => {
    expect(normalizeUrl('https://example.com/feed/')).toBe('https://example.com/feed');
    expect(normalizeUrl('https://example.com/rss/feed/')).toBe('https://example.com/rss/feed');
  });

  it('preserves root path trailing slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('lowercases hostname', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/feed')).toBe('https://example.com/feed');
    expect(normalizeUrl('https://ExAmPlE.CoM/feed')).toBe('https://example.com/feed');
  });

  it('removes www prefix', () => {
    expect(normalizeUrl('https://www.example.com/feed')).toBe('https://example.com/feed');
    expect(normalizeUrl('https://WWW.example.com/feed')).toBe('https://example.com/feed');
  });

  it('handles http and https consistently', () => {
    expect(normalizeUrl('http://example.com/feed')).toBe('http://example.com/feed');
    expect(normalizeUrl('https://example.com/feed')).toBe('https://example.com/feed');
  });

  it('strips query parameters', () => {
    expect(normalizeUrl('https://example.com/feed?format=rss')).toBe('https://example.com/feed');
    expect(normalizeUrl('https://example.com/feed?a=1&b=2')).toBe('https://example.com/feed');
  });

  it('handles complex URLs', () => {
    expect(normalizeUrl('https://www.adexchanger.com/feed/')).toBe('https://adexchanger.com/feed');
    expect(normalizeUrl('https://WWW.Example.COM/Blog/RSS/')).toBe('https://example.com/Blog/RSS');
  });

  it('handles invalid URLs gracefully', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
    expect(normalizeUrl('example.com/feed/')).toBe('example.com/feed');
  });
});
