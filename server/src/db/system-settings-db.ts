/**
 * Database layer for system settings
 * Manages key-value configuration for application-wide settings
 */

import { ORGANIZATION_AUTHORIZATION_BOUNDARY_VALUES } from '../auth/organization-authorization-boundaries.js';
import { createLogger } from '../logger.js';
import { query } from './client.js';

const logger = createLogger('system-settings-db');
let ignoredFutureAuthorizationBoundaryWarningEmitted = false;
const ORGANIZATION_AUTHORIZATION_BOUNDARY_NAME_PATTERN = /^organization_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MAX_ORGANIZATION_AUTHORIZATION_BOUNDARY_NAME_LENGTH = 96;

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

export interface S2CanonicalFormatsDeltaReleaseSetting {
  adcp_3_1_ga_at: string | null;
  criteria_deployed_at: string | null;
}

export interface OrganizationAuthorizationEnforcementSetting {
  enabled: boolean;
  boundaries: string[];
}

export interface VerificationProfileShadowRolloutSetting {
  enabled: boolean;
  expires_at: string | null;
}

const VERIFICATION_PROFILE_SHADOW_ROLLOUT_TTL_HOURS = 72;
const VERIFICATION_PROFILE_SHADOW_AUTO_EXPIRY_ACTOR = 'system:verification-profile-shadow-auto-expiry';

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
  CERTIFICATION_S2_CANONICAL_FORMATS_DELTA_RELEASE: 'certification_s2_canonical_formats_delta_release',
  ORGANIZATION_AUTHORIZATION_ENFORCEMENT: 'organization_authorization_enforcement',
  VERIFICATION_PROFILE_SHADOW_ROLLOUT: 'verification_profile_shadow_rollout',
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

const DEFAULT_ORGANIZATION_AUTHORIZATION_ENFORCEMENT: OrganizationAuthorizationEnforcementSetting = {
  enabled: false,
  boundaries: [],
};

/**
 * Read the audited runtime gate for exact-credential organization
 * authorization. Absence is intentionally disabled. Malformed persisted
 * values throw so an environment-staged enforcement process can fail closed.
 * Well-formed boundary names introduced by a newer binary are ignored so this
 * reader remains a safe rollback floor for boundaries it cannot implement.
 */
export async function getOrganizationAuthorizationEnforcement(): Promise<OrganizationAuthorizationEnforcementSetting> {
  const setting = await getSetting<unknown>(SETTING_KEYS.ORGANIZATION_AUTHORIZATION_ENFORCEMENT);
  if (setting === null) {
    return {
      ...DEFAULT_ORGANIZATION_AUTHORIZATION_ENFORCEMENT,
      boundaries: [],
    };
  }
  if (
    typeof setting !== 'object' ||
    Array.isArray(setting) ||
    typeof (setting as { enabled?: unknown }).enabled !== 'boolean' ||
    !Array.isArray((setting as { boundaries?: unknown }).boundaries) ||
    !(setting as { boundaries: unknown[] }).boundaries.every((value) => typeof value === 'string')
  ) {
    throw new Error('Invalid organization authorization enforcement setting');
  }
  const enabled = (setting as { enabled: boolean }).enabled;
  const normalizedBoundaries = [...new Set(
    (setting as { boundaries: string[] }).boundaries.map((value) => value.trim()).filter(Boolean),
  )];
  if (enabled && normalizedBoundaries.length === 0) {
    throw new Error('Invalid organization authorization enforcement setting');
  }
  if (normalizedBoundaries.some((boundary) => (
    boundary.length > MAX_ORGANIZATION_AUTHORIZATION_BOUNDARY_NAME_LENGTH ||
    !ORGANIZATION_AUTHORIZATION_BOUNDARY_NAME_PATTERN.test(boundary)
  ))) {
    throw new Error('Invalid organization authorization enforcement setting');
  }
  const supportedBoundaries = new Set<string>(ORGANIZATION_AUTHORIZATION_BOUNDARY_VALUES);
  const boundaries = normalizedBoundaries.filter((boundary) => supportedBoundaries.has(boundary));
  const ignoredBoundaryCount = normalizedBoundaries.length - boundaries.length;
  if (ignoredBoundaryCount > 0 && !ignoredFutureAuthorizationBoundaryWarningEmitted) {
    ignoredFutureAuthorizationBoundaryWarningEmitted = true;
    logger.warn(
      { ignoredBoundaryCount },
      'Ignored organization authorization boundaries unsupported by this application version',
    );
  }
  return { enabled: enabled && boundaries.length > 0, boundaries };
}

export async function setOrganizationAuthorizationEnforcement(
  setting: OrganizationAuthorizationEnforcementSetting,
  updatedBy?: string,
): Promise<void> {
  const boundaries = [...new Set(setting.boundaries.map((value) => value.trim()).filter(Boolean))];
  const supportedBoundaries = new Set<string>(ORGANIZATION_AUTHORIZATION_BOUNDARY_VALUES);
  if (
    boundaries.some((boundary) => !supportedBoundaries.has(boundary)) ||
    (setting.enabled && boundaries.length === 0)
  ) {
    throw new Error('Invalid organization authorization enforcement setting');
  }
  await setSetting(
    SETTING_KEYS.ORGANIZATION_AUTHORIZATION_ENFORCEMENT,
    {
      enabled: setting.enabled,
      boundaries,
    },
    updatedBy,
  );
}

