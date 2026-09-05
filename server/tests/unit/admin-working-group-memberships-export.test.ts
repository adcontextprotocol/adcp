import { describe, expect, it } from 'vitest';

import { buildWorkingGroupMembershipsCsv } from '../../src/routes/admin/working-group-memberships-export.js';

describe('working group memberships export', () => {
  it('includes location and safely encodes user-controlled CSV values', () => {
    const csv = buildWorkingGroupMembershipsCsv([{
      user_id: 'user_test',
      user_email: 'jane@example.com',
      user_name: 'Jane O"Connor, Jr.',
      user_org_name: '+SUM(1,1)',
      city: 'New\nYork',
      country: '=HYPERLINK("https://example.com")',
      working_group_id: 'wg_test',
      working_group_name: 'Events, North America',
      working_group_slug: 'events-north-america',
      is_private: false,
      joined_at: new Date('2026-08-01T12:30:00.000Z'),
    }]);

    expect(csv).toContain('"City","Country"');
    expect(csv).toContain('"Jane O""Connor, Jr."');
    expect(csv).toContain('"\'+SUM(1,1)"');
    expect(csv).toContain('"New\nYork"');
    expect(csv).toContain('"\'=HYPERLINK(""https://example.com"")"');
    expect(csv).toContain('"Events, North America"');
    expect(csv).toContain('"2026-08-01"');
  });

  it('renders unknown locations as blank cells', () => {
    const csv = buildWorkingGroupMembershipsCsv([{
      user_id: 'user_without_location',
      user_email: 'no-location@example.com',
      user_name: 'No Location',
      user_org_name: 'Example Org',
      city: null,
      country: null,
      working_group_id: 'wg_test',
      working_group_name: 'Events',
      working_group_slug: 'events',
      is_private: false,
      joined_at: new Date('2026-08-01T12:30:00.000Z'),
    }]);

    expect(csv.split('\n')[1]).toContain('"Example Org","","","Events"');
  });
});
