import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
