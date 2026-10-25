import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const html = readFileSync(new URL('../../public/sites/trustjson/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../public/sites/trustjson/lookup.js', import.meta.url), 'utf8');
const windows: JSDOM[] = [];
const base = {
  domain: 'nova-motors.com', status: 'not_found', authority_domain: 'nova-motors.com',
  record_url: 'https://nova-motors.com/.well-known/trust.json', checked_at: '2026-10-24T12:00:00Z',
  message: 'No public record was found.', brand_name: null, parent_domain: null, brand_id: null,
  exclusive_grants: false, agents: [], grants: [],
  total_agents: 0, total_grants: 0, matching_grants: 0,
};
const response = (data: object, ok = true) => ({ ok, json: async () => data });

function setup(fetch = vi.fn().mockResolvedValue(response(base)), search = '') {
  const dom = new JSDOM(html, { url: `https://trustjson.org/${search}`, runScripts: 'outside-only' });
  windows.push(dom);
  dom.window.fetch = fetch;
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  dom.window.eval(script);
  const document = dom.window.document;
  const input = document.getElementById('trust-domain') as HTMLInputElement;
  const result = document.getElementById('trust-lookup-result')!;
  const form = document.getElementById('trust-lookup-form')!;
  const status = document.getElementById('trust-lookup-status')!;
  function submit(domain = base.domain) {
    input.value = domain;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  }
  return { dom, document, input, form, result, status, fetch, submit };
}

afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

describe('trust homepage lookup', () => {
  it('shows an absent record with a domain-specific claim link and a shareable query', async () => {
    const ui = setup();
    ui.submit();
    await vi.waitFor(() => expect(ui.result.hidden).toBe(false));
    expect(ui.result.querySelector('h2')?.textContent).toBe('trust.json not implemented');
    const claim = ui.result.querySelector('a.btn') as HTMLAnchorElement;
    expect(claim.textContent).toBe('Claim this brand');
    expect(claim.href).toBe('https://agenticadvertising.org/brand/builder?domain=nova-motors.com');
    expect(ui.dom.window.location.search).toBe('?domain=nova-motors.com');
    expect(ui.document.activeElement).toBe(ui.result);
  });

  it('renders a verified parent record and expired grant as published declarations', async () => {
    const ui = setup(vi.fn().mockResolvedValue(response({ ...base, status: 'published',
      authority_domain: 'nova-brands.com', parent_domain: 'nova-brands.com', brand_id: 'nova_motors',
      exclusive_grants: true,
      matching_grants: 1, total_grants: 1, grants: [{ grantee: 'pinnacle-agency.com', scopes: ['adcp:media_buying'],
        agents: ['https://buyer.pinnacle-agency.com'], countries: ['US'], brands: ['nova_motors'],
        valid_from: null, valid_until: '2026-01-01T00:00:00Z', status: 'expired' }],
    })));
    ui.submit();
    await vi.waitFor(() => expect(ui.result.hidden).toBe(false));
    expect(ui.result.textContent).toContain('Via nova-brands.com');
    expect(ui.result.textContent).toContain('pinnacle-agency.com');
    expect(ui.result.querySelector('[data-state="expired"]')?.textContent).toBe('Expired');
    expect(ui.result.textContent).toContain('not a verdict on a particular request');
    expect(ui.result.querySelector('.trust-result-coverage')?.textContent)
      .toBe('Exclusive. Sellers that check turn away agencies not on this list.');
  });

  it.each(['unavailable', 'unverified_parent'])('never describes %s as not implemented', async state => {
    const ui = setup(vi.fn().mockResolvedValue(response({ ...base, status: state })));
    ui.submit();
    await vi.waitFor(() => expect(ui.result.hidden).toBe(false));
    expect(ui.result.querySelector('h2')?.textContent).not.toContain('not implemented');
  });

  it('renders hostile record contents as text and keeps the claim target fixed', async () => {
    const attack = '<img src=x onerror="alert(1)">';
    const ui = setup(vi.fn().mockResolvedValue(response({ ...base, status: 'published', domain: attack,
      brand_name: attack, message: attack, claim_url: 'javascript:alert(1)', record_url: 'javascript:alert(1)',
      agents: [{ origin: attack, roles: [attack], countries: null }],
      grants: [{ grantee: attack, scopes: [attack], agents: [attack], brands: [attack], countries: null,
        valid_from: null, valid_until: null, status: 'invalid' }],
    })));
    ui.submit();
    await vi.waitFor(() => expect(ui.result.hidden).toBe(false));
    expect(ui.result.querySelector('img, script')).toBeNull();
    expect(ui.result.textContent).toContain(attack);
    expect(ui.result.querySelector('a.btn')?.getAttribute('href')).toBe(`https://agenticadvertising.org/brand/builder?domain=${encodeURIComponent(attack)}`);
    expect(ui.result.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('shows API and network errors without fabricating an absent-record result', async () => {
    const ui = setup(vi.fn().mockResolvedValue(response({ error: 'Too many lookups. Try later.' }, false)));
    ui.submit();
    await vi.waitFor(() => expect(ui.status.textContent).toContain('Too many lookups'));
    expect(ui.result.hidden).toBe(true);
    expect(ui.form.getAttribute('aria-busy')).toBeNull();
    ui.fetch.mockRejectedValue(new Error('Network unavailable'));
    ui.submit();
    await vi.waitFor(() => expect(ui.status.textContent).toBe('Network unavailable'));
    expect(ui.result.hidden).toBe(true);
  });

  it('does not let an older response overwrite the latest domain', async () => {
    let first!: (value: ReturnType<typeof response>) => void;
    let second!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    const ui = setup(fetch);
    ui.submit('first-nova.com');
    ui.submit('second-nova.com');
    second(response({ ...base, domain: 'second-nova.com' }));
    await vi.waitFor(() => expect(ui.result.hidden).toBe(false));
    first(response({ ...base, domain: 'first-nova.com' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ui.result.querySelector('.trust-result-domain')?.textContent).toBe('second-nova.com');
  });

  it('automatically looks up a shared domain URL', async () => {
    const ui = setup(vi.fn().mockResolvedValue(response(base)), '?domain=nova-motors.com');
    await vi.waitFor(() => expect(ui.result.hidden).toBe(false));
    expect(ui.fetch.mock.calls[0][0]).toBe('/api/trust/lookup?domain=nova-motors.com');
  });
});
