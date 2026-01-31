/**
 * Database layer for notification channels
 * Manages Slack channels that receive AI-routed industry alerts
 */

import { query } from './client.js';

// ============== Types ==============

export interface FallbackRules {
  min_quality?: number;
  require_tags?: string[];
  require_mentions_adcp?: boolean;
  require_mentions_agentic?: boolean;
}

export interface NotificationChannel {
  id: number;
  name: string;
  slack_channel_id: string;
  description: string;
  fallback_rules: FallbackRules;
  is_active: boolean;
  website_slug: string | null;
  website_enabled: boolean;
  display_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface NotificationChannelInput {
  name: string;
  slack_channel_id: string;
  description: string;
  fallback_rules?: FallbackRules;
  is_active?: boolean;
  website_slug?: string | null;
  website_enabled?: boolean;
  display_order?: number;
}

// ============== Channel Operations ==============

/**
 * Get all notification channels
 */
export async function getAllChannels(): Promise<NotificationChannel[]> {
  const result = await query<NotificationChannel>(
    `SELECT * FROM notification_channels ORDER BY name`
  );
  return result.rows;
}

/**
 * Get only active notification channels
 */
export async function getActiveChannels(): Promise<NotificationChannel[]> {
  const result = await query<NotificationChannel>(
    `SELECT * FROM notification_channels WHERE is_active = true ORDER BY name`
  );
  return result.rows;
}

/**
 * Get a single channel by ID
 */
export async function getChannelById(id: number): Promise<NotificationChannel | null> {
  const result = await query<NotificationChannel>(
    `SELECT * FROM notification_channels WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get a channel by Slack channel ID
 */
export async function getChannelBySlackId(slackChannelId: string): Promise<NotificationChannel | null> {
  const result = await query<NotificationChannel>(
    `SELECT * FROM notification_channels WHERE slack_channel_id = $1`,
    [slackChannelId]
  );
  return result.rows[0] || null;
}

/**
 * Get a channel by name (case-insensitive)
 */
export async function getChannelByName(name: string): Promise<NotificationChannel | null> {
  const result = await query<NotificationChannel>(
    `SELECT * FROM notification_channels WHERE LOWER(name) = LOWER($1)`,
    [name]
  );
  return result.rows[0] || null;
}

/**
 * Create a new notification channel
 */
export async function createChannel(data: NotificationChannelInput): Promise<NotificationChannel> {
  const result = await query<NotificationChannel>(
    `INSERT INTO notification_channels (name, slack_channel_id, description, fallback_rules, is_active, website_slug, website_enabled, display_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.name,
      data.slack_channel_id,
      data.description,
      JSON.stringify(data.fallback_rules || {}),
      data.is_active ?? true,
      data.website_slug ?? null,
      data.website_enabled ?? false,
      data.display_order ?? 0,
    ]
  );
  return result.rows[0];
}

/**
 * Update an existing notification channel
 */
export async function updateChannel(
  id: number,
  data: Partial<NotificationChannelInput>
): Promise<NotificationChannel | null> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.slack_channel_id !== undefined) {
    updates.push(`slack_channel_id = $${paramIndex++}`);
    values.push(data.slack_channel_id);
  }
  if (data.description !== undefined) {
    updates.push(`description = $${paramIndex++}`);
    values.push(data.description);
  }
  if (data.fallback_rules !== undefined) {
    updates.push(`fallback_rules = $${paramIndex++}`);
    values.push(JSON.stringify(data.fallback_rules));
  }
  if (data.is_active !== undefined) {
    updates.push(`is_active = $${paramIndex++}`);
    values.push(data.is_active);
  }
  if (data.website_slug !== undefined) {
    updates.push(`website_slug = $${paramIndex++}`);
    values.push(data.website_slug);
  }
  if (data.website_enabled !== undefined) {
    updates.push(`website_enabled = $${paramIndex++}`);
    values.push(data.website_enabled);
  }
  if (data.display_order !== undefined) {
    updates.push(`display_order = $${paramIndex++}`);
    values.push(data.display_order);
  }

  if (updates.length === 0) {
    return getChannelById(id);
  }

  updates.push(`updated_at = NOW()`);
  values.push(id);

  const result = await query<NotificationChannel>(
    `UPDATE notification_channels
     SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

/**
 * Toggle channel active status
 * Returns true if a channel was updated, false if not found
 */
export async function setChannelActive(id: number, isActive: boolean): Promise<boolean> {
  const result = await query(
    `UPDATE notification_channels SET is_active = $2, updated_at = NOW() WHERE id = $1`,
    [id, isActive]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Delete a notification channel
 */
export async function deleteChannel(id: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM notification_channels WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

// ============== Website Channel Operations ==============

/**
 * Get website-enabled channels for public display
 */
export async function getWebsiteChannels(): Promise<NotificationChannel[]> {
  const result = await query<NotificationChannel>(
    `SELECT * FROM notification_channels
     WHERE website_enabled = true AND is_active = true
     ORDER BY display_order, name`
  );
  return result.rows;
}

/**
 * Get a channel by its website slug
 */
export async function getChannelByWebsiteSlug(slug: string): Promise<NotificationChannel | null> {
  const result = await query<NotificationChannel>(
    `SELECT * FROM notification_channels
     WHERE website_slug = $1 AND website_enabled = true AND is_active = true`,
    [slug]
  );
  return result.rows[0] || null;
}

/**
 * Check if a channel is website-only (no Slack delivery)
 */
export function isWebsiteOnlyChannel(channel: NotificationChannel): boolean {
  return channel.slack_channel_id.startsWith('WEBSITE_ONLY_');
}

// ============== Routing Operations ==============

/**
 * Update the notification channel routing for a knowledge entry
 */
export async function updateKnowledgeRouting(
  sourceUrl: string,
  channelIds: string[]
): Promise<void> {
  await query(
    `UPDATE addie_knowledge
     SET notification_channel_ids = $2, updated_at = NOW()
     WHERE source_url = $1`,
    [sourceUrl, channelIds]
  );
}

/**
 * Get channel routing stats for admin display
 */
export async function getChannelStats(): Promise<{
  totalChannels: number;
  activeChannels: number;
  alertsToday: number;
  articlesRoutedToday: number;
}> {
  const [channelCounts, alertsToday, articlesRouted] = await Promise.all([
    query<{ total: string; active: string }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE is_active = true) as active
       FROM notification_channels`
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM industry_alerts
       WHERE sent_at > NOW() - INTERVAL '24 hours'`
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count
       FROM addie_knowledge
       WHERE notification_channel_ids IS NOT NULL
         AND array_length(notification_channel_ids, 1) > 0
         AND updated_at > NOW() - INTERVAL '24 hours'`
    ),
  ]);

  return {
    totalChannels: parseInt(channelCounts.rows[0]?.total || '0', 10),
    activeChannels: parseInt(channelCounts.rows[0]?.active || '0', 10),
    alertsToday: parseInt(alertsToday.rows[0]?.count || '0', 10),
    articlesRoutedToday: parseInt(articlesRouted.rows[0]?.count || '0', 10),
  };
}
