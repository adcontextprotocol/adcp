import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const pageSource = readFileSync('server/public/members.html', 'utf8');
const cardSource = readFileSync('server/public/member-card.js', 'utf8');
const roster = JSON.parse(readFileSync('server/public/initial-voting-members.json', 'utf8'));
const windows: JSDOM[] = [];

function directory(options: { search?: string; offerings?: string; market?: string; apiFails?: boolean; rosterFails?: boolean } = {}) {
  const dom = new JSDOM(pageSource, { url: 'https://example.org/members', runScripts: 'outside-only' });
  windows.push(dom);
  const { window } = dom;
  // Exercise the actual page functions without its automatic startup requests.
  const addListener = window.document.addEventListener.bind(window.document);
  window.document.addEventListener = ((type: string, listener: EventListener) => {
    if (type !== 'DOMContentLoaded') addListener(type, listener);
  }) as typeof window.document.addEventListener;
  window.eval(cardSource);
  const script = Array.from(window.document.querySelectorAll('script')).find(script =>
    script.textContent?.includes('let allMembers = []'),
  );
  window.eval(`${script!.textContent!}
    currentSearch = ${JSON.stringify(options.search || '')};
    currentFilter = ${JSON.stringify(options.offerings || '')};
    currentMarket = ${JSON.stringify(options.market || '')};`);
  const profiles = [
    { display_name: 'Scope3', slug: 'scope3', description: 'Existing profile', featured: true },
    { display_name: 'AdTonos', slug: 'adtonos' },
    { display_name: 'Acme Corp', slug: 'acme' },
  ];
  const fetch = vi.fn(async (url: string) => {
    if (url === '/initial-voting-members.json') {
      return { ok: !options.rosterFails, json: async () => roster };
    }
    return { ok: !options.apiFails, json: async () => ({ members: profiles.filter(profile =>
      !options.search || profile.display_name.toLowerCase().includes(options.search.toLowerCase()),
    ) }) };
  });
  Object.assign(window, { fetch });
  return { window, fetch, load: () => window.eval('loadMembers()') as Promise<void> };
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close();
});

describe('initial voting members in the public directory', () => {
  it('keeps existing profiles and merges the 94 admitted companies without duplicate names or aliases', async () => {
    const { window, load } = directory();
    await load();
    const names = Array.from(window.document.querySelectorAll('.member-name')).map(node => node.textContent);
    expect(names).toHaveLength(95);
    expect(names.filter(name => name === 'Scope3')).toHaveLength(1);
    expect(names).toContain('AdTonos');
    expect(names).not.toContain('Radio Net Media (AdTonos)');
    expect(names).toContain('Acme Corp');
    expect(names).toContain('Chime');
    expect(window.document.querySelector('.member-name')?.textContent).toBe('Scope3');
    const chime = Array.from(window.document.querySelectorAll('.member-card')).find(card =>
      card.querySelector('.member-name')?.textContent === 'Chime',
    )!;
    expect(chime.textContent).toContain('Admitted as a voting member on August 6, 2026');
    expect(chime.querySelector('a, button, [onclick]')).toBeNull();
  });

  it('finds an admitted member without a profile by name', async () => {
    const { window, fetch, load } = directory({ search: 'Chime' });
    await load();
    expect(window.document.querySelectorAll('.member-card')).toHaveLength(1);
    expect(window.document.querySelector('.member-name')?.textContent).toBe('Chime');
    expect(fetch).toHaveBeenCalledWith('/api/members?search=Chime');
  });

  it.each([{ offerings: 'consulting' }, { market: 'US' }])('does not invent services or markets for roster entries: %j', async options => {
    const { window, load } = directory(options);
    await load();
    expect(window.document.querySelectorAll('.member-card')).toHaveLength(3);
    expect(window.document.querySelectorAll('.member-card.preview')).toHaveLength(0);
  });

  it('keeps the admitted roster visible when the profiles API is unavailable', async () => {
    const { window, load } = directory({ apiFails: true });
    await load();
    expect(window.document.querySelectorAll('.member-card')).toHaveLength(94);
    expect(window.document.getElementById('loading')?.textContent).toContain('Some member listings could not be loaded');
  });

  it('keeps existing profiles visible when the admitted roster cannot be loaded', async () => {
    const { window, load } = directory({ rosterFails: true });
    await load();
    expect(window.document.querySelectorAll('.member-card')).toHaveLength(3);
    expect(window.document.getElementById('loading')?.textContent).toContain('Some member listings could not be loaded');
  });
});
