/**
 * Slack notifications for registry wiki edits.
 *
 * Posts to the #registry-edits channel (configured via REGISTRY_EDITS_CHANNEL_ID).
 * Follows patterns from notifications/slack.ts.
 */

import { logger } from '../logger.js';
import { sendChannelMessage, isSlackConfigured } from '../slack/client.js';
import type { SlackBlockMessage } from '../slack/types.js';
import { isSafeSlackLinkTarget, sanitizeSlackLine, sanitizeSlackLinkLabel } from '../utils/slack-escape.js';

const CHANNEL_ID = process.env.REGISTRY_EDITS_CHANNEL_ID;
// KYC / signup-ops channel — falls back to the registry-edits channel
// when unset so the notification still fires in dev / staging without
// extra env wiring, but distinct in prod so the two audiences don't mix
// (wiki edits vs. signup KYC are different reviewer flows).
const SIGNUP_OPS_CHANNEL_ID = process.env.SIGNUP_OPS_CHANNEL_ID || CHANNEL_ID;
const APP_URL = process.env.APP_URL || 'https://agenticadvertising.org';

// Every submitter-, moderator-, or model-authored value in this file is
// flattened, capped and mrkdwn-escaped by the shared helpers in
// `utils/slack-escape.ts` before it reaches the registry channel — the room
// reads these messages as moderator-authored, which is what makes a planted
// `<!channel>` or `<https://evil|agenticadvertising.org>` effective
// (adcp#8320, #4754).

/** Identifiers and short names. */
const FIELD_MAX = 120;
/** Submitter- or model-authored free text (summaries, notes, reasons). */
const FREE_TEXT_MAX = 400;

function getChannelId(): string | null {
  if (!CHANNEL_ID) {
    logger.debug('REGISTRY_EDITS_CHANNEL_ID not configured, skipping registry notification');
    return null;
  }
  return CHANNEL_ID;
}

function getSignupOpsChannelId(): string | null {
  if (!SIGNUP_OPS_CHANNEL_ID) {
    logger.debug('SIGNUP_OPS_CHANNEL_ID / REGISTRY_EDITS_CHANNEL_ID not configured, skipping signup ops notification');
    return null;
  }
  return SIGNUP_OPS_CHANNEL_ID;
}

/**
 * Notify when a community member edits an existing registry record.
 * Returns the Slack message timestamp for threading.
 */
