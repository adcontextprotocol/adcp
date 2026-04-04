/**
 * Newsletter Suggestions — Database Layer
 *
 * Community members suggest content for newsletters via Addie.
 * Suggestions are reviewed by editors during the draft process.
 */

import { query } from './client.js';

export interface NewsletterSuggestion {
  id: number;
  newsletter_id: string;
  suggested_by_user_id: string;
  suggested_by_name: string | null;
  title: string;
  url: string | null;
  description: string | null;
  source_channel: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'included';
  included_in_edition_date: Date | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

/**
 * Create a new suggestion.
 */
export async function createSuggestion(data: {
  newsletterId: string;
  suggestedByUserId: string;
  suggestedByName?: string;
  title: string;
  url?: string;
  description?: string;
  sourceChannel?: string;
}): Promise<NewsletterSuggestion> {
  const result = await query<NewsletterSuggestion>(
    `INSERT INTO newsletter_suggestions
       (newsletter_id, suggested_by_user_id, suggested_by_name, title, url, description, source_channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [data.newsletterId, data.suggestedByUserId, data.suggestedByName || null, data.title, data.url || null, data.description || null, data.sourceChannel || null],
  );
  return result.rows[0];
}

/**
 * Get pending suggestions for a newsletter, for inclusion in the next draft.
 */
export async function getPendingSuggestions(newsletterId: string): Promise<NewsletterSuggestion[]> {
  const result = await query<NewsletterSuggestion>(
    `SELECT * FROM newsletter_suggestions
     WHERE newsletter_id = $1 AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 20`,
    [newsletterId],
  );
  return result.rows;
}

/**
 * Accept a suggestion (editor reviewed it, will include in draft).
 */
export async function acceptSuggestion(id: number, reviewedBy: string): Promise<NewsletterSuggestion | null> {
  const result = await query<NewsletterSuggestion>(
    `UPDATE newsletter_suggestions
     SET status = 'accepted', reviewed_by = $2, reviewed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, reviewedBy],
  );
  return result.rows[0] || null;
}

/**
 * Decline a suggestion.
 */
export async function declineSuggestion(id: number, reviewedBy: string): Promise<NewsletterSuggestion | null> {
  const result = await query<NewsletterSuggestion>(
    `UPDATE newsletter_suggestions
     SET status = 'declined', reviewed_by = $2, reviewed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, reviewedBy],
  );
  return result.rows[0] || null;
}

/**
 * Mark suggestions as included in a specific edition.
 */
export async function markSuggestionsIncluded(ids: number[], editionDate: string): Promise<void> {
  if (ids.length === 0) return;
  await query(
    `UPDATE newsletter_suggestions
     SET status = 'included', included_in_edition_date = $2
     WHERE id = ANY($1)`,
    [ids, editionDate],
  );
}

/**
 * Get suggestions by a specific user (for "your suggestion was included" notifications).
 */
export async function getIncludedSuggestionsByUser(
  userId: string,
  editionDate: string,
): Promise<NewsletterSuggestion[]> {
  const result = await query<NewsletterSuggestion>(
    `SELECT * FROM newsletter_suggestions
     WHERE suggested_by_user_id = $1
       AND included_in_edition_date = $2
       AND status = 'included'`,
    [userId, editionDate],
  );
  return result.rows;
}
