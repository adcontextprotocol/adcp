/**
 * Database operations for working group biweekly digests
 */

import { query } from './client.js';

export interface WgDigestRecord {
  id: string;
  working_group_id: string;
  edition_date: string;
  content: WgDigestContent | null;
  status: 'pending' | 'sent' | 'skipped';
  sent_at: Date | null;
  recipient_count: number;
  created_at: Date;
}

export interface WgDigestContent {
  groupName: string;
  summary: string | null;
  meetingRecaps: WgDigestMeetingRecap[];
  nextMeeting: { title: string; date: string } | null;
  activeThreads: WgDigestThread[];
  newMembers: string[];
}

export interface WgDigestMeetingRecap {
  title: string;
  date: string;
  summary: string;
}

export interface WgDigestThread {
  summary: string;
  replyCount: number;
  threadUrl: string;
}

/**
 * Create a digest record for a working group edition. Returns null if already exists.
 */
export async function createWgDigest(
  workingGroupId: string,
  editionDate: string,
  content: WgDigestContent,
): Promise<WgDigestRecord | null> {
  const result = await query<WgDigestRecord>(
    `INSERT INTO wg_digests (working_group_id, edition_date, content, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (working_group_id, edition_date) DO NOTHING
     RETURNING *`,
    [workingGroupId, editionDate, JSON.stringify(content)],
  );
  return result.rows[0] || null;
}

/**
 * Get a digest record for a specific group and date
 */
export async function getWgDigest(
  workingGroupId: string,
  editionDate: string,
): Promise<WgDigestRecord | null> {
  const result = await query<WgDigestRecord>(
    `SELECT * FROM wg_digests WHERE working_group_id = $1 AND edition_date = $2`,
    [workingGroupId, editionDate],
  );
  return result.rows[0] || null;
}

/**
 * Mark a digest as sent with recipient count
 */
export async function markWgDigestSent(id: string, recipientCount: number): Promise<void> {
  await query(
    `UPDATE wg_digests SET status = 'sent', sent_at = NOW(), recipient_count = $2 WHERE id = $1`,
    [id, recipientCount],
  );
}

/**
 * Mark a digest as skipped (no content worth sending)
 */
export async function markWgDigestSkipped(id: string): Promise<void> {
  await query(
    `UPDATE wg_digests SET status = 'skipped' WHERE id = $1`,
    [id],
  );
}

/**
 * Get email recipients for a specific working group.
 * Returns active members who haven't opted out of working_groups email category.
 */
export async function getWgDigestRecipients(workingGroupId: string): Promise<Array<{
  workos_user_id: string;
  email: string;
  first_name: string | null;
}>> {
  const result = await query<{
    workos_user_id: string;
    email: string;
    first_name: string | null;
  }>(
    `SELECT
       u.workos_user_id,
       u.email,
       u.first_name
     FROM working_group_memberships wgm
     JOIN users u ON u.workos_user_id = wgm.workos_user_id
     WHERE wgm.working_group_id = $1
       AND wgm.status = 'active'
       AND u.email IS NOT NULL
       AND u.email != ''
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         JOIN user_email_category_preferences uecp ON uecp.user_preference_id = uep.id
         WHERE uep.workos_user_id = u.workos_user_id
           AND uecp.category_id = 'working_groups'
           AND uecp.enabled = FALSE
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_email_preferences uep
         WHERE uep.workos_user_id = u.workos_user_id
           AND uep.global_unsubscribe = TRUE
       )`,
    [workingGroupId],
  );
  return result.rows;
}
