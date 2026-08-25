/** Fixed rollout boundaries shared by persistence, runtime evaluation, and admin controls. */
export const ORGANIZATION_AUTHORIZATION_BOUNDARIES = {
  ORGANIZATION_ROLES_READ: 'organization_roles_read',
} as const;

export type OrganizationAuthorizationBoundary =
  (typeof ORGANIZATION_AUTHORIZATION_BOUNDARIES)[keyof typeof ORGANIZATION_AUTHORIZATION_BOUNDARIES];

export const ORGANIZATION_AUTHORIZATION_BOUNDARY_VALUES: readonly OrganizationAuthorizationBoundary[] =
  Object.values(ORGANIZATION_AUTHORIZATION_BOUNDARIES);
