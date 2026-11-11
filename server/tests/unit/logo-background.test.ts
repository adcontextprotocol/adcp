import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  annotateLogoBackgrounds,
  backgroundFromTags,
  parseHostedLogoUrl,
} from '../../src/services/logo-background.js';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';

type Row = { domain: string; derived_background: 'light-bg' | 'dark-bg' | null; tags: string[] };

function dbWith(rows: Record<string, Row>) {
  const getApprovedLogoBackgrounds = vi.fn(async (ids: string[]) => {
    const map = new Map<string, Row>();
    for (const id of ids) if (rows[id]) map.set(id, rows[id]);
    return map;
  });
  return { getApprovedLogoBackgrounds };
}

const hosted = (id: string, domain = 'acme.example', ext = 'svg') =>
  `https://agenticadvertising.org/assets/brands/${domain}/${id}.${ext}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('backgroundFromTags', () => {
  it('returns the first background tag', () => {
    expect(backgroundFromTags(['primary', 'dark-bg', 'light-bg'])).toBe('dark-bg');
    expect(backgroundFromTags(['transparent-bg'])).toBe('transparent-bg');
  });
  it('returns undefined without one, or for non-arrays', () => {
    expect(backgroundFromTags(['primary', 'icon'])).toBeUndefined();
    expect(backgroundFromTags(undefined)).toBeUndefined();
    expect(backgroundFromTags('light-bg')).toBeUndefined();
    expect(backgroundFromTags([])).toBeUndefined();
  });
});

describe('parseHostedLogoUrl', () => {
  it.each([
    [hosted(ID_A), { domain: 'acme.example', id: ID_A }],
    [`/assets/brands/acme.example/${ID_A}.png`, { domain: 'acme.example', id: ID_A }],
    [`/assets/brands/acme.example/${ID_A}.svg?format=png&w=128`, { domain: 'acme.example', id: ID_A }],
    [`/logos/brands/acme.example/${ID_A}`, { domain: 'acme.example', id: ID_A }],
    [`https://agenticadvertising.org/logos/brands/acme.example/${ID_A}`, { domain: 'acme.example', id: ID_A }],
    [`https://agenticadvertising.org/assets/brands/ACME.example/${ID_A.toUpperCase()}.svg`, { domain: 'acme.example', id: ID_A }],
    [`http://agenticadvertising.org/assets/brands/acme.example/${ID_A}.svg`, { domain: 'acme.example', id: ID_A }],
  ])('parses %s', (url, expected) => {
    expect(parseHostedLogoUrl(url)).toEqual(expected);
  });

  it.each([
    ['external host', `https://evil.example/assets/brands/acme.example/${ID_A}.svg`],
    ['lookalike host', `https://agenticadvertising.org.evil.example/assets/brands/acme.example/${ID_A}.svg`],
    ['protocol-relative', `//agenticadvertising.org/assets/brands/acme.example/${ID_A}.svg`],
    ['non-uuid id', '/assets/brands/acme.example/logo.svg'],
    ['assets form without extension', `/assets/brands/acme.example/${ID_A}`],
    ['wrong prefix', `/static/brands/acme.example/${ID_A}.svg`],
    ['extra segments', `/assets/brands/acme.example/x/${ID_A}.svg`],
    ['ftp scheme', `ftp://agenticadvertising.org/assets/brands/acme.example/${ID_A}.svg`],
    ['garbage', 'not a url'],
    ['non-string', 42],
    ['undefined', undefined],
    ['overlong', `/assets/brands/acme.example/${'a'.repeat(3000)}.svg`],
  ])('rejects %s', (_label, url) => {
    expect(parseHostedLogoUrl(url)).toBeNull();
  });

  it('accepts the BASE_URL host', () => {
    vi.stubEnv('BASE_URL', 'https://staging.example.test');
    expect(parseHostedLogoUrl(`https://staging.example.test/assets/brands/acme.example/${ID_A}.svg`)).toEqual({
      domain: 'acme.example',
      id: ID_A,
    });
  });
});

