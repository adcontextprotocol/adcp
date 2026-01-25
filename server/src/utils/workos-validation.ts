/**
 * WorkOS ID Validation Utilities
 *
 * WorkOS uses ULIDs (Universally Unique Lexicographically Sortable Identifiers)
 * for their entity IDs. ULIDs are 26 characters using Crockford's base32 alphabet
 * (0-9, A-Z excluding I, L, O, U).
 *
 * WorkOS ID format: {prefix}_{ulid}
 * Examples:
 *   - Organization membership: om_01HPQRS...
 *   - User: user_01HPQRS...
 *   - Organization: org_01HPQRS...
 */

/**
 * Validates a WorkOS organization membership ID.
 * Format: om_ followed by a 26-character ULID
 *
 * @param membershipId - The membership ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidWorkOSMembershipId(membershipId: string): boolean {
  // WorkOS membership IDs: om_ + 26 char ULID
  // ULID uses Crockford's base32: 0-9, A-H, J-N, P-Z (excludes I, L, O, U)
  // However, WorkOS may use lowercase or mixed case, so we accept both
  const WORKOS_MEMBERSHIP_ID_PATTERN = /^om_[0-9A-Za-z]{26}$/;
  return WORKOS_MEMBERSHIP_ID_PATTERN.test(membershipId);
}

/**
 * Validates a WorkOS user ID.
 * Format: user_ followed by a 26-character ULID
 *
 * @param userId - The user ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidWorkOSUserId(userId: string): boolean {
  const WORKOS_USER_ID_PATTERN = /^user_[0-9A-Za-z]{26}$/;
  return WORKOS_USER_ID_PATTERN.test(userId);
}

/**
 * Validates a WorkOS organization ID.
 * Format: org_ followed by a 26-character ULID
 *
 * @param orgId - The organization ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidWorkOSOrganizationId(orgId: string): boolean {
  const WORKOS_ORG_ID_PATTERN = /^org_[0-9A-Za-z]{26}$/;
  return WORKOS_ORG_ID_PATTERN.test(orgId);
}
