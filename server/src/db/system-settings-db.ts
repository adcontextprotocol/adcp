/**
 * Database layer for system settings
 * Manages key-value configuration for application-wide settings
 */

import { query } from './client.js';

// ============== Types ==============

export interface SystemSetting<T = unknown> {
  key: string;
  value: T;
  description: string | null;
  updated_at: Date;
  updated_by: string | null;
}

export interface SystemSettingAuditEntry {
  id: string;
  key: string;
  old_value: unknown | null;
  new_value: unknown;
  changed_by: string | null;
  changed_at: Date;
}

export interface BillingChannelSetting {
  channel_id: string | null;
  channel_name: string | null;
}

export interface EscalationChannelSetting {
  channel_id: string | null;
  channel_name: string | null;
}

export interface AdminChannelSetting {
  channel_id: string | null;
  channel_name: string | null;
}

export interface ProspectChannelSetting {
  channel_id: string | null;
  channel_name: string | null;
}

export interface ErrorChannelSetting {
  channel_id: string | null;
  channel_name: string | null;
}

export interface EditorialChannelSetting {
  channel_id: string | null;
  channel_name: string | null;
}

export interface AnnouncementChannelSetting {
  channel_id: string | null;
  channel_name: string | null;
}

// ============== Setting Keys ==============

export const SETTING_KEYS = {
  BILLING_SLACK_CHANNEL: 'billing_slack_channel',
  ESCALATION_SLACK_CHANNEL: 'escalation_slack_channel',
  ADMIN_SLACK_CHANNEL: 'admin_slack_channel',
  PROSPECT_SLACK_CHANNEL: 'prospect_slack_channel',
  PROSPECT_TRIAGE_ENABLED: 'prospect_triage_enabled',
  ERROR_SLACK_CHANNEL: 'error_slack_channel',
  EDITORIAL_SLACK_CHANNEL: 'editorial_slack_channel',
  ANNOUNCEMENT_SLACK_CHANNEL: 'announcement_slack_channel',
  AUTO_APPLY_AAO_BADGE: 'auto_apply_aao_badge',
} as const;

// ============== Generic Operations ==============

/**
 * Get a setting by key
 */
export async function getSetting<T>(key: string): Promise<T | null> {
  const result = await query<{ value: T }>(
    `SELECT value FROM system_settings WHERE key = $1`,
    [key]
  );
  return result.rows[0]?.value ?? null;
}

/**
 * Set a setting value and atomically record the change in the audit table.
 * Uses a writable CTE so the old value, upsert, and audit INSERT all occur
 * in a single round-trip with no TOCTOU gap.
 */
export async function setSetting<T>(
  key: string,
  value: T,
  updatedBy?: string
): Promise<void> {
  await query(
    `WITH old AS (
       SELECT value AS old_value FROM system_settings WHERE key = $1
     ),
     upserted AS (
       INSERT INTO system_settings (key, value, updated_at, updated_by)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (key)
       DO UPDATE SET value = $2::jsonb, updated_at = NOW(), updated_by = $3
       RETURNING value AS new_value
     )
     INSERT INTO system_settings_audit (key, old_value, new_value, changed_by, changed_at)
     SELECT $1, old.old_value, upserted.new_value, $3, NOW()
     FROM upserted
     LEFT JOIN old ON true`,
    [key, JSON.stringify(value), updatedBy ?? null]
  );
}

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<SystemSetting[]> {
  const result = await query<SystemSetting>(
    `SELECT * FROM system_settings ORDER BY key`
  );
  return result.rows;
}

/**
 * Get recent audit entries for system settings changes
 */
