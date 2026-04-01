import type { DigestContent } from '../../db/digest-db.js';
import type { SlackBlock, SlackBlockMessage } from '../../slack/types.js';
import { FOUNDING_DEADLINE } from '../founding-deadline.js';
import { trackedUrl } from '../../notifications/email.js';
import { markdownToEmailHtmlInline } from '../../utils/markdown.js';

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';
const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL || 'https://agenticads.slack.com';

/**
 * Wrap a URL for email click tracking. Returns raw URL for web/preview renders.
 */
function trackLink(trackingId: string, linkTag: string, destinationUrl: string): string {
  if (trackingId === 'web' || trackingId === 'preview') return destinationUrl;
  return trackedUrl(trackingId, linkTag, destinationUrl);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export type DigestSegment = 'website_only' | 'slack_only' | 'both' | 'active';

/**
 * Render the weekly digest as email HTML + text.
 * The HTML is the inner content only - sendMarketingEmail wraps it in the outer shell + footer.
 */
export function renderDigestEmail(
  content: DigestContent,
  trackingId: string,
  editionDate: string,
  segment: DigestSegment,
  firstName?: string,
  userWorkingGroupNames?: string[],
): { html: string; text: string } {
  const t = (linkTag: string, url: string) => trackLink(trackingId, linkTag, url);
  const viewInBrowserUrl = t('view_browser', `${BASE_URL}/digest/${editionDate}`);
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : '';

  const html = `
  <div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${escapeHtml(content.intro)}
  </div>
  <div style="max-width: 560px; margin: 0 auto;">
    <!-- View in browser -->
    <p style="font-size: 12px; color: #888; text-align: center; margin-bottom: 24px;">
      <a href="${viewInBrowserUrl}" style="color: #888; text-decoration: underline;">View in browser</a>
    </p>

    <!-- Header -->
    <h1 style="font-size: 22px; color: #1a1a2e; margin-bottom: 4px;">AgenticAdvertising.org Weekly</h1>
    <p style="font-size: 14px; color: #666; margin-top: 0;">${formatDate(editionDate)}</p>

    ${greeting ? `<p style="font-size: 15px; color: #333; margin-bottom: 0;">${greeting}</p>` : ''}

    <!-- Intro -->
    <p style="font-size: 15px; color: #333; line-height: 1.6;">${escapeHtml(content.intro)}</p>

    ${content.editorsNote ? `
    <div style="margin: 20px 0; padding: 16px 20px; background: #f0f4ff; border-left: 4px solid #2563eb; border-radius: 0 6px 6px 0;">
      <p style="font-size: 15px; color: #1a1a2e; margin: 0; line-height: 1.6;">${escapeHtml(content.editorsNote)}</p>
    </div>
    ` : ''}

    ${content.spotlightAction ? `
    <div style="margin: 20px 0; padding: 16px 20px; background: #f0fdf4; border-left: 4px solid #047857; border-radius: 0 6px 6px 0;">
      <p style="font-size: 15px; color: #1a1a2e; margin: 0; line-height: 1.6;">
        ${escapeHtml(content.spotlightAction.text)}
        ${content.spotlightAction.linkUrl ? ` <a href="${t('spotlight_cta', content.spotlightAction.linkUrl)}" style="color: #047857; font-weight: 600;">${escapeHtml(content.spotlightAction.linkLabel || 'Learn more')}</a>` : ''}
      </p>
    </div>
    ` : ''}

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">

    <!-- Perspectives -->
    ${content.perspectives && content.perspectives.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">New Perspectives</h2>
    ${content.perspectives.map((p, i) => `
    <div style="margin-bottom: 16px; padding: 12px; background: ${p.contentOrigin === 'official' ? '#f0fdf4' : '#f8f9fa'}; border-radius: 6px;${p.contentOrigin === 'official' ? ' border-left: 4px solid #047857;' : ''}">
      <h3 style="font-size: 15px; margin: 0 0 4px 0;">
        <a href="${t(`perspective_${i}`, `${BASE_URL}/perspectives/${p.slug}`)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(p.title)}</a>
      </h3>
      <p style="font-size: 13px; color: #666; margin: 2px 0 6px 0;">by ${escapeHtml(p.authorName)}${p.contentOrigin === 'official' ? ' &middot; AAO Official' : ''}</p>
      ${p.excerpt ? `<p style="font-size: 14px; color: #555; margin: 4px 0;">${escapeHtml(p.excerpt.slice(0, 200))}${p.excerpt.length > 200 ? '...' : ''}</p>` : ''}
    </div>
    `).join('')}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
    ` : ''}

    <!-- Working Group Updates -->
    ${renderWorkingGroupsHtml(content.workingGroups, userWorkingGroupNames)}

    <!-- New Members -->
    ${content.newMembers.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">New Members</h2>
    <p style="font-size: 14px; color: #555;">
      Welcome to ${content.newMembers.map((m) => `<strong>${escapeHtml(m.name)}</strong>`).join(', ')}
      who joined this week.
    </p>
    ` : ''}

    <!-- Notable Conversations -->
    ${content.conversations.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">Notable Conversations</h2>
    ${content.conversations.map((conv, i) => `
    <div style="margin-bottom: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
      <p style="font-size: 14px; color: #333; margin: 0 0 6px 0;">${escapeHtml(conv.summary)}</p>
      <p style="font-size: 13px; color: #666; margin: 0;">
        in <strong>${escapeHtml(conv.channelName)}</strong>
        ${segment !== 'website_only' ? ` &middot; <a href="${t(`convo_${i}`, conv.threadUrl)}" style="color: #2563eb;">Join the conversation</a>` : ''}
      </p>
    </div>
    `).join('')}
    ` : ''}

    <!-- Industry Briefing -->
    ${content.news.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 16px;">Industry Briefing</h2>
    ${content.news.map((item, i) => `
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 15px; margin: 0 0 4px 0;">
        <a href="${t(`news_${i}`, item.url)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(item.title)}</a>
      </h3>
      <p style="font-size: 14px; color: #555; margin: 4px 0;">${escapeHtml(item.summary)}</p>
      <p style="font-size: 13px; color: #1a1a2e; margin: 4px 0; font-style: italic;">Why it matters: ${escapeHtml(item.whyItMatters)}</p>
    </div>
    `).join('')}
    ` : ''}

    ${content.socialPostIdeas && content.socialPostIdeas.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">Ready to share</h2>
    <p style="font-size: 14px; color: #555; margin-bottom: 16px;">
      Grab ready-to-post social copy for these stories in <a href="${t('social_channel', `${SLACK_WORKSPACE_URL}/channels/social-post-ideas`)}" style="color: #2563eb;">#social-post-ideas</a>:
    </p>
    ${content.socialPostIdeas.map((idea, i) => `
    <div style="margin-bottom: 12px;">
      <p style="font-size: 14px; margin: 0;">
        <a href="${t(`social_${i}`, idea.url)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(idea.title)}</a>
        <br><span style="font-size: 13px; color: #666;">${escapeHtml(idea.description.slice(0, 150))}</span>
      </p>
    </div>
    `).join('')}
    <p style="font-size: 13px; color: #666; margin-top: 8px;">
      Want a version tailored to your company? Ask Addie in Slack or <a href="${t('cta_chat', `${BASE_URL}/chat`)}" style="color: #2563eb;">web chat</a>.
    </p>
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
    ` : ''}

    <!-- CTA (founding member merged with segment CTA when deadline active) -->
    ${renderCta(segment, trackingId)}

    <!-- Feedback -->
    <p style="font-size: 13px; color: #888; text-align: center; margin-top: 30px;">
      Was this useful?
      <a href="${t('feedback_yes', `${BASE_URL}/digest/${editionDate}/feedback?vote=yes&t=${trackingId}`)}" style="text-decoration: none; font-size: 16px;">&#128077;</a>
      <a href="${t('feedback_no', `${BASE_URL}/digest/${editionDate}/feedback?vote=no&t=${trackingId}`)}" style="text-decoration: none; font-size: 16px;">&#128078;</a>
    </p>
  </div>`.trim();

  const text = renderDigestText(content, editionDate, segment, firstName);

  return { html, text };
}

/**
 * Render the working groups section with personalization.
 * User's groups are sorted first and highlighted with a blue left border.
 */
function renderWorkingGroupsHtml(
  workingGroups: DigestContent['workingGroups'],
  userWorkingGroupNames?: string[],
): string {
  if (workingGroups.length === 0) return '';

  const userWGs = new Set(userWorkingGroupNames || []);
  const sorted = userWGs.size > 0
    ? [...workingGroups].sort((a, b) => {
        const aMatch = userWGs.has(a.name) ? 1 : 0;
        const bMatch = userWGs.has(b.name) ? 1 : 0;
        return bMatch - aMatch || a.name.localeCompare(b.name);
      })
    : workingGroups;

  const items = sorted.map((wg) => {
    const isMember = userWGs.has(wg.name);
    return `
    <div style="margin-bottom: 12px;${isMember ? ' border-left: 3px solid #2563eb; padding-left: 12px;' : ''}">
      <p style="font-size: 14px; margin: 0;">
        <strong>${escapeHtml(wg.name)}</strong>: ${markdownToEmailHtmlInline(wg.summary.slice(0, 150))}
        ${wg.nextMeeting ? `<br><span style="font-size: 13px; color: #666;">Next: ${escapeHtml(wg.nextMeeting)}</span>` : ''}
      </p>
    </div>`;
  }).join('');

  return `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">Working Group Updates</h2>
    ${items}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">`;
}

