import { csvCell } from './country-members-export.js';

export interface WorkingGroupMembershipExportRow {
  user_name: string | null;
  user_email: string | null;
  user_org_name: string | null;
  city: string | null;
  country: string | null;
  working_group_name: string;
  joined_at: Date | string | null;
}

export function buildWorkingGroupMembershipsCsv(
  memberships: WorkingGroupMembershipExportRow[],
): string {
  const header = [
    'User Name',
    'Email',
    'Organization',
    'City',
    'Country',
    'Working Group',
    'Joined At',
  ];
  const lines = memberships.map((membership) => [
    membership.user_name,
    membership.user_email,
    membership.user_org_name,
    membership.city,
    membership.country,
    membership.working_group_name,
    membership.joined_at
      ? new Date(membership.joined_at).toISOString().split('T')[0]
      : '',
  ].map(csvCell).join(','));

  return [header.map(csvCell).join(','), ...lines].join('\n');
}
