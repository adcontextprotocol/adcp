import type { DigestContent } from '../../db/digest-db.js';
import type { SlackBlock, SlackBlockMessage } from '../../slack/types.js';

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

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
): { html: string; text: string } {
  const viewInBrowserUrl = `${BASE_URL}/digest/${editionDate}`;
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

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">

    <!-- Industry Briefing -->
    ${content.news.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 16px;">Industry Briefing</h2>
    ${content.news.map((item) => `
    <div style="margin-bottom: 20px;">
      <h3 style="font-size: 15px; margin: 0 0 4px 0;">
        <a href="${escapeHtml(item.url)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(item.title)}</a>
      </h3>
      <p style="font-size: 14px; color: #555; margin: 4px 0;">${escapeHtml(item.summary)}</p>
      <p style="font-size: 13px; color: #1a1a2e; margin: 4px 0; font-style: italic;">Why it matters: ${escapeHtml(item.whyItMatters)}</p>
    </div>
    `).join('')}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
    ` : ''}

    <!-- Community Pulse -->
    ${content.newMembers.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">New Members</h2>
    <p style="font-size: 14px; color: #555;">
      Welcome to ${content.newMembers.map((m) => `<strong>${escapeHtml(m.name)}</strong>`).join(', ')}
      who joined this week.
    </p>
    ` : ''}

    ${content.conversations.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">Notable Conversations</h2>
    ${content.conversations.map((conv) => `
    <div style="margin-bottom: 16px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
      <p style="font-size: 14px; color: #333; margin: 0 0 6px 0;">${escapeHtml(conv.summary)}</p>
      <p style="font-size: 13px; color: #666; margin: 0;">
        in <strong>${escapeHtml(conv.channelName)}</strong>
        ${segment !== 'website_only' ? ` &middot; <a href="${escapeHtml(conv.threadUrl)}" style="color: #2563eb;">Join the conversation</a>` : ''}
      </p>
    </div>
    `).join('')}
    ` : ''}

    ${content.workingGroups.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">Working Group Updates</h2>
    ${content.workingGroups.map((wg) => `
    <div style="margin-bottom: 12px;">
      <p style="font-size: 14px; margin: 0;">
        <strong>${escapeHtml(wg.name)}</strong>: ${escapeHtml(wg.summary.slice(0, 150))}
        ${wg.nextMeeting ? `<br><span style="font-size: 13px; color: #666;">Next: ${escapeHtml(wg.nextMeeting)}</span>` : ''}
      </p>
    </div>
    `).join('')}
    ` : ''}

    ${renderFoundingDeadlineBannerHtml()}

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">

    <!-- Segment-specific CTA -->
    ${renderCta(segment)}

    <!-- Feedback -->
    <p style="font-size: 13px; color: #888; text-align: center; margin-top: 30px;">
      Was this useful?
      <a href="${BASE_URL}/digest/${editionDate}/feedback?vote=yes&t=${trackingId}" style="text-decoration: none; font-size: 16px;">&#128077;</a>
      <a href="${BASE_URL}/digest/${editionDate}/feedback?vote=no&t=${trackingId}" style="text-decoration: none; font-size: 16px;">&#128078;</a>
    </p>
  </div>`.trim();

  const text = renderDigestText(content, editionDate, segment, firstName);

  return { html, text };
}

function renderCta(segment: DigestSegment): string {
  switch (segment) {
    case 'website_only':
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 8px 0;">
          Join 1,400+ members discussing agentic advertising in Slack
        </p>
        <a href="${BASE_URL}/slack" style="display: inline-block; padding: 10px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
          Join the conversation
        </a>
      </div>`;
    case 'slack_only':
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 8px 0;">
          Get listed in the member directory and access your full profile
        </p>
        <a href="${BASE_URL}/signup" style="display: inline-block; padding: 10px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
          Create your account
        </a>
      </div>`;
    case 'both':
    case 'active':
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0;">
          Know someone who should be part of this community?
          <a href="${BASE_URL}/invite" style="color: #2563eb;">Invite a colleague</a>
        </p>
      </div>`;
  }
}

function renderDigestText(content: DigestContent, editionDate: string, segment: DigestSegment, firstName?: string): string {
  const lines: string[] = [
    `AgenticAdvertising.org Weekly - ${formatDate(editionDate)}`,
    '',
  ];
  if (firstName) lines.push(`Hi ${firstName},`, '');
  lines.push(content.intro, '');

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

  if (content.workingGroups.length > 0) {
    lines.push('--- WORKING GROUP UPDATES ---', '');
    for (const wg of content.workingGroups) {
      lines.push(`* ${wg.name}: ${wg.summary.slice(0, 150)}`);
      if (wg.nextMeeting) lines.push(`  Next: ${wg.nextMeeting}`);
      lines.push('');
    }
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

  // Top news headlines
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

  // Community summary
  const communityParts: string[] = [];
  if (content.newMembers.length > 0) {
    communityParts.push(`${content.newMembers.length} new member${content.newMembers.length > 1 ? 's' : ''} joined this week`);
  }
  if (content.conversations.length > 0) {
    communityParts.push(`${content.conversations.length} notable conversation${content.conversations.length > 1 ? 's' : ''}`);
  }
  if (content.workingGroups.length > 0) {
    communityParts.push(`${content.workingGroups.length} working group update${content.workingGroups.length > 1 ? 's' : ''}`);
  }

  if (communityParts.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Community Pulse*\n${communityParts.join(' · ')}` },
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
      text: `*Weekly Digest Draft for ${formatDate(editionDate)}*\nReact with :white_check_mark: to approve for Tuesday 10am ET delivery. Reply in thread with any edits.`,
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

const FOUNDING_DEADLINE = new Date('2026-04-01T00:00:00Z');

function getFoundingDaysRemaining(): number | null {
  const days = Math.ceil((FOUNDING_DEADLINE.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return days > 0 ? days : null;
}

function renderFoundingDeadlineBannerHtml(): string {
  const days = getFoundingDaysRemaining();
  if (days === null) return '';

  const headline = days <= 7
    ? `Founding member enrollment closes in ${days} day${days === 1 ? '' : 's'}`
    : 'Founding member enrollment closes March 31';

  return `
    <div style="text-align: center; padding: 20px; background: #fef9e7; border: 1px solid #f0d060; border-radius: 8px; margin: 24px 0;">
      <p style="font-size: 16px; color: #1a1a2e; margin: 0 0 8px 0; font-weight: 600;">
        ${headline}
      </p>
      <p style="font-size: 14px; color: #555; margin: 0 0 12px 0;">
        Lock in current pricing permanently. After March 31, membership rates increase.
      </p>
      <a href="${BASE_URL}/join" style="display: inline-block; padding: 10px 24px; background: #1a1a2e; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
        Join as a founding member
      </a>
    </div>`;
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