function renderCta(segment: DigestSegment, trackingId: string): string {
  const t = (tag: string, url: string) => trackLink(trackingId, tag, url);
  // If founding deadline is active, merge it into the CTA
  const foundingDays = getFoundingDaysRemaining();
  if (foundingDays !== null) {
    return renderFoundingCtaHtml(segment, t, foundingDays);
  }

  switch (segment) {
    case 'website_only':
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 8px 0;">
          Join 1,400+ members discussing agentic advertising in Slack
        </p>
        <a href="${t('cta_slack_join', `${BASE_URL}/slack`)}" style="display: inline-block; padding: 10px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
          Join the conversation
        </a>
      </div>`;
    case 'slack_only':
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 8px 0;">
          Get listed in the member directory and access your full profile
        </p>
        <a href="${t('cta_signup', `${BASE_URL}/signup`)}" style="display: inline-block; padding: 10px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
          Create your account
        </a>
      </div>`;
    case 'both':
    case 'active':
    default:
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0;">
          Know someone who should be part of this community?
          <a href="${t('cta_invite', `${BASE_URL}/invite`)}" style="color: #2563eb;">Invite a colleague</a>
        </p>
      </div>`;
  }
}

/**
 * Merged founding member + segment CTA. One ask per email.
 */
function renderFoundingCtaHtml(
  segment: DigestSegment,
  t: (tag: string, url: string) => string,
  daysRemaining: number,
): string {
  const urgency = daysRemaining <= 7
    ? `Founding member enrollment closes in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`
    : 'Founding member enrollment closes March 31';

  const secondaryText = segment === 'website_only'
    ? 'Lock in current pricing and join 1,400+ members in Slack.'
    : segment === 'slack_only'
      ? 'Lock in current pricing and get listed in the member directory.'
      : 'Lock in current pricing permanently. After March 31, membership rates increase.';

  return `
    <div style="text-align: center; padding: 20px; background: #fef9e7; border: 1px solid #f0d060; border-radius: 8px;">
      <p style="font-size: 16px; color: #1a1a2e; margin: 0 0 8px 0; font-weight: 600;">
        ${urgency}
      </p>
      <p style="font-size: 14px; color: #555; margin: 0 0 12px 0;">
        ${secondaryText}
      </p>
      <a href="${t('cta_founding', `${BASE_URL}/join`)}" style="display: inline-block; padding: 10px 24px; background: #1a1a2e; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
        Join as a founding member
      </a>
    </div>`;
}

function renderDigestText(content: DigestContent, editionDate: string, segment: DigestSegment, firstName?: string): string {
  const lines: string[] = [
    `AgenticAdvertising.org Weekly - ${formatDate(editionDate)}`,
    '',
  ];
  if (firstName) lines.push(`Hi ${firstName},`, '');
  lines.push(content.intro, '');

  if (content.editorsNote) {
    lines.push(content.editorsNote, '');
  }

  if (content.spotlightAction) {
    lines.push(`>> ${content.spotlightAction.text}`, '');
  }

  if (content.workingGroups.length > 0) {
    lines.push('--- WORKING GROUP UPDATES ---', '');
    for (const wg of content.workingGroups) {
      lines.push(`* ${wg.name}: ${wg.summary.slice(0, 150)}`);
      if (wg.nextMeeting) lines.push(`  Next: ${wg.nextMeeting}`);
      lines.push('');
    }
  }

  if (content.newMembers.length > 0) {
    lines.push('--- NEW MEMBERS ---', '');
    lines.push(`Welcome to ${content.newMembers.map((m) => m.name).join(', ')} who joined this week.`);
    lines.push('');
  }

  if (content.conversations.length > 0) {
    lines.push('--- NOTABLE CONVERSATIONS ---', '');
    for (const conv of content.conversations) {
      lines.push(`* ${conv.summary}`);
      lines.push(`  in ${conv.channelName}`);
      if (segment !== 'website_only') {
        lines.push(`  ${conv.threadUrl}`);
      }
      lines.push('');
    }
  }

  if (content.news.length > 0) {
    lines.push('--- INDUSTRY BRIEFING ---', '');
    for (const item of content.news) {
      lines.push(`* ${item.title}`);
      lines.push(`  ${item.summary}`);
      lines.push(`  Why it matters: ${item.whyItMatters}`);
      lines.push(`  ${item.url}`);
      lines.push('');
    }
  }

  if (content.socialPostIdeas && content.socialPostIdeas.length > 0) {
    lines.push('--- READY TO SHARE ---', '');
    lines.push('Grab ready-to-post social copy in #social-post-ideas:');
    for (const idea of content.socialPostIdeas) {
      lines.push(`* ${idea.title}`);
      lines.push(`  ${idea.url}`);
      lines.push('');
    }
    lines.push('Want a version tailored to your company? Ask Addie in Slack or web chat.', '');
  }

  const deadlineBannerText = renderFoundingDeadlineBannerText();
  if (deadlineBannerText) {
    lines.push('---', '', deadlineBannerText, '');
  }

  lines.push(`View in browser: ${BASE_URL}/digest/${editionDate}`);

  return lines.join('\n');
}

/**
 * Render the digest as a Slack Block Kit message (concise summary with link)
 */
export function renderDigestSlack(content: DigestContent, editionDate: string): SlackBlockMessage {
  const webUrl = `${BASE_URL}/digest/${editionDate}`;
  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `Weekly Digest - ${formatDate(editionDate)}` },
  });

  // Intro
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: escapeSlackMrkdwn(content.intro) },
  });

  // Editor's note
  if (content.editorsNote) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: escapeSlackMrkdwn(content.editorsNote).split('\n').map((line) => `> ${line}`).join('\n') },
    });
  }

  // Spotlight action
  if (content.spotlightAction) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `:point_right: ${escapeSlackMrkdwn(content.spotlightAction.text)}` },
    });
  }

  // Working group updates
  if (content.workingGroups.length > 0) {
    const wgText = content.workingGroups
      .map((wg) => {
        const meeting = wg.nextMeeting ? `\n>    _Next: ${escapeSlackMrkdwn(wg.nextMeeting)}_` : '';
        return `> *${escapeSlackMrkdwn(wg.name)}*: ${escapeSlackMrkdwn(wg.summary.slice(0, 150))}${meeting}`;
      })
      .join('\n\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Working Group Updates*\n\n${wgText}` },
    });
  }

  // Community summary
  const communityParts: string[] = [];
  if (content.newMembers.length > 0) {
    communityParts.push(`${content.newMembers.length} new member${content.newMembers.length > 1 ? 's' : ''} joined this week`);
  }
  if (content.conversations.length > 0) {
    communityParts.push(`${content.conversations.length} notable conversation${content.conversations.length > 1 ? 's' : ''}`);
  }

  if (communityParts.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Community Pulse*\n${communityParts.join(' · ')}` },
    });
  }

  // Industry briefing
  if (content.news.length > 0) {
    const newsText = content.news
      .map((item) => `> *<${item.url}|${escapeSlackMrkdwn(item.title)}>*\n> _${escapeSlackMrkdwn(item.whyItMatters)}_`)
      .join('\n\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Industry Briefing*\n\n${newsText}` },
    });
  }

  // Social post ideas
  if (content.socialPostIdeas && content.socialPostIdeas.length > 0) {
    const ideasText = content.socialPostIdeas
      .map((idea) => `> *<${idea.url}|${escapeSlackMrkdwn(idea.title)}>*`)
      .join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Ready to share*\nGrab social copy in #social-post-ideas:\n\n${ideasText}\n\n_Want a version tailored to your company? DM me._` },
    });
  }

  // Founding deadline banner
  const deadlineBannerSlack = renderFoundingDeadlineBannerSlack();
  if (deadlineBannerSlack) {
    blocks.push({ type: 'divider' });
    blocks.push(deadlineBannerSlack);
  }

  // Read more link
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `<${webUrl}|Read the full digest>` },
  });

  const fallbackText = `Weekly Digest - ${formatDate(editionDate)}: ${content.intro}`;

  return { text: fallbackText, blocks };
}

