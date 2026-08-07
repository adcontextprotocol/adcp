export const MEMBER_PROFILE_URL_FIELDS = [
  'linkedin_url',
  'twitter_url',
  'contact_website',
] as const;

export type MemberProfileUrlField = (typeof MEMBER_PROFILE_URL_FIELDS)[number];

// URL parsing silently removes ASCII controls and reinterprets backslashes.
// Reject those raw forms, plus HTML delimiters, before writers persist them.
const AMBIGUOUS_MEMBER_PROFILE_URL_CHARACTERS = /[\u0000-\u001F\u007F<>\\]/;

/**
 * Validate member-controlled URLs before they reach member_profiles.
 *
 * Empty values are allowed so callers can omit or clear these optional fields.
 * Non-empty values must be bounded HTTPS URLs without embedded credentials.
 */
export function validateMemberProfileUrlFields(
  input: Record<string, unknown>,
): MemberProfileUrlField | null {
  for (const field of MEMBER_PROFILE_URL_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (
      typeof value !== 'string'
      || value.length > 2048
      || AMBIGUOUS_MEMBER_PROFILE_URL_CHARACTERS.test(value)
    ) return field;

    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        return field;
      }
    } catch {
      return field;
    }
  }

  return null;
}
