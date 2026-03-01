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

// ============== Setting Keys ==============

export const SETTING_KEYS = {
  BILLING_SLACK_CHANNEL: 'billing_slack_channel',
  ESCALATION_SLACK_CHANNEL: 'escalation_slack_channel',
  ADMIN_SLACK_CHANNEL: 'admin_slack_channel',
  PROSPECT_SLACK_CHANNEL: 'prospect_slack_channel',
  PROSPECT_TRIAGE_ENABLED: 'prospect_triage_enabled',
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
 * Set a setting value
 */
export async function setSetting<T>(
  key: string,
  value: T,
  updatedBy?: string
): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (key)
     DO UPDATE SET value = $2, updated_at = NOW(), updated_by = $3`,
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