/**
 * Render the digest for the Slack review message in the Editorial channel
 */
export function renderDigestReview(content: DigestContent, editionDate: string): SlackBlockMessage {
  const slackMessage = renderDigestSlack(content, editionDate);
  const blocks: SlackBlock[] = slackMessage.blocks || [];

  // Prepend review instructions
  blocks.unshift({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Weekly Digest Draft for ${formatDate(editionDate)}*\n:white_check_mark: Approve for 10am ET delivery · :arrows_counterclockwise: Regenerate from scratch\nReply in thread to edit — e.g. "remove the first article", "editor's note: Don't miss our March town hall", or ask for any changes.`,
    },
  });
  blocks.splice(1, 0, { type: 'divider' });

  return {
    text: `Weekly Digest draft ready for review - ${formatDate(editionDate)}`,
    blocks,
  };
}

/**
 * Render the full web-viewable HTML page for a digest edition
 */
export function renderDigestWebPage(content: DigestContent, editionDate: string): string {
  // Reuse email renderer with a dummy tracking ID and "both" segment
  const { html: innerHtml } = renderDigestEmail(content, 'web', editionDate, 'both');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>AgenticAdvertising.org Weekly - ${formatDate(editionDate)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 640px;
      margin: 0 auto;
      padding: 40px 20px;
      background: #fafafa;
    }
    a { color: #2563eb; }
  </style>
</head>
<body>
  ${innerHtml}
  <p style="text-align: center; margin-top: 40px; font-size: 13px; color: #888;">
    <a href="${BASE_URL}" style="color: #888;">AgenticAdvertising.org</a>
  </p>
</body>
</html>`;
}

// ─── Founding member deadline banner (expires April 1 2026) ─────────────

function getFoundingDaysRemaining(): number | null {
  const days = Math.ceil((FOUNDING_DEADLINE.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return days > 0 ? days : null;
}

function renderFoundingDeadlineBannerSlack(): SlackBlock | null {
  const days = getFoundingDaysRemaining();
  if (days === null) return null;

  const headline = days <= 7
    ? `*Founding member enrollment closes in ${days} day${days === 1 ? '' : 's'}*`
    : '*Founding member enrollment closes March 31*';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `${headline} \u2014 lock in current pricing permanently. <${BASE_URL}/join|Join as a founding member>`,
    },
  };
}

function renderFoundingDeadlineBannerText(): string | null {
  const days = getFoundingDaysRemaining();
  if (days === null) return null;

  const headline = days <= 7
    ? `Founding member enrollment closes in ${days} day${days === 1 ? '' : 's'}.`
    : 'Founding member enrollment closes March 31.';

  return `${headline} Lock in current pricing permanently: ${BASE_URL}/join`;
}

function formatDate(editionDate: string): string {
  const date = new Date(editionDate + 'T12:00:00Z');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
