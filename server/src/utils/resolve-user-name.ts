import type { PoolClient, Pool } from 'pg';

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
      const parts = slackName.trim().split(/\s+/);
      firstName = parts[0] ?? null;
      lastName = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }
  }

  return { firstName, lastName };
}