export async function notifyRegistryEdit(edit: {
  entity_type: 'brand' | 'property';
  domain: string;
  editor_email?: string;
  editor_name?: string;
  edit_summary: string;
  revision_number: number;
}): Promise<string | null> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return null;

  const emoji = edit.entity_type === 'brand' ? '🏷️' : '🌐';
  const typeLabel = edit.entity_type === 'brand' ? 'Brand' : 'Property';
  // `edit_summary` is free text from any member and `editor_name` is their
  // own display name; both land in the moderator channel (adcp#8320).
  const editorDisplay = sanitizeSlackLine(edit.editor_name || edit.editor_email || 'Unknown', FIELD_MAX);
  const domainLabel = sanitizeSlackLinkLabel(edit.domain, FIELD_MAX);
  const summary = sanitizeSlackLine(edit.edit_summary, FREE_TEXT_MAX);
  const viewUrl = edit.entity_type === 'brand'
    ? `${APP_URL}/brand/view/${encodeURIComponent(edit.domain)}`
    : `${APP_URL}/property/view/${encodeURIComponent(edit.domain)}`;

  const message: SlackBlockMessage = {
    text: `${emoji} ${typeLabel} edited: ${domainLabel} by ${editorDisplay}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${typeLabel} edited:* <${viewUrl}|${domainLabel}> (rev ${edit.revision_number})`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Editor:*\n${editorDisplay}` },
          { type: 'mrkdwn', text: `*Summary:*\n${summary}` },
        ],
      },
    ],
  };

  try {
    const result = await sendChannelMessage(channelId, message);
    return result.ts || null;
  } catch (error) {
    logger.error({ error, domain: edit.domain }, 'Failed to send registry edit notification');
    return null;
  }
}

/**
 * Notify ops when a new user signs up whose verified email domain
 * matches a brand in our registry — the KYC signal Brian flagged in
 * the brand-claim follow-up (#4744). At today's signup volume we
 * notify on every match regardless of brand verification state so ops
 * can watch the funnel; later we can threshold by signal value.
 *
 * Fire-and-forget at the call site — never block the webhook response.
 */
export async function notifyBrandClaimOpportunity(opportunity: {
  user_email: string;
  user_first_name?: string;
  user_last_name?: string;
  domain: string;
  brand_name?: string | null;
  brand_view_url: string;
  brand_already_verified: boolean;
  verified_owner_org_name?: string | null;
}): Promise<void> {
  const channelId = getSignupOpsChannelId();
  if (!channelId || !isSlackConfigured()) return;

  // All user-controlled fields are sanitized before interpolation —
  // first_name / last_name / email arrive from WorkOS signup
  // (user-supplied), brand_name and verified_owner_org_name flow from the
  // discovered-brands / organizations tables which can be populated by
  // external research. Without sanitization an attacker could plant
  // <!channel> mentions or <https://evil|legit-text> links into the
  // moderator-trusted channel (same threat as #4754).
  const display = sanitizeSlackLine(
    [opportunity.user_first_name, opportunity.user_last_name]
      .filter(Boolean)
      .join(' ')
      || opportunity.user_email,
    FIELD_MAX,
  );
  const emailSafe = sanitizeSlackLine(opportunity.user_email, FIELD_MAX);
  const domainSafe = sanitizeSlackLine(opportunity.domain, FIELD_MAX);
  const brandLabel = sanitizeSlackLinkLabel(
    opportunity.brand_name
      ? `${opportunity.brand_name} (${opportunity.domain})`
      : opportunity.domain,
    FIELD_MAX,
  );
  const ownerLabel = opportunity.verified_owner_org_name
    ? sanitizeSlackLine(opportunity.verified_owner_org_name, FIELD_MAX)
    : null;
  // The target half of a Slack link cannot be escaped, so an unexpected
  // shape drops the link rather than rendering a broken one.
  const brandViewUrl = `${APP_URL}${opportunity.brand_view_url}`;
  const brandViewLink = isSafeSlackLinkTarget(brandViewUrl)
    ? `<${brandViewUrl}|${brandLabel}>`
    : brandLabel;
  const statusLine = opportunity.brand_already_verified
    ? `_Brand is already verified-owned${ownerLabel ? ` by *${ownerLabel}*` : ''} — claim won't fire._`
    : `_Brand is unclaimed — signup will see a claim suggestion._`;

  const message: SlackBlockMessage = {
    text: `🪪 New signup matches brand: ${emailSafe} → ${domainSafe}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🪪 *New signup matches a registry brand* — ${brandViewLink}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*User:*\n${display}` },
          { type: 'mrkdwn', text: `*Email:*\n${emailSafe}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: statusLine },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: opportunity.domain }, 'Failed to send brand-claim opportunity notification');
  }
}

/**
 * Notify when a new record is created and pending Addie review.
 */
export async function notifyRegistryCreate(record: {
  entity_type: 'brand' | 'property';
  domain: string;
  editor_email?: string;
  editor_name?: string;
}): Promise<string | null> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return null;

  const emoji = record.entity_type === 'brand' ? '🏷️' : '🌐';
  const typeLabel = record.entity_type === 'brand' ? 'Brand' : 'Property';
  const editorDisplay = sanitizeSlackLine(record.editor_name || record.editor_email || 'Unknown', FIELD_MAX);
  const domain = sanitizeSlackLine(record.domain, FIELD_MAX);

  const message: SlackBlockMessage = {
    text: `${emoji} New ${typeLabel.toLowerCase()}: ${domain} by ${editorDisplay} - awaiting review`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *New ${typeLabel.toLowerCase()} record:* \`${domain}\`\n_Awaiting Addie review_`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Created by:*\n${editorDisplay}` },
        ],
      },
    ],
  };

  try {
    const result = await sendChannelMessage(channelId, message);
    return result.ts || null;
  } catch (error) {
    logger.error({ error, domain: record.domain }, 'Failed to send registry create notification');
    return null;
  }
}

/**
 * Notify when Addie approves a new record.
 */
export async function notifyRegistryApproval(record: {
  entity_type: 'brand' | 'property';
  domain: string;
  thread_ts?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const typeLabel = record.entity_type === 'brand' ? 'Brand' : 'Property';
  const domain = sanitizeSlackLine(record.domain, FIELD_MAX);

  const message: SlackBlockMessage = {
    text: `Approved: ${domain}`,
    thread_ts: record.thread_ts,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *${typeLabel} approved:* \`${domain}\` is now visible in the registry.`,
        },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: record.domain }, 'Failed to send registry approval notification');
  }
}

