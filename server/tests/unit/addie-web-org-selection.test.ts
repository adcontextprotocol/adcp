import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('Addie web organization selection client', () => {
  const chatHtml = readFileSync(join(process.cwd(), 'server/public/chat.html'), 'utf8');

  it('reads the selected organization from URL first and localStorage second', () => {
    expect(chatHtml).toContain('function getSelectedOrganizationId()');
    expect(chatHtml).toContain("new URLSearchParams(window.location.search).get('org')");
    expect(chatHtml).toContain("return localStorage.getItem('selectedOrgId') || null;");
  });

  it('forwards the selected organization to Addie Home', () => {
    expect(chatHtml).toContain('const selectedOrgId = getSelectedOrganizationId();');
    expect(chatHtml).toContain("const orgParam = selectedOrgId ? `&org=${encodeURIComponent(selectedOrgId)}` : '';");
    expect(chatHtml).toContain('authFetch(`/api/me/addie-home?format=html${orgParam}`)');
  });

  it('forwards the selected organization in chat stream requests', () => {
    expect(chatHtml).toContain('organization_id: getSelectedOrganizationId(),');
  });
});
