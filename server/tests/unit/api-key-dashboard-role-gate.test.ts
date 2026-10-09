import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const dashboardHtml = readFileSync(
  join(process.cwd(), 'server/public/dashboard-api-keys.html'),
  'utf8',
);

describe('API key dashboard organization-role gate', () => {
  it('offers key management only to active organization owners and admins', () => {
    expect(dashboardHtml).toContain("currentOrg.status === 'active'");
    expect(dashboardHtml).toContain("currentOrg.role === 'owner'");
    expect(dashboardHtml).toContain("currentOrg.role === 'admin'");

    const roleGate = dashboardHtml.indexOf('if (!canManageApiKeys)');
    const contentReveal = dashboardHtml.indexOf(
      "document.getElementById('content').style.display = 'block'",
    );
    const keyLoad = dashboardHtml.indexOf('await loadKeys()');

    expect(roleGate).toBeGreaterThan(-1);
    expect(contentReveal).toBeGreaterThan(roleGate);
    expect(keyLoad).toBeGreaterThan(contentReveal);
  });

  it('shows a clear non-admin explanation instead of the management workflow', () => {
    expect(dashboardHtml).toContain('id="accessDenied"');
    expect(dashboardHtml).toContain(
      'Only active organization owners and admins can create, view, or revoke API keys.',
    );
  });
});

describe('API key dashboard explicit organization selection', () => {
  const primary = { id: 'org_pinnacle', name: 'Pinnacle Agency', role: 'owner', status: 'active', is_primary: true };
  const secondary = { id: 'org_streamhaus', name: 'StreamHaus', role: 'admin', status: 'active' };

  async function initialize(search: string, organizations = [primary, secondary]) {
    const elements = Object.fromEntries(['loading', 'content', 'accessDenied'].map((id) => [
      id, { style: { display: id === 'loading' ? 'block' : 'none' }, textContent: '', innerHTML: '' },
    ]));
    const nav = {
      init: vi.fn(), renderOrgPicker: vi.fn(), setOrgOptions: vi.fn(),
      resolveOrg: vi.fn(() => ({ org: primary, needsSelection: false })),
    };
    const loadKeys = vi.fn();
    const localStorage = { getItem: vi.fn(() => primary.id), setItem: vi.fn() };
    const context = vm.createContext({
      document: { getElementById: (id: string) => elements[id] },
      window: { location: { search, pathname: '/dashboard/api-keys' } },
      URLSearchParams, localStorage, DashboardNav: nav, currentOrg: null, loadKeys,
      fetch: vi.fn(async () => ({ ok: true, json: async () => ({ organizations }) })),
      console,
    });
    const start = dashboardHtml.indexOf('async function init()');
    const end = dashboardHtml.indexOf('// Close modals on Escape key', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    vm.runInContext(dashboardHtml.slice(start, end), context);
    await context.init();
    return { elements, nav, loadKeys, context, localStorage };
  }

  it.each([[primary], [primary, secondary]])('requires a selection even with %j and a remembered primary organization', async (...organizations) => {
    const result = await initialize('', organizations);
    expect(result.nav.renderOrgPicker).toHaveBeenCalledWith(organizations, result.elements.loading);
    expect(result.nav.resolveOrg).not.toHaveBeenCalled();
    expect(result.localStorage.getItem).not.toHaveBeenCalled();
    expect(result.elements.content.style.display).toBe('none');
    expect(result.loadKeys).not.toHaveBeenCalled();
  });

  it.each(['?org=org_unknown', '?org=', '?org=org_pinnacle&org=org_streamhaus'])('refuses unavailable or ambiguous selection %s without falling back', async (search) => {
    const result = await initialize(search);
    expect(result.elements.loading.textContent).toContain('selected organization is unavailable');
    expect(result.elements.content.style.display).toBe('none');
    expect(result.loadKeys).not.toHaveBeenCalled();
  });

  it('loads keys only for the explicitly selected active admin organization', async () => {
    const result = await initialize('?org=org_streamhaus');
    expect(result.context.currentOrg.id).toBe(secondary.id);
    expect(result.elements.content.style.display).toBe('block');
    expect(result.loadKeys).toHaveBeenCalledOnce();
  });

  it('denies a selected member organization even when the other organization has an owner role', async () => {
    const result = await initialize('?org=org_streamhaus', [primary, { ...secondary, role: 'member' }]);
    expect(result.elements.accessDenied.style.display).toBe('block');
    expect(result.elements.content.style.display).toBe('none');
    expect(result.loadKeys).not.toHaveBeenCalled();
  });
});