/**
 * Notify when a record is rolled back.
 */
export async function notifyRegistryRollback(rollback: {
  entity_type: 'brand' | 'property';
  domain: string;
  rolled_back_to: number;
  revision_number: number;
  rolled_back_by_name?: string;
  rolled_back_by_email?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const typeLabel = rollback.entity_type === 'brand' ? 'Brand' : 'Property';
  const editorDisplay = sanitizeSlackLine(rollback.rolled_back_by_name || rollback.rolled_back_by_email || 'Admin', FIELD_MAX);
  const domain = sanitizeSlackLine(rollback.domain, FIELD_MAX);

  const message: SlackBlockMessage = {
    text: `Rollback: ${domain} restored to rev ${rollback.rolled_back_to}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏪ *${typeLabel} rolled back:* \`${domain}\` restored to revision ${rollback.rolled_back_to} (now rev ${rollback.revision_number})`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*By:*\n${editorDisplay}` },
        ],
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: rollback.domain }, 'Failed to send registry rollback notification');
  }
}

/**
 * Notify moderators when a community logo upload queues for review.
 *
 * Fires from both the HTTP route and the Addie MCP tool whenever a logo
 * lands with `review_status='pending'`. Verified-owner uploads (auto-
 * approved) do NOT fire this — they're owner-attested and don't need a
 * second pair of eyes. Returns the message ts so future approval/rejection
 * notifications can thread off it.
 */
export async function notifyPendingBrandLogo(upload: {
  domain: string;
  logo_id: string;
  content_type: string;
  tags: string[];
  uploader_email?: string;
  uploader_name?: string;
  upload_note?: string;
  source: 'community' | 'addie';
}): Promise<string | null> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return null;

  const rawUploader = upload.source === 'addie'
    ? 'Addie (chat)'
    : (upload.uploader_name || upload.uploader_email || 'Unknown');
  const uploaderDisplay = sanitizeSlackLine(rawUploader, FIELD_MAX);
  const reviewUrl = `${APP_URL}/brand/view/${encodeURIComponent(upload.domain)}`;
  const domainLabel = sanitizeSlackLinkLabel(upload.domain, FIELD_MAX);
  // Tags and content type come off the community upload form too.
  const tagsLine = upload.tags.length ? sanitizeSlackLine(upload.tags.join(', '), FREE_TEXT_MAX) : '(none)';
  const contentType = sanitizeSlackLine(upload.content_type, 80);

  const fields = [
    { type: 'mrkdwn', text: `*Uploader:*\n${uploaderDisplay}` },
    { type: 'mrkdwn', text: `*Tags:*\n${tagsLine}` },
    { type: 'mrkdwn', text: `*Format:*\n${contentType}` },
  ] as const;

  const blocks: SlackBlockMessage['blocks'] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🖼️ *Logo pending review:* <${reviewUrl}|${domainLabel}>`,
      },
    },
    { type: 'section', fields: [...fields] },
  ];

  if (upload.upload_note) {
    // Truncate to keep the Slack block under the 3000-char text limit and
    // sanitize before interpolating — the note is uploader-controlled and
    // posted into a moderator-trusted channel.
    const note = sanitizeSlackLine(upload.upload_note, FREE_TEXT_MAX);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Note:*\n${note}` },
    });
  }

  const message: SlackBlockMessage = {
    text: `🖼️ Logo pending review: ${domainLabel} by ${uploaderDisplay}`,
    blocks,
  };

  try {
    const result = await sendChannelMessage(channelId, message);
    return result.ts || null;
  } catch (error) {
    logger.error({ error, domain: upload.domain, logoId: upload.logo_id }, 'Failed to send pending-logo notification');
    return null;
  }
}

/**
 * Notify (as a thread reply) when a moderator resolves a pending logo
 * upload. Threads off the original `notifyPendingBrandLogo` ts so the
 * channel reads as a conversation rather than a stream of disconnected
 * verdicts. Silently skips when `thread_ts` is missing — older uploads
 * predate the notify path and Slack-disabled environments never had a
 * parent message to thread off.
 */
export async function notifyBrandLogoReviewed(review: {
  thread_ts: string | null;
  domain: string;
  action: 'approve' | 'reject' | 'delete';
  reviewer_email?: string;
  reviewer_name?: string;
  note?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured() || !review.thread_ts) return;

  const verdictEmoji =
    review.action === 'approve' ? '✅' :
    review.action === 'reject' ? '❌' :
    '🗑️';
  const verdictLabel =
    review.action === 'approve' ? 'Approved' :
    review.action === 'reject' ? 'Rejected' :
    'Deleted';
  const reviewer = sanitizeSlackLine(review.reviewer_name || review.reviewer_email || 'Moderator', FIELD_MAX);
  const note = review.note ? sanitizeSlackLine(review.note, FREE_TEXT_MAX) : '';
  const noteSuffix = note ? `\n_${note}_` : '';

  const message: SlackBlockMessage = {
    text: `${verdictEmoji} ${verdictLabel} by ${reviewer}`,
    thread_ts: review.thread_ts,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${verdictEmoji} *${verdictLabel}* by ${reviewer}${noteSuffix}`,
        },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: review.domain }, 'Failed to send logo-review thread reply');
  }
}

