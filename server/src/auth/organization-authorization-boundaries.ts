/** Fixed rollout boundaries shared by persistence, runtime evaluation, and admin controls. */
export const ORGANIZATION_AUTHORIZATION_BOUNDARIES = {
  ORGANIZATION_ROLES_READ: 'organization_roles_read',
  ORGANIZATION_DOMAINS_READ: 'organization_domains_read',
  ORGANIZATION_PENDING_JOIN_REQUEST_COUNT_READ: 'organization_pending_join_request_count_read',
  ORGANIZATION_PENDING_JOIN_REQUESTS_READ: 'organization_pending_join_requests_read',
  ORGANIZATION_REFERRAL_CODES_READ: 'organization_referral_codes_read',
  ORGANIZATION_CERTIFICATION_STALLED_COUNT_READ: 'organization_certification_stalled_count_read',
} as const;

export type OrganizationAuthorizationBoundary =
  (typeof ORGANIZATION_AUTHORIZATION_BOUNDARIES)[keyof typeof ORGANIZATION_AUTHORIZATION_BOUNDARIES];

export const ORGANIZATION_AUTHORIZATION_BOUNDARY_VALUES: readonly OrganizationAuthorizationBoundary[] =
  Object.values(ORGANIZATION_AUTHORIZATION_BOUNDARIES);
