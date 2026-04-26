import { describe, it, expect } from 'vitest';
import { resolveBrandFromJson } from '../../src/db/brand-db.js';

describe('resolveBrandFromJson', () => {
  it('resolves logos[] under brands[0]', () => {
    const result = resolveBrandFromJson('acme.com', {
      brands: [
        {
          names: [{ en: 'Acme' }],
          logos: [{ url: 'https://acme.com/logo.png', background: 'light-bg' }],
          colors: { primary: '#ff0000' },
        },
      ],
    }, true);

    expect(result.logo_url).toBe('https://acme.com/logo.png');
    expect(result.brand_color).toBe('#ff0000');
    expect(result.name).toBe('Acme');
    expect(result.verified).toBe(true);
  });

  it('resolves top-level logos[] when brands is missing', () => {
    const result = resolveBrandFromJson('acme.com', {
      name: 'Acme',
      logos: [{ url: 'https://acme.com/logo.png' }],
      colors: { primary: '#00ff00' },
    }, false);

    expect(result.logo_url).toBe('https://acme.com/logo.png');
    expect(result.brand_color).toBe('#00ff00');
  });

  it('resolves top-level singular logo object — thehook.es shape', () => {
    // This is the actual brand.json shape from thehook.es. Their logo was
    // not displaying because the resolver only checked `logos` (plural).
    const result = resolveBrandFromJson('thehook.es', {
      name: 'The Hook',
      logo: { url: 'https://thehook.es/images/logo-thehook-negro.png' },
      brand_colors: { primary: '#4db1d5', secondary: '#000000' },
      house: { name: 'The Hook', domain: 'thehook.es', architecture: 'house_of_brands' },
      brands: [
        { id: 'rephook', names: [{ en: 'RepHook' }] },
        { id: 'genmatic', names: [{ en: 'Genmatic' }] },
      ],
    }, true);

    expect(result.logo_url).toBe('https://thehook.es/images/logo-thehook-negro.png');
    expect(result.brand_color).toBe('#4db1d5');
    expect(result.name).toBe('The Hook');
  });

  it('prefers a brand-level logo over a top-level one', () => {
    const result = resolveBrandFromJson('acme.com', {
      logo: { url: 'https://example.com/wrong.png' },
      brands: [
        {
          names: [{ en: 'Acme' }],
          logos: [{ url: 'https://acme.com/right.png' }],
        },
      ],
    }, false);

    expect(result.logo_url).toBe('https://acme.com/right.png');
  });

  it('selects light-bg variant for default and dark-bg for the dark slot', () => {
    const result = resolveBrandFromJson('acme.com', {
      brands: [
        {
          logos: [
            { url: 'https://acme.com/dark.png', background: 'dark-bg' },
            { url: 'https://acme.com/light.png', background: 'light-bg' },
            { url: 'https://acme.com/transparent.png', background: 'transparent-bg' },
          ],
        },
      ],
    }, false);

    expect(result.logo_url).toBe('https://acme.com/light.png');
    expect(result.logo_url_dark).toBe('https://acme.com/dark.png');
  });

  it('returns no logo when none is declared', () => {
    const result = resolveBrandFromJson('empty.com', { name: 'Empty' }, false);
    expect(result.logo_url).toBeUndefined();
    expect(result.brand_color).toBeUndefined();
  });
});
