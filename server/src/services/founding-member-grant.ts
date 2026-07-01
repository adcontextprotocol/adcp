import type { UpdateMemberProfileInput } from '../types.js';

export type FoundingMemberSource = 'auto_pre_cutoff' | 'manual_grandfather';

const VALID_SOURCES: readonly FoundingMemberSource[] = [
  'auto_pre_cutoff',
  'manual_grandfather',
];

export interface FoundingMemberGrantError {
  code: 'missing_source' | 'invalid_source' | 'orphan_metadata';
  message: string;
}

/**
 * Normalize a member-profile update so that the founding-member audit
 * columns stay coherent with the boolean flag.
 *
 * Rules:
 *   - is_founding_member=true requires founding_member_source. granted_at
 *     is always set server-side to NOW() (callers can't backdate it).
 *   - is_founding_member=false clears source/granted_at/reason so a future
 *     re-grant carries fresh provenance instead of stale metadata.
 *   - Sending source/granted_reason without flipping is_founding_member
 *     in the same call is rejected — the boolean is the source of truth.
 *
 * Mutates `updates` in place. Returns null on success, an error object on
 * validation failure. The list of fields actually written by this helper
 * is exposed via {@link foundingMemberFieldsTouched} so callers (e.g. the
 * MCP tool's "updated fields" report) can mirror what landed in the DB.
 */
export function normalizeFoundingMemberGrant(
  updates: UpdateMemberProfileInput
): FoundingMemberGrantError | null {
  const hasFlag = updates.is_founding_member !== undefined;
  const hasMetadata =
    updates.founding_member_source !== undefined ||
    updates.founding_member_granted_reason !== undefined;

  if (!hasFlag && !hasMetadata) {
    return null;
  }

  if (!hasFlag && hasMetadata) {
    return {
      code: 'orphan_metadata',
      message:
        'founding_member_source / granted_reason can only be set together with is_founding_member.',
    };
  }

  if (updates.is_founding_member === true) {
    const source = updates.founding_member_source;
    if (!source) {
      return {
        code: 'missing_source',
        message:
          'founding_member_source is required when granting founding member status. Use "manual_grandfather" for admin overrides.',
      };
    }
    if (!VALID_SOURCES.includes(source)) {
      return {
        code: 'invalid_source',
        message: `founding_member_source must be one of: ${VALID_SOURCES.join(', ')}.`,
      };
    }
    updates.founding_member_granted_at = new Date();
    return null;
  }

  // is_founding_member === false: revoke and clear audit metadata.
  updates.founding_member_source = null;
  updates.founding_member_granted_at = null;
  updates.founding_member_granted_reason = null;
  return null;
}

/**
 * Names of the founding-member columns this helper may have written into
 * `updates` (after a successful normalize). For MCP-style "updated fields"
 * reports that need to mirror what actually landed.
 */
export function foundingMemberFieldsTouched(
  updates: UpdateMemberProfileInput
): string[] {
  return [
    'is_founding_member',
    'founding_member_source',
    'founding_member_granted_at',
    'founding_member_granted_reason',
  ].filter((k) => k in updates);
}
