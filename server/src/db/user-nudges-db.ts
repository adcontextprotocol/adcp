/**
 * Per-user dismissed-nudges state.
 *
 * Tracks when a user dismissed a soft banner / in-app prompt so the
 * caller can implement a re-surface cooldown without each feature
 * building its own dismissal table. First consumer: brand-claim
 * suggestion (#4744).
 *
 * nudge_key namespacing convention: `<feature>:<scope>`. The scope is
 * optional — `onboarding:welcome` and `brand_claim_suggestion:scope3.com`
 * both work. Re-dismissal updates `dismissed_at` so the cooldown clock
 * resets, which is the legible behaviour for a user clicking "dismiss"
 * a second time.
 */

import { query } from './client.js';

export interface DismissedNudge {
  workos_user_id: string;
  nudge_key: string;
  dismissed_at: Date;
}

export async function recordNudgeDismissal(
  workosUserId: string,
  nudgeKey: string,
): Promise<void> {
  await query(
    `INSERT INTO user_dismissed_nudges (workos_user_id, nudge_key, dismissed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (workos_user_id, nudge_key)
     DO UPDATE SET dismissed_at = NOW()`,
    [workosUserId, nudgeKey],
  );
}

/**
 * Return the most recent dismissal for the given user/key, or null if
 * the user has never dismissed it. Caller decides whether the cooldown
 * is still active — `NOW() - dismissed_at < interval`.
 */
export async function getNudgeDismissal(
  workosUserId: string,
  nudgeKey: string,
): Promise<DismissedNudge | null> {
  const result = await query<DismissedNudge>(
    `SELECT workos_user_id, nudge_key, dismissed_at
       FROM user_dismissed_nudges
      WHERE workos_user_id = $1 AND nudge_key = $2`,
    [workosUserId, nudgeKey],
  );
  return result.rows[0] ?? null;
}
