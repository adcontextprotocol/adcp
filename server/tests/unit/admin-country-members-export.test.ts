import { describe, expect, it } from 'vitest';

import { buildCountryMembersCsv } from '../../src/routes/admin/country-members-export.js';

describe('country member export', () => {
  it('labels account registration dates and escapes CSV values', () => {
    const csv = buildCountryMembersCsv([{
      workos_user_id: 'user_test',
      email: 'jane@example.com',
      first_name: 'Jane',
      last_name: 'O"Connor',
      city: 'Toronto',
      country: 'Canada',
      location_source: 'profile',
      registered_at: '2026-08-01T12:30:00.000Z',
      organization_names: ['Example, Inc.', 'Second Org'],
    }]);

    expect(csv).toContain('"Account Registered At"');
    expect(csv).toContain('"Jane O""Connor"');
    expect(csv).toContain('"Example, Inc.; Second Org"');
    expect(csv).toContain('"2026-08-01T12:30:00.000Z"');
  });

  it('neutralizes spreadsheet formulas in user-controlled fields', () => {
    const csv = buildCountryMembersCsv([{
      workos_user_id: 'user_test',
      email: 'safe@example.com',
      first_name: '=HYPERLINK("https://example.com")',
      last_name: null,
      city: null,
      country: 'Canada',
      location_source: null,
      registered_at: '2026-08-01T12:30:00.000Z',
      organization_names: ['+SUM(1,1)'],
    }]);

    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(csv).toContain('"\'+SUM(1,1)"');
  });
});