/**
 * Read the observation-only verification-profile collection switch. Missing or
 * malformed values are disabled so a rollback cannot accidentally collect.
 */
export async function getVerificationProfileShadowRollout(): Promise<VerificationProfileShadowRolloutSetting> {
  const result = await query<{ value: unknown }>(
    `WITH current_setting AS MATERIALIZED (
       SELECT value AS old_value
       FROM system_settings
       WHERE key = $1
       FOR UPDATE
     ),
     expired AS (
       UPDATE system_settings setting
       SET value = '{"enabled": false, "expires_at": null}'::jsonb,
           updated_at = NOW(),
           updated_by = $2
       FROM current_setting current
       WHERE setting.key = $1
         AND jsonb_typeof(current.old_value) = 'object'
         AND current.old_value->>'enabled' = 'true'
         AND CASE
           WHEN COALESCE(current.old_value->>'expires_at', '') ~
             '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{3})?Z$'
           THEN (current.old_value->>'expires_at')::timestamptz <= NOW()
           ELSE FALSE
         END
       RETURNING current.old_value, setting.value AS new_value
     ),
     audit AS (
       INSERT INTO system_settings_audit (
         key, old_value, new_value, changed_by, changed_at
       )
       SELECT $1, old_value, new_value, $2, NOW()
       FROM expired
     )
     SELECT new_value AS value FROM expired
     UNION ALL
     SELECT old_value AS value
     FROM current_setting
     WHERE NOT EXISTS (SELECT 1 FROM expired)`,
    [SETTING_KEYS.VERIFICATION_PROFILE_SHADOW_ROLLOUT, VERIFICATION_PROFILE_SHADOW_AUTO_EXPIRY_ACTOR],
  );
  const setting = result.rows[0]?.value ?? null;
  if (
    setting === null ||
    typeof setting !== 'object' ||
    Array.isArray(setting) ||
    Object.keys(setting).some((key) => key !== 'enabled' && key !== 'expires_at') ||
    typeof (setting as { enabled?: unknown }).enabled !== 'boolean' ||
    !(
      (setting as { expires_at?: unknown }).expires_at === null ||
      typeof (setting as { expires_at?: unknown }).expires_at === 'string'
    )
  ) {
    return { enabled: false, expires_at: null };
  }
  const enabled = (setting as { enabled: boolean }).enabled;
  const expiresAt = (setting as { expires_at: string | null }).expires_at;
  const parsedExpiry = expiresAt === null ? null : new Date(expiresAt);
  if (
    (enabled && (parsedExpiry === null || Number.isNaN(parsedExpiry.getTime()))) ||
    (!enabled && expiresAt !== null)
  ) {
    return { enabled: false, expires_at: null };
  }
  return { enabled, expires_at: enabled ? parsedExpiry!.toISOString() : null };
}

export async function setVerificationProfileShadowRollout(
  setting: Pick<VerificationProfileShadowRolloutSetting, 'enabled'>,
  updatedBy?: string,
): Promise<VerificationProfileShadowRolloutSetting> {
  const expiresAt = setting.enabled
    ? new Date(Date.now() + VERIFICATION_PROFILE_SHADOW_ROLLOUT_TTL_HOURS * 60 * 60 * 1_000).toISOString()
    : null;
  const persisted = { enabled: setting.enabled, expires_at: expiresAt };
  await setSetting(
    SETTING_KEYS.VERIFICATION_PROFILE_SHADOW_ROLLOUT,
    persisted,
    updatedBy,
  );
  return persisted;
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

// ============== Certification Protocol-Update Gates ==============

/**
 * Release gate for a protocol-triggered recertification delta. Keyed by the
 * delta's `release_setting_key` so the recertification engine can read any
 * module's gate, not just S2. An unset gate reads as "both dates unconfigured."
 */
export async function getDeltaRelease(key: string): Promise<S2CanonicalFormatsDeltaReleaseSetting> {
  const result = await getSetting<S2CanonicalFormatsDeltaReleaseSetting>(key);
  return result ?? { adcp_3_1_ga_at: null, criteria_deployed_at: null };
}

export async function setDeltaRelease(
  key: string,
  value: S2CanonicalFormatsDeltaReleaseSetting,
  updatedBy?: string,
): Promise<void> {
  await setSetting<S2CanonicalFormatsDeltaReleaseSetting>(key, value, updatedBy);
}

export async function getS2CanonicalFormatsDeltaRelease(): Promise<S2CanonicalFormatsDeltaReleaseSetting> {
  return getDeltaRelease(SETTING_KEYS.CERTIFICATION_S2_CANONICAL_FORMATS_DELTA_RELEASE);
}

export async function setS2CanonicalFormatsDeltaRelease(
  value: S2CanonicalFormatsDeltaReleaseSetting,
  updatedBy?: string
): Promise<void> {
  await setDeltaRelease(SETTING_KEYS.CERTIFICATION_S2_CANONICAL_FORMATS_DELTA_RELEASE, value, updatedBy);
}