export async function getSettingAuditHistory(limit = 50): Promise<SystemSettingAuditEntry[]> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const result = await query<SystemSettingAuditEntry>(
    `SELECT id, key, old_value, new_value, changed_by, changed_at
     FROM system_settings_audit
     ORDER BY changed_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}

// ============== Billing Channel Operations ==============

/**
 * Get the configured billing notification Slack channel
 */
export async function getBillingChannel(): Promise<BillingChannelSetting> {
  const result = await getSetting<BillingChannelSetting>(SETTING_KEYS.BILLING_SLACK_CHANNEL);
  return result ?? { channel_id: null, channel_name: null };
}

/**
 * Set the billing notification Slack channel
 */
export async function setBillingChannel(
  channelId: string | null,
  channelName: string | null,
  updatedBy?: string
): Promise<void> {
  await setSetting<BillingChannelSetting>(
    SETTING_KEYS.BILLING_SLACK_CHANNEL,
    { channel_id: channelId, channel_name: channelName },
    updatedBy
  );
}

// ============== Escalation Channel Operations ==============

/**
 * Get the configured escalation notification Slack channel
 */
export async function getEscalationChannel(): Promise<EscalationChannelSetting> {
  const result = await getSetting<EscalationChannelSetting>(SETTING_KEYS.ESCALATION_SLACK_CHANNEL);
  return result ?? { channel_id: null, channel_name: null };
}

/**
 * Set the escalation notification Slack channel
 */
export async function setEscalationChannel(
  channelId: string | null,
  channelName: string | null,
  updatedBy?: string
): Promise<void> {
  await setSetting<EscalationChannelSetting>(
    SETTING_KEYS.ESCALATION_SLACK_CHANNEL,
    { channel_id: channelId, channel_name: channelName },
    updatedBy
  );
}

// ============== Admin Channel Operations ==============

/**
 * Get the configured admin notification Slack channel
 */
export async function getAdminChannel(): Promise<AdminChannelSetting> {
  const result = await getSetting<AdminChannelSetting>(SETTING_KEYS.ADMIN_SLACK_CHANNEL);
  return result ?? { channel_id: null, channel_name: null };
}

/**
 * Set the admin notification Slack channel
 */
export async function setAdminChannel(
  channelId: string | null,
  channelName: string | null,
  updatedBy?: string
): Promise<void> {
  await setSetting<AdminChannelSetting>(
    SETTING_KEYS.ADMIN_SLACK_CHANNEL,
    { channel_id: channelId, channel_name: channelName },
    updatedBy
  );
}

// ============== Prospect Channel Operations ==============

/**
 * Get the configured prospect notification Slack channel
 */
export async function getProspectChannel(): Promise<ProspectChannelSetting> {
  const result = await getSetting<ProspectChannelSetting>(SETTING_KEYS.PROSPECT_SLACK_CHANNEL);
  return result ?? { channel_id: null, channel_name: null };
}

/**
 * Set the prospect notification Slack channel
 */
export async function setProspectChannel(
  channelId: string | null,
  channelName: string | null,
  updatedBy?: string
): Promise<void> {
  await setSetting<ProspectChannelSetting>(
    SETTING_KEYS.PROSPECT_SLACK_CHANNEL,
    { channel_id: channelId, channel_name: channelName },
    updatedBy
  );
}

// ============== Prospect Triage Toggle ==============

/**
 * Check if automatic prospect triage is enabled (defaults to true)
 */
export async function getProspectTriageEnabled(): Promise<boolean> {
  const result = await getSetting<{ enabled: boolean }>(SETTING_KEYS.PROSPECT_TRIAGE_ENABLED);
  return result?.enabled ?? true;
}

/**
 * Enable or disable automatic prospect triage
 */
export async function setProspectTriageEnabled(
  enabled: boolean,
  updatedBy?: string
): Promise<void> {
  await setSetting<{ enabled: boolean }>(
    SETTING_KEYS.PROSPECT_TRIAGE_ENABLED,
    { enabled },
    updatedBy
  );
}

// ============== Error Channel Operations ==============

/**
 * Get the configured error notification Slack channel
 */
export async function getErrorChannel(): Promise<ErrorChannelSetting> {
  const result = await getSetting<ErrorChannelSetting>(SETTING_KEYS.ERROR_SLACK_CHANNEL);
  return result ?? { channel_id: null, channel_name: null };
}

/**
 * Set the error notification Slack channel
 */
export async function setErrorChannel(
  channelId: string | null,
  channelName: string | null,
  updatedBy?: string
): Promise<void> {
  await setSetting<ErrorChannelSetting>(
    SETTING_KEYS.ERROR_SLACK_CHANNEL,
    { channel_id: channelId, channel_name: channelName },
    updatedBy
  );
}

// ============== Editorial Channel Operations ==============

/**
 * Get the configured editorial review notification Slack channel.
 * Posts land here when content enters pending_review, giving reviewers
 * a central queue regardless of which committee the draft belongs to.
 */
export async function getEditorialChannel(): Promise<EditorialChannelSetting> {
  const result = await getSetting<EditorialChannelSetting>(SETTING_KEYS.EDITORIAL_SLACK_CHANNEL);
  return result ?? { channel_id: null, channel_name: null };
}

/**
 * Set the editorial review notification Slack channel
 */
export async function setEditorialChannel(
  channelId: string | null,
  channelName: string | null,
  updatedBy?: string
): Promise<void> {
  await setSetting<EditorialChannelSetting>(
    SETTING_KEYS.EDITORIAL_SLACK_CHANNEL,
    { channel_id: channelId, channel_name: channelName },
    updatedBy
  );
}

// ============== Announcement Channel Operations ==============

/**
 * Get the configured public announcement Slack channel. Approved member
 * welcome posts land here (e.g. `#all-agentic-ads`). Unlike the other
 * channels in this module, this one is intentionally *public* — the whole
 * point is broad visibility.
 */
export async function getAnnouncementChannel(): Promise<AnnouncementChannelSetting> {
  const result = await getSetting<AnnouncementChannelSetting>(
    SETTING_KEYS.ANNOUNCEMENT_SLACK_CHANNEL,
  );
  return result ?? { channel_id: null, channel_name: null };
}

/**
 * Set the public announcement Slack channel.
 */
export async function setAnnouncementChannel(
  channelId: string | null,
  channelName: string | null,
  updatedBy?: string
): Promise<void> {
  await setSetting<AnnouncementChannelSetting>(
    SETTING_KEYS.ANNOUNCEMENT_SLACK_CHANNEL,
    { channel_id: channelId, channel_name: channelName },
    updatedBy
  );
}

// ============== Photo Badge Toggle ==============

/**
 * Returns true when the admin has enabled automatic photo-badge application.
 * Defaults to false (OFF) — no production effect until explicitly enabled.
 */
export async function getAutoApplyAaoBadge(): Promise<boolean> {
  const result = await getSetting<boolean>(SETTING_KEYS.AUTO_APPLY_AAO_BADGE);
  return result ?? false;
}

export async function setAutoApplyAaoBadge(enabled: boolean, updatedBy?: string): Promise<void> {
  await setSetting<boolean>(SETTING_KEYS.AUTO_APPLY_AAO_BADGE, enabled, updatedBy);
}
