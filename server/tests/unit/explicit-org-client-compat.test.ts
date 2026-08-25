import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(
  new URL('../../public/dashboard-agents.html', import.meta.url),
  'utf8',
);
const onboardingSource = readFileSync(
  new URL('../../public/onboarding.html', import.meta.url),
  'utf8',
);

describe('explicit organization client compatibility', () => {
  it('forwards the selected dashboard organization on private agent requests', () => {
    expect(dashboardSource).toContain(
      'body: JSON.stringify({ visibility: target, organization_id: pageState.orgId || undefined })',
    );
    expect(dashboardSource).toContain(
      'organization_id: pageState.orgId || undefined',
    );
    expect(dashboardSource).toContain(
      '/monitoring/requests?limit=50${orgQuery}',
    );
    expect(dashboardSource).toContain(
      '/storyboard-status\' + orgQuery',
    );
  });

  it('carries a newly created or selected organization into brand setup', () => {
    expect(onboardingSource).toContain(
      'showBrandSetup(companyOrg.name, domain, companyOrg.id)',
    );
    expect(onboardingSource).toContain(
      'showBrandSetup(orgName, corporateDomain, data.organization?.id || data.id)',
    );
    expect(onboardingSource).toContain(
      'organization_id: createdOrgId || undefined',
    );
  });
});
