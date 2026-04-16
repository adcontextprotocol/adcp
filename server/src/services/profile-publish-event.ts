/**
 * Emits a `profile_published` org_activity when a member_profiles.is_public
 * transitions from not-public into public. Downstream workers (new-member
 * announcements) listen for this activity type.
 */

import { query } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('profile-publish-event');

/**
 * True when a profile update crosses from not-public into public. Called
 * on both create and update paths; a profile that was already public, or
 * one not being set public, should not emit the event again.
 */
export function isProfilePublishTransition(
  previousIsPublic: boolean | null | undefined,
  nextIsPublic: boolean | null | undefined
): boolean {
  return nextIsPublic === true && previousIsPublic !== true;
}

/**
 * Record a profile_published activity when a member profile transitions
 * to is_public = true. No-op if the transition predicate is false.
 */
export async function recordProfilePublishedIfNeeded(
  orgId: string,
  previousIsPublic: boolean | null | undefined,
  nextIsPublic: boolean | null | undefined,
  userId: string
): Promise<void> {
  if (!isProfilePublishTransition(previousIsPublic, nextIsPublic)) return;
  try {
    await query(
      `INSERT INTO org_activities (
         organization_id, activity_type, description, logged_by_user_id, activity_date
       ) VALUES ($1, 'profile_published', 'Member profile marked public', $2, NOW())`,
      [orgId, userId]
    );
  } catch (err) {
    logger.warn({ err, orgId }, 'Failed to record profile_published activity');
  }
}
