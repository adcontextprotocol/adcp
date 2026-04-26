import { describe, it, expect } from 'vitest';
import {
  extractLogoFromManifest,
  isSafeVisualUrl,
} from '../../server/src/services/announcement-visual.js';

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

describe('isSafeVisualUrl', () => {
  it('accepts a plain https PNG', () => {
    expect(isSafeVisualUrl('https://cdn.example.com/logo.png')).toBe(true);
    expect(isSafeVisualUrl('https://cdn.example.com/a/b/logo.webp')).toBe(true);
    expect(isSafeVisualUrl('https://cdn.example.com/logo.JPG')).toBe(true);
  });

  it('rejects non-https schemes', () => {
    expect(isSafeVisualUrl('http://cdn.example.com/logo.png')).toBe(false);
    expect(isSafeVisualUrl('javascript:alert(1)//logo.png')).toBe(false);
    expect(isSafeVisualUrl('data:image/png;base64,xxx')).toBe(false);
  });

  it('rejects svg (script risk downstream)', () => {
    expect(isSafeVisualUrl('https://cdn.example.com/logo.svg')).toBe(false);
  });

  it('rejects URLs without an image extension', () => {
    expect(isSafeVisualUrl('https://cdn.example.com/logo')).toBe(false);
    expect(isSafeVisualUrl('https://cdn.example.com/logo.html')).toBe(false);
  });

  it('rejects private, loopback, and .internal hosts', () => {
    expect(isSafeVisualUrl('https://localhost/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://127.0.0.1/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://10.0.0.5/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://192.168.1.1/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://172.16.0.4/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://api.internal/logo.png')).toBe(false);
  });

  it('rejects cloud metadata, link-local, and CGNAT hosts', () => {
    expect(isSafeVisualUrl('https://169.254.169.254/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://169.254.0.1/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://100.64.0.1/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://100.127.255.255/logo.png')).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 and IPv6 private ranges', () => {
    expect(isSafeVisualUrl('https://[::ffff:127.0.0.1]/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://[fc00::1]/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://[fd12:3456:789a::1]/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://[fe80::1]/logo.png')).toBe(false);
  });

  it('rejects IPv4 obfuscation via decimal or hex hostname', () => {
    expect(isSafeVisualUrl('https://2130706433/logo.png')).toBe(false);
    expect(isSafeVisualUrl('https://0x7f000001/logo.png')).toBe(false);
  });

  it('rejects malformed or empty URLs', () => {
    expect(isSafeVisualUrl('')).toBe(false);
    expect(isSafeVisualUrl('not a url')).toBe(false);
    // Two MB worth of string should exceed the length cap
    expect(isSafeVisualUrl('https://x.com/' + 'a'.repeat(3000) + '.png')).toBe(false);
  });
});