/** Notify registry reviewers that a community mirror is awaiting review. */
export async function notifyPendingCommunityMirrorProposal(proposal: {
  proposal_id: string;
  platform: string;
  proposer_email?: string;
  organization_id?: string;
  catalog_item_count: number;
}): Promise<string | null> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return null;

  const proposer = sanitizeSlackLine(
    proposal.proposer_email || proposal.organization_id || 'Authenticated organization',
    FIELD_MAX,
  );
  const platform = sanitizeSlackLine(proposal.platform, FIELD_MAX);
  const reviewUrl = `${APP_URL}/admin/community-mirrors`;
  const message: SlackBlockMessage = {
    text: `Community mirror pending review: ${platform}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🗂️ *Community mirror pending review:* <${reviewUrl}|${platform}>`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Submitted by:*\n${proposer}` },
          { type: 'mrkdwn', text: `*Catalog items:*\n${proposal.catalog_item_count}` },
        ],
      },
    ],
  };

  try {
    const result = await sendChannelMessage(channelId, message);
    return result.ts || null;
  } catch (error) {
    logger.error(
      { error, proposalId: proposal.proposal_id, platform: proposal.platform },
      'Failed to send pending community-mirror notification',
    );
    return null;
  }
}

/** Reply to the proposal's Slack thread after a moderator decision. */
export async function notifyCommunityMirrorProposalReviewed(review: {
  thread_ts: string | null;
  platform: string;
  action: 'approve' | 'reject';
  reviewer_email?: string;
  reviewer_name?: string;
  note?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured() || !review.thread_ts) return;

  const approved = review.action === 'approve';
  const label = approved ? 'Approved and published' : 'Rejected';
  const reviewer = sanitizeSlackLine(review.reviewer_name || review.reviewer_email || 'Moderator', FIELD_MAX);
  const note = review.note ? `\n_${sanitizeSlackLine(review.note, FREE_TEXT_MAX)}_` : '';
  try {
    await sendChannelMessage(channelId, {
      text: `${label} by ${reviewer}`,
      thread_ts: review.thread_ts,
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${approved ? '✅' : '❌'} *${label}* by ${reviewer}${note}`,
        },
      }],
    });
  } catch (error) {
    logger.error(
      { error, platform: review.platform },
      'Failed to send community-mirror review thread reply',
    );
  }
}

