/**
 * Daily audit of the six admin-settings notification channels.
 *
 * #2735 added a send-time recheck (`sendChannelMessage` gates on
 * `verifyChannelStillPrivate`), so a channel that flipped private →
 * public stops receiving sensitive posts on the first send after the
 * drift. That's the hot path. The gap: channels that sit idle for
 * days aren't written to, so the drift sits undetected.
 *
 * This job runs once per day, checks each configured channel's
 * current privacy state against Slack, and emits structured warnings
 * on any confirmed drift. It also posts a summary to the
 * `admin_slack_channel` — unless that's the drifted one, in which
 * case the structured log is the only signal and log aggregation
 * alerting should pick it up. (Filed #2849 acceptance: "notifies a
 * human without using the drifted channel as the notification
 * surface.")
 *
 * This is non-destructive: we do NOT auto-null the setting. The
 * hot-path recheck already refuses to post sensitive content to a
 * drifted channel; enforcement is the send-time gate's job. This
 * audit is pure observability.
 */

import { createLogger } from '../../logger.js';
import {
  getBillingChannel,
  getEscalationChannel,
  getAdminChannel,
  getProspectChannel,
  getErrorChannel,
  getEditorialChannel,
} from '../../db/system-settings-db.js';
import {
  verifyChannelStillPrivate,
  sendChannelMessage,
  type ChannelPrivacyState,
} from '../../slack/client.js';

const logger = createLogger('channel-privacy-audit');

/**
 * One configured admin channel: the setting name (for log context)
 * and the channel id we'd post sensitive content to.
 */
interface AdminChannelConfig {
  settingName:
    | 'billing_slack_channel'
    | 'escalation_slack_channel'
    | 'admin_slack_channel'
    | 'prospect_slack_channel'
    | 'error_slack_channel'
    | 'editorial_slack_channel';
  channelId: string;
  channelName: string | null;
}

export interface ChannelPrivacyAuditResult {
  /** Number of configured channels we inspected. */
  checked: number;
  /** Channels that came back `'public'`. */
  drifted: Array<{ settingName: AdminChannelConfig['settingName']; channelId: string; channelName: string | null }>;
  /** Channels whose state could not be verified (transient Slack API failure, permission issues, etc.). */
  unknown: Array<{ settingName: AdminChannelConfig['settingName']; channelId: string }>;
  /** Whether we managed to post a summary to the admin channel (false when skipped for drift or when not configured). */
  summaryPosted: boolean;
}

async function gatherConfiguredChannels(): Promise<AdminChannelConfig[]> {
  const [billing, escalation, admin, prospect, error, editorial] = await Promise.all([
    getBillingChannel(),
    getEscalationChannel(),
    getAdminChannel(),
    getProspectChannel(),
    getErrorChannel(),
    getEditorialChannel(),
  ]);

  const configured: AdminChannelConfig[] = [];
  if (billing.channel_id) {
    configured.push({ settingName: 'billing_slack_channel', channelId: billing.channel_id, channelName: billing.channel_name });
  }
  if (escalation.channel_id) {
    configured.push({ settingName: 'escalation_slack_channel', channelId: escalation.channel_id, channelName: escalation.channel_name });
  }
  if (admin.channel_id) {
    configured.push({ settingName: 'admin_slack_channel', channelId: admin.channel_id, channelName: admin.channel_name });
  }
  if (prospect.channel_id) {
    configured.push({ settingName: 'prospect_slack_channel', channelId: prospect.channel_id, channelName: prospect.channel_name });
  }
  if (error.channel_id) {
    configured.push({ settingName: 'error_slack_channel', channelId: error.channel_id, channelName: error.channel_name });
  }
  if (editorial.channel_id) {
    configured.push({ settingName: 'editorial_slack_channel', channelId: editorial.channel_id, channelName: editorial.channel_name });
  }
  return configured;
}

/**
 * Run one audit pass across all six configured admin channels.
 * Returns a structured result so callers (tests, observability) can
 * assert on outcomes without parsing log output.
 */
export async function runChannelPrivacyAudit(): Promise<ChannelPrivacyAuditResult> {
  const configured = await gatherConfiguredChannels();

  const drifted: ChannelPrivacyAuditResult['drifted'] = [];
  const unknown: ChannelPrivacyAuditResult['unknown'] = [];

  // Check each in series — we want any rate-limit backoffs from the
  // Slack client to apply cleanly, and the volume is tiny (≤6).
  for (const cfg of configured) {
    let state: ChannelPrivacyState;
    try {
      state = await verifyChannelStillPrivate(cfg.channelId);
    } catch (err) {
      logger.warn(
        { err, settingName: cfg.settingName, channelId: cfg.channelId },
        'Channel privacy audit: verify threw',
      );
      state = 'unknown';
    }
    if (state === 'public') {
      drifted.push({ settingName: cfg.settingName, channelId: cfg.channelId, channelName: cfg.channelName });
    } else if (state === 'unknown') {
      unknown.push({ settingName: cfg.settingName, channelId: cfg.channelId });
    }
  }

  // Structured audit record. This is the source-of-truth alert — log
  // aggregation rules should key on `event: 'channel_privacy_drift_audit'`
  // so the drift surfaces even when the Slack summary can't be sent.
  logger.info(
    {
      event: 'channel_privacy_drift_audit',
      checked: configured.length,
      driftedCount: drifted.length,
      unknownCount: unknown.length,
      driftedSettings: drifted.map((d) => d.settingName),
      unknownSettings: unknown.map((u) => u.settingName),
    },
    `Channel privacy audit: ${configured.length} checked, ${drifted.length} drifted, ${unknown.length} unverifiable`,
  );

  // Post a summary to the admin channel — but only when:
  //   (a) it's configured, AND
  //   (b) the admin channel itself is NOT on the drifted list (posting
  //       sensitive content to a now-public channel is what this whole
  //       audit is trying to prevent).
  let summaryPosted = false;
  if (drifted.length > 0 || unknown.length > 0) {
    const adminSetting = configured.find((c) => c.settingName === 'admin_slack_channel');
    const adminDrifted = drifted.some((d) => d.settingName === 'admin_slack_channel');
    if (adminSetting && !adminDrifted) {
      const lines: string[] = [
        `:mag: *Channel privacy audit* — ${configured.length} channels checked`,
      ];
      if (drifted.length > 0) {
        lines.push('', `*Drifted to public* (posts blocked by send-time gate — admin action needed):`);
        for (const d of drifted) {
          lines.push(`• \`${d.settingName}\` → <#${d.channelId}|${d.channelName ?? d.channelId}>`);
        }
      }
      if (unknown.length > 0) {
        lines.push('', `*Unverifiable* (transient Slack error — may resolve on next run):`);
        for (const u of unknown) {
          lines.push(`• \`${u.settingName}\``);
        }
      }
      lines.push('', 'Re-privatize the listed channels or update the settings at /admin/settings.');
      const result = await sendChannelMessage(
        adminSetting.channelId,
        { text: lines.join('\n') },
        // 'strict-public-only': we already confirmed admin_slack_channel
        // itself is NOT drifted (checked above). If Slack returns
        // 'unknown' here, send anyway — the summary is the notification
        // and losing it silently would defeat the point of the audit.
        { requirePrivate: 'strict-public-only' },
      );
      summaryPosted = result.ok;
    }
  }

  return {
    checked: configured.length,
    drifted,
    unknown,
    summaryPosted,
  };
}
