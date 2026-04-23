import { describe, it, expect } from 'vitest';
import { extractLogoFromManifest } from '../../server/src/services/announcement-visual.js';

describe('extractLogoFromManifest', () => {
  it('pulls logos[0].url from top-level manifest', () => {
    const manifest = { logos: [{ url: 'https://cdn/acme.svg' }] };
    expect(extractLogoFromManifest(manifest)).toBe('https://cdn/acme.svg');
  });

  it('pulls brands[0].logos[0].url from multi-brand manifest', () => {
    const manifest = {
      brands: [{ logos: [{ url: 'https://cdn/nested.svg' }] }],
    };
    expect(extractLogoFromManifest(manifest)).toBe('https://cdn/nested.svg');
  });

  it('prefers top-level logos over nested brands logos', () => {
    const manifest = {
      logos: [{ url: 'https://top' }],
      brands: [{ logos: [{ url: 'https://nested' }] }],
    };
    expect(extractLogoFromManifest(manifest)).toBe('https://top');
  });

  it('returns null when no logos anywhere', () => {
    expect(extractLogoFromManifest({})).toBeNull();
    expect(extractLogoFromManifest({ logos: [] })).toBeNull();
    expect(extractLogoFromManifest({ brands: [{}] })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(extractLogoFromManifest(null)).toBeNull();
    expect(extractLogoFromManifest('nope')).toBeNull();
    expect(extractLogoFromManifest(42)).toBeNull();
  });

  it('ignores logo entries without a url string', () => {
    expect(extractLogoFromManifest({ logos: [{}] })).toBeNull();
    expect(extractLogoFromManifest({ logos: [{ url: 42 }] })).toBeNull();
  });
});