/**
 * Notify when a user is banned from editing.
 */
export async function notifyRegistryBan(ban: {
  entity_type: 'brand' | 'property';
  banned_email?: string;
  entity_domain?: string;
  reason: string;
  banned_by_email?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const scope = ban.entity_domain
    ? `\`${sanitizeSlackLine(ban.entity_domain, FIELD_MAX)}\``
    : `all ${ban.entity_type}s`;
  const bannedUser = sanitizeSlackLine(ban.banned_email || 'User', FIELD_MAX);
  const bannedBy = sanitizeSlackLine(ban.banned_by_email || 'System', FIELD_MAX);
  // `reason` reaches here as `Auto-ban: ${modelReason}` from the Addie
  // review, so it is model output derived from submitter text.
  const reason = sanitizeSlackLine(ban.reason, FREE_TEXT_MAX);

  const message: SlackBlockMessage = {
    text: `Edit ban: ${bannedUser} banned from editing ${scope}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚫 *Edit ban:* ${bannedUser} banned from editing ${scope}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Reason:*\n${reason}` },
          { type: 'mrkdwn', text: `*By:*\n${bannedBy}` },
        ],
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error }, 'Failed to send registry ban notification');
  }
}

/**
 * Post Addie's review assessment as a thread reply.
 */
export async function notifyAddieReview(review: {
  /**
   * Absent when the submission never got a card to thread onto — the
   * property-enhancement path never opens one, and an unconfigured or
   * failed create-notification drops it. The verdict then posts to the
   * channel on its own, because the alternative is a locked `pending`
   * record nobody is told about (adcp#8326).
   */
  thread_ts?: string;
  /**
   * `needs_human_review` is the fail-safe outcome: the automated review
   * produced no verdict it trusts, so nothing was approved, reverted, or
   * banned and the record is waiting on a moderator (adcp#8326).
   */
  verdict: 'ok' | 'suspicious' | 'malicious' | 'needs_human_review';
  reason: string;
  domain: string;
  action_taken?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const verdictEmoji = review.verdict === 'ok' ? '✅'
    : review.verdict === 'suspicious' ? '⚠️'
    : review.verdict === 'needs_human_review' ? '🙋'
    : '🚨';

  const verdictLabel = review.verdict === 'ok' ? 'Looks good'
    : review.verdict === 'suspicious' ? 'Suspicious'
    : review.verdict === 'needs_human_review' ? 'Needs human review'
    : 'Malicious';

  // `reason` is model output, and the review prompt embeds the submitter's
  // own edit summary — so treat it as submitter-influenced free text, not
  // as platform copy (adcp#8320).
  const reason = sanitizeSlackLine(review.reason, FREE_TEXT_MAX);
  const domainLabel = sanitizeSlackLine(review.domain, FIELD_MAX);
  // Unthreaded, the message has to carry the domain itself — there is no
  // parent card above it saying which record this is about.
  const subject = review.thread_ts ? '' : ` ${domainLabel}:`;
  let text = `${verdictEmoji} *Addie review (${verdictLabel}):*${subject} ${reason}`;
  if (review.action_taken) {
    text += `\n_Action: ${sanitizeSlackLine(review.action_taken, FREE_TEXT_MAX)}_`;
  }

  const message: SlackBlockMessage = {
    text: `Addie review: ${verdictLabel} - ${domainLabel}`,
    ...(review.thread_ts ? { thread_ts: review.thread_ts } : {}),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: review.domain }, 'Failed to send Addie review notification');
  }
}