describe('annotateLogoBackgrounds precedence', () => {
  it('a declared background is never overwritten, even an out-of-enum value', async () => {
    const db = dbWith({ [ID_A]: { domain: 'acme.example', derived_background: 'dark-bg', tags: ['light-bg'] } });
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [
        { url: hosted(ID_A), background: 'light-bg', tags: ['dark-bg'] },
        { url: hosted(ID_A), background: 'sepia' },
        { url: hosted(ID_A), background: '' },
      ] } }],
      db as never,
    );
    const logos = (out.brand_manifest as { logos: Array<{ background: string }> }).logos;
    expect(logos.map((l) => l.background)).toEqual(['light-bg', 'sepia', '']);
  });

  it('a null background counts as undeclared', async () => {
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: 'https://cdn.example/x.png', background: null, tags: ['dark-bg'] }] } }],
      dbWith({}) as never,
    );
    expect((out.brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('dark-bg');
  });

  it('a tag wins over the stored derived background', async () => {
    const db = dbWith({ [ID_A]: { domain: 'acme.example', derived_background: 'dark-bg', tags: [] } });
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: hosted(ID_A), tags: ['primary', 'light-bg'] }] } }],
      db as never,
    );
    expect((out.brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('light-bg');
    // The tag already answered, so the row needn't be looked up.
    expect(db.getApprovedLogoBackgrounds).not.toHaveBeenCalled();
  });

  it('transparent-bg tag is honoured', async () => {
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: 'https://cdn.example/x.png', tags: ['transparent-bg'] }] } }],
      dbWith({}) as never,
    );
    expect((out.brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('transparent-bg');
  });

  it('falls back to the derived background of an AAO-hosted URL', async () => {
    const db = dbWith({ [ID_A]: { domain: 'acme.example', derived_background: 'dark-bg', tags: ['primary'] } });
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: hosted(ID_A), tags: ['primary'] }] } }],
      db as never,
    );
    expect((out.brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('dark-bg');
  });

  it('uses the stored row tags before its derived value', async () => {
    const db = dbWith({ [ID_A]: { domain: 'acme.example', derived_background: 'dark-bg', tags: ['light-bg'] } });
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: hosted(ID_A) }] } }],
      db as never,
    );
    expect((out.brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('light-bg');
  });

  it('leaves a logo alone when the row has no derived background', async () => {
    const db = dbWith({ [ID_A]: { domain: 'acme.example', derived_background: null, tags: [] } });
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: hosted(ID_A) }] } }],
      db as never,
    );
    expect(out.brand_manifest).toEqual({ logos: [{ url: hosted(ID_A) }] });
  });

  it('leaves a logo alone when the row is missing (unapproved or unknown)', async () => {
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: hosted(ID_C) }] } }],
      dbWith({}) as never,
    );
    expect(out.brand_manifest).toEqual({ logos: [{ url: hosted(ID_C) }] });
  });
});

describe('annotateLogoBackgrounds URL handling', () => {
  const row: Row = { domain: 'acme.example', derived_background: 'dark-bg', tags: [] };

  it('resolves a relative /logos/brands URL', async () => {
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: `/logos/brands/acme.example/${ID_A}` }] } }],
      dbWith({ [ID_A]: row }) as never,
    );
    expect((out.brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('dark-bg');
  });

  it('resolves an absolute agenticadvertising.org /assets/brands URL', async () => {
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: hosted(ID_A) }] } }],
      dbWith({ [ID_A]: row }) as never,
    );
    expect((out.brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('dark-bg');
  });

  it('leaves an external URL untouched and does not query for it', async () => {
    const db = dbWith({ [ID_A]: row });
    const logos = [{ url: `https://evil.example/assets/brands/acme.example/${ID_A}.svg`, tags: ['primary'] }];
    const [out] = await annotateLogoBackgrounds([{ brand_manifest: { logos } }], db as never);
    expect(out.brand_manifest).toEqual({ logos });
    expect(db.getApprovedLogoBackgrounds).not.toHaveBeenCalled();
  });

  it('ignores a row whose domain does not match the URL domain', async () => {
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [{ url: hosted(ID_A, 'other.example') }] } }],
      dbWith({ [ID_A]: row }) as never,
    );
    expect(out.brand_manifest).toEqual({ logos: [{ url: hosted(ID_A, 'other.example') }] });
  });
});

