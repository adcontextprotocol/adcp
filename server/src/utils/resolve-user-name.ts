import type { PoolClient, Pool } from 'pg';

const MAX_NAME_LEN = 255;

// Defense-in-depth: drop C0/C1 controls, DEL, and Unicode direction/format
// characters (U+200B..F, U+202A..E, U+2060..4, U+FEFF). A user setting their
// Slack display name to an RTL-override that renders one way in Slack and
// another on a Certifier PDF or in an Addie speaker prefix is a real (if
// minor) spoofing surface; strip these before the value leaves the helper.
function isInvisibleOrControl(cp: number): boolean {
  // Keep \t (0x09), \n (0x0a), \r (0x0d) — they're treated as whitespace by
  // the trim+collapse step below, so "Tom\tHespos" collapses to "Tom Hespos".
  return (
    (cp >= 0x00 && cp <= 0x08) ||
    cp === 0x0b ||
    cp === 0x0c ||
    (cp >= 0x0e && cp <= 0x1f) ||
    cp === 0x7f ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    cp === 0xfeff
  );
}

function stripInvisibles(value: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isInvisibleOrControl(cp)) out += ch;
  }
  return out;
}

/**
 * Strip invisible / control characters, collapse internal whitespace runs,
 * trim, and cap at 255 chars. Multi-word first names like "Mary Jane" stay
 * intact — this is *not* a name-splitter; use `splitFullName` for that.
 */
export function sanitizeName(value: string): string {
  return stripInvisibles(value).trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LEN);
}

/**
 * Split a single "full name" string into first / last. Collapses any run of
 * whitespace, so "Tom  Hespos", "Tom\tHespos", and "Tom Hespos" all produce
 * the same result. Returns `null` for the last half when the input is a
 * single name like "Cher". Also strips invisible / control characters and
 * caps each half at 255 chars (matches the `users` table column).
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string | null } {
  const cleaned = sanitizeName(fullName);
  if (!cleaned) return { firstName: '', lastName: null };
  const parts = cleaned.split(' ');
  const firstName = (parts[0] ?? '').slice(0, MAX_NAME_LEN);
  const lastName = parts.length > 1 ? parts.slice(1).join(' ').slice(0, MAX_NAME_LEN) : null;
  return { firstName, lastName };
}

/**
 * Resolve a user's name with a fallback cascade so we don't end up persisting
 * NULL first/last when richer data already exists in our system. The cascade:
 *
 *   1. WorkOS values (if set) — these are the user-provided source of truth
 *   2. Existing `users.first_name` / `users.last_name` — preserve anything the
 *      user supplied via /api/me/name even if WorkOS later sends nulls
 *   3. `slack_user_mappings.slack_real_name` / `slack_display_name` — many
 *      learners auth via Slack-linked WorkOS accounts; Slack has the human
 *      name even when WorkOS profile fields are empty
 *
 * Returns the resolved pair. Falls through to the input WorkOS values if no
 * fallback applies, so callers can use the result unconditionally.
 *
 * Mirrors the inline cascade in `workos-webhooks.ts:upsertUser` so the OAuth
 * callback and the user.updated webhook agree on the resolved name.
 */
export async function resolveUserNameWithFallbacks(
  db: Pick<Pool | PoolClient, 'query'>,
  workosUserId: string,
  workosFirstName: string | null | undefined,
  workosLastName: string | null | undefined,
): Promise<{ firstName: string | null; lastName: string | null }> {
  let firstName = workosFirstName ?? null;
  let lastName = workosLastName ?? null;

  if (firstName?.trim() && lastName?.trim()) {
    return { firstName, lastName };
  }

  const existing = await db.query<{
    first_name: string | null;
    last_name: string | null;
    slack_real_name: string | null;
    slack_display_name: string | null;
  }>(
    `SELECT u.first_name, u.last_name, sm.slack_real_name, sm.slack_display_name
       FROM users u
       LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = u.primary_slack_user_id
      WHERE u.workos_user_id = $1`,
    [workosUserId],
  );

  if (existing.rows.length === 0) {
    return { firstName, lastName };
  }

  const row = existing.rows[0];
  if (!firstName?.trim()) firstName = row.first_name;
  if (!lastName?.trim()) lastName = row.last_name;

  if (!firstName?.trim() && !lastName?.trim()) {
    const slackName = row.slack_real_name || row.slack_display_name;
    if (slackName) {
      const split = splitFullName(slackName);
      firstName = split.firstName || null;
      lastName = split.lastName;
    }
  }

  return { firstName, lastName };
}