/**
 * Notify the moderator channel that a human closed a queued registry
 * review (adcp#8338).
 *
 * The channel was the only queue before the admin view existed, so a
 * decision taken in the UI has to land back in the room — otherwise two
 * moderators work the same card. The moderator's own identity is the one
 * platform-authored thing here; everything else (domain, note) is
 * member- or moderator-typed free text and goes through the helpers.
 */
export async function notifyRegistryReviewResolved(resolution: {
  entity_type: 'brand' | 'property';
  domain: string;
  /** What the moderator did, not what they set out to do. */
  action: 'approved' | 'rejected' | 'reverted';
  moderator_email?: string;
  moderator_name?: string;
  /** For a revert: the revision that was restored (adcp#8337). */
  restored_revision?: number;
  note?: string;
}): Promise<void> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return;

  const typeLabel = resolution.entity_type === 'brand' ? 'Brand' : 'Property';
  const domainLabel = sanitizeSlackLine(resolution.domain, FIELD_MAX);
  const moderator = sanitizeSlackLine(
    resolution.moderator_name || resolution.moderator_email || 'Admin',
    FIELD_MAX,
  );

  const emoji = resolution.action === 'approved' ? '✅'
    : resolution.action === 'rejected' ? '🗑️'
    : '⏪';
  const verb = resolution.action === 'approved' ? 'approved'
    : resolution.action === 'rejected' ? 'rejected and removed'
    : Number.isInteger(resolution.restored_revision)
      ? `reverted to revision ${resolution.restored_revision}`
      : 'reverted';

  const lines = [
    `${emoji} *${typeLabel} ${verb} from the review queue:* \`${domainLabel}\``,
    `_By ${moderator}_`,
  ];
  if (resolution.note) {
    lines.push(`_Note: ${sanitizeSlackLine(resolution.note, FREE_TEXT_MAX)}_`);
  }

  const message: SlackBlockMessage = {
    text: `Registry review resolved: ${domainLabel}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      },
    ],
  };

  try {
    await sendChannelMessage(channelId, message);
  } catch (error) {
    logger.error({ error, domain: resolution.domain }, 'Failed to send registry review resolution notification');
  }
}

/**
 * Daily backlog signal for the moderator channel (adcp#8338).
 *
 * Since #8337 an inconclusive automated review leaves the submission
 * waiting rather than publishing it, so an Anthropic outage or a missing
 * `ANTHROPIC_API_KEY` builds a backlog. Count and oldest age are the two
 * numbers that make that visible before a member notices their record
 * never appeared.
 *
 * Every value here is platform-computed — counts, ages, a fixed link — so
 * there is nothing submitter-authored in the message at all. Keep it that
 * way: the per-record detail belongs on the admin page, not in a line the
 * room reads as ours.
 */
export async function notifyRegistryReviewBacklog(backlog: {
  total: number;
  pending_records: number;
  flagged_edits: number;
  oldest_age_hours: number | null;
}): Promise<boolean> {
  const channelId = getChannelId();
  if (!channelId || !isSlackConfigured()) return false;

  const oldest = backlog.oldest_age_hours === null
    ? 'unknown'
    : backlog.oldest_age_hours < 48
      ? `${Math.round(backlog.oldest_age_hours)}h`
      : `${Math.round(backlog.oldest_age_hours / 24)}d`;

  const headline = `${backlog.total} registry submission${backlog.total === 1 ? '' : 's'} waiting on a moderator`;
  const lines = [
    `🙋 *${headline}*`,
    `• ${backlog.pending_records} pending record${backlog.pending_records === 1 ? '' : 's'} (not visible in the registry until approved)`,
    `• ${backlog.flagged_edits} live edit${backlog.flagged_edits === 1 ? '' : 's'} flagged for a human`,
    `• Oldest has waited *${oldest}*`,
    '',
    `<${APP_URL}/admin/registry-review|Open the review queue>`,
  ];

  try {
    await sendChannelMessage(channelId, {
      text: headline,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: lines.join('\n') },
        },
      ],
    });
    return true;
  } catch (error) {
    logger.error({ error }, 'Failed to send registry review backlog digest');
    return false;
  }
}