describe('annotateLogoBackgrounds shapes', () => {
  const row = (bg: 'light-bg' | 'dark-bg'): Row => ({ domain: 'acme.example', derived_background: bg, tags: [] });

  it('fills brand_manifest.logo, brand_manifest.brands[].logos[] and brand.logos[]', async () => {
    const db = dbWith({ [ID_A]: row('dark-bg'), [ID_B]: row('light-bg'), [ID_C]: row('dark-bg') });
    const [out] = await annotateLogoBackgrounds(
      [{
        brand_manifest: {
          logo: { url: hosted(ID_A) },
          brands: [{ id: 'sub', logos: [{ url: hosted(ID_B) }] }],
        },
        brand: { logos: [{ url: hosted(ID_C) }] },
      }],
      db as never,
    );
    const manifest = out.brand_manifest as {
      logo: { background: string };
      brands: Array<{ logos: Array<{ background: string }> }>;
    };
    expect(manifest.logo.background).toBe('dark-bg');
    expect(manifest.brands[0].logos[0].background).toBe('light-bg');
    expect((out.brand as { logos: Array<{ background: string }> }).logos[0].background).toBe('dark-bg');
  });

  it('passes through responses without logos, null/absent fields and non-object entries', async () => {
    const input = [
      {},
      { brand_manifest: undefined, brand: undefined },
      { brand_manifest: { logos: ['junk', null, 7] } },
      { brand: { name: 'x' } },
    ];
    const out = await annotateLogoBackgrounds(input as never, dbWith({}) as never);
    expect(out).toEqual(input);
  });
});

describe('annotateLogoBackgrounds efficiency and safety', () => {
  it('makes one DB call for many responses, with de-duplicated ids', async () => {
    const db = dbWith({
      [ID_A]: { domain: 'acme.example', derived_background: 'dark-bg', tags: [] },
      [ID_B]: { domain: 'acme.example', derived_background: 'light-bg', tags: [] },
    });
    const responses = Array.from({ length: 20 }, (_, i) => ({
      brand_manifest: { logos: [{ url: hosted(i % 2 ? ID_A : ID_B) }, { url: hosted(ID_A) }] },
    }));
    const out = await annotateLogoBackgrounds(responses, db as never);
    expect(db.getApprovedLogoBackgrounds).toHaveBeenCalledTimes(1);
    const ids = db.getApprovedLogoBackgrounds.mock.calls[0][0];
    expect([...ids].sort()).toEqual([ID_A, ID_B]);
    expect(out).toHaveLength(20);
    expect((out[0].brand_manifest as { logos: Array<{ background: string }> }).logos[0].background).toBe('light-bg');
  });

  it('makes no DB call when nothing is AAO-hosted', async () => {
    const db = dbWith({});
    await annotateLogoBackgrounds([{ brand_manifest: { logos: [{ url: 'https://cdn.example/a.png' }] } }], db as never);
    expect(db.getApprovedLogoBackgrounds).not.toHaveBeenCalled();
  });

  it('degrades gracefully on a DB error: declared and tag backgrounds survive', async () => {
    const db = { getApprovedLogoBackgrounds: vi.fn().mockRejectedValue(new Error('db down')) };
    const [out] = await annotateLogoBackgrounds(
      [{ brand_manifest: { logos: [
        { url: hosted(ID_A), background: 'light-bg' },
        { url: hosted(ID_B), tags: ['dark-bg'] },
        { url: hosted(ID_C) },
      ] } }],
      db as never,
    );
    const logos = (out.brand_manifest as { logos: Array<{ background?: string }> }).logos;
    expect(logos.map((l) => l.background)).toEqual(['light-bg', 'dark-bg', undefined]);
  });

  it('does not mutate its inputs', async () => {
    const db = dbWith({ [ID_A]: { domain: 'acme.example', derived_background: 'dark-bg', tags: [] } });
    const logo = { url: hosted(ID_A), tags: ['primary'] };
    const input = {
      brand_manifest: { logos: [logo], brands: [{ logos: [{ url: hosted(ID_A) }] }] },
      brand: { logos: [{ url: hosted(ID_A) }] },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    const [out] = await annotateLogoBackgrounds([input], db as never);
    expect(input).toEqual(snapshot);
    expect(logo).not.toHaveProperty('background');
    expect(out).not.toBe(input);
    expect((out.brand_manifest as { logos: unknown[] }).logos[0]).not.toBe(logo);
  });

  it('returns untouched logo objects by reference when nothing is added', async () => {
    const logo = { url: 'https://cdn.example/a.png' };
    const input = { brand_manifest: { logos: [logo] } };
    const [out] = await annotateLogoBackgrounds([input], dbWith({}) as never);
    expect((out.brand_manifest as { logos: unknown[] }).logos[0]).toBe(logo);
  });
});
