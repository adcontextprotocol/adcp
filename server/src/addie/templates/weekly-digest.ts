import type { DigestContent, DigestInsiderGroup, PersonaCluster, DigestEmailRecipient } from '../../db/digest-db.js';
import type { SlackBlock, SlackBlockMessage } from '../../slack/types.js';
import { trackedUrl } from '../../notifications/email.js';
import { pickNudge } from '../services/digest-nudge.js';
import DOMPurify from 'isomorphic-dompurify';


const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';
const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL || 'https://agenticads.slack.com';

function isHtml(text: string): boolean {
  return /<(?:p|div|br|strong|em|ul|ol|li|a\s)[>\s/]/i.test(text);
}

/** Add inline styles to TipTap HTML for email client rendering. */
function htmlToEmailHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
  });
  return clean
    .replace(/<a /g, '<a style="color: #2563eb; text-decoration: underline;" ')
    .replace(/<ul>/g, '<ul style="margin: 8px 0; padding-left: 20px;">')
    .replace(/<ol>/g, '<ol style="margin: 8px 0; padding-left: 20px;">')
    .replace(/<li>/g, '<li style="margin-bottom: 4px;">')
    .replace(/<p>/g, '<p style="margin: 0 0 8px 0;">');
}

/** Convert TipTap HTML to Slack mrkdwn using DOM traversal. */
function htmlToSlackMrkdwn(html: string): string {
  const dom = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href'],
    RETURN_DOM: true,
  }) as unknown as DocumentFragment;
  return domToSlackMrkdwn(dom).replace(/\n{3,}/g, '\n\n').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSDOM node from DOMPurify RETURN_DOM
function domToSlackMrkdwn(node: any): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const el = node;
  const tag = el.tagName?.toLowerCase();
  const inner = Array.from(el.childNodes).map(domToSlackMrkdwn).join('');
  switch (tag) {
    case 'br': return '\n';
    case 'p': return inner + '\n\n';
    case 'strong': case 'b': return `*${inner}*`;
    case 'em': case 'i': return `_${inner}_`;
    case 'a': { const href = el.getAttribute('href'); return href ? `<${href}|${inner}>` : inner; }
    case 'li': return `• ${inner}\n`;
    case 'ul': case 'ol': return inner;
    default: return inner;
  }
}

/** Convert TipTap HTML to plain text using DOM traversal. */
function htmlToPlainText(html: string): string {
  const dom = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'a', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href'],
    RETURN_DOM: true,
  }) as unknown as DocumentFragment;
  return domToPlainText(dom).replace(/\n{3,}/g, '\n\n').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSDOM node from DOMPurify RETURN_DOM
function domToPlainText(node: any): string {
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const el = node;
  const tag = el.tagName?.toLowerCase();
  const inner = Array.from(el.childNodes).map(domToPlainText).join('');
  switch (tag) {
    case 'br': return '\n';
    case 'p': return inner + '\n\n';
    case 'a': { const href = el.getAttribute('href'); return href && href !== inner ? `${inner} (${href})` : inner; }
    case 'li': return `- ${inner}\n`;
    case 'ul': case 'ol': return inner;
    default: return inner;
  }
}

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

/** Slack link pattern: <url|label> or <url> */
const SLACK_LINK_RE = /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g;

/**
 * Convert Slack-format links to HTML anchor tags, escaping all other content.
 */
function slackLinksToHtml(text: string): string {
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(SLACK_LINK_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(escapeHtml(text.slice(lastIndex, match.index)));
    }
    const url = match[1];
    const label = match[2] || url;
    parts.push(`<a href="${escapeHtml(url)}" style="color: #2563eb;">${escapeHtml(label)}</a>`);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(escapeHtml(text.slice(lastIndex)));
  }
  return parts.join('');
}

/**
 * Convert Slack-format links to plain text: <url|label> → "label (url)", <url> → url
 */
function slackLinksToPlainText(text: string): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1');
}

/**
 * Escape Slack mrkdwn special chars while preserving Slack-format links.
 */
function escapeSlackMrkdwnPreserveLinks(text: string): string {
  const parts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(SLACK_LINK_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(escapeSlackMrkdwn(text.slice(lastIndex, match.index)));
    }
    parts.push(match[0]);
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(escapeSlackMrkdwn(text.slice(lastIndex)));
  }
  return parts.join('');
}

export type DigestSegment = 'website_only' | 'slack_only' | 'both' | 'active';

// ─── Email HTML Rendering ───────────────────────────────────────────────

/**
 * Render The Prompt as email HTML + text.
 * The HTML is the inner content only — sendMarketingEmail wraps it in the outer shell + footer.
 */
export function renderDigestEmail(
  content: DigestContent,
  trackingId: string,
  editionDate: string,
  segment: DigestSegment,
  firstName?: string,
  userWorkingGroupNames?: string[],
  personaCluster?: PersonaCluster,
  recipient?: DigestEmailRecipient | null,
): { html: string; text: string } {
  const t = (linkTag: string, url: string) => trackLink(trackingId, linkTag, url);
  const viewInBrowserUrl = t('view_browser', `${BASE_URL}/perspectives/the-prompt-${editionDate}`);
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : '';

  const html = `
  <div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${escapeHtml(content.openingTake)}
  </div>
  <div style="max-width: 560px; margin: 0 auto;">
    <!-- View in browser -->
    <p style="font-size: 12px; color: #888; text-align: center; margin-bottom: 24px;">
      <a href="${viewInBrowserUrl}" style="color: #888; text-decoration: underline;">View in browser</a>
    </p>

    <!-- Header -->
    <h1 style="font-size: 22px; color: #1a1a2e; margin-bottom: 0;">The Prompt</h1>
    <p style="font-size: 14px; color: #666; margin-top: 4px;">from Addie &middot; ${formatDate(editionDate)}</p>

    ${greeting ? `<p style="font-size: 15px; color: #333; margin-bottom: 0;">${greeting}</p>` : ''}

    ${personaCluster === 'newcomer' && !greeting ? `
    <p style="font-size: 14px; color: #555; margin-bottom: 12px;">
      New here? The Prompt is your biweekly guide to what's happening in agentic advertising. Read the key updates, then browse Industry Intel for what's happening across the ecosystem.
    </p>
    ` : ''}

    <!-- Opening Take -->
    <p style="font-size: 15px; color: #333; line-height: 1.6;">${escapeHtml(content.openingTake)}</p>

    <!-- Personalized Nudge -->
    ${(() => {
      const nudge = recipient ? pickNudge(recipient) : null;
      if (!nudge) return '';
      return `
    <div style="margin: 16px 0; padding: 12px 16px; background: #f0f4ff; border-radius: 6px; display: flex; align-items: center; gap: 12px;">
      <p style="font-size: 14px; color: #1a1a2e; margin: 0; flex: 1;">${escapeHtml(nudge.text)}</p>
      <a href="${t('nudge', nudge.ctaUrl)}" style="display: inline-block; padding: 8px 16px; background: #2563eb; color: white; text-decoration: none; border-radius: 5px; font-size: 13px; font-weight: 600; white-space: nowrap;">${escapeHtml(nudge.ctaLabel)}</a>
    </div>`;
    })()}

    ${content.editorsNote ? `
    <div style="margin: 20px 0; padding: 16px 20px; background: #f0f4ff; border-left: 4px solid #2563eb; border-radius: 0 6px 6px 0;">
      <div style="font-size: 15px; color: #1a1a2e; margin: 0; line-height: 1.6;">${
        isHtml(content.editorsNote)
          ? htmlToEmailHtml(content.editorsNote)
          : slackLinksToHtml(content.editorsNote).replace(/\n/g, '<br>')
      }</div>
    </div>
    ` : ''}

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">

    <!-- This Edition (official AAO content — no section header, flows from opening take) -->
    ${(() => {
      const official = content.whatToWatch.filter((item) => item.tags?.includes('official'));
      const external = content.whatToWatch.filter((item) => !item.tags?.includes('official'));
      let html = '';
      if (official.length > 0) {
        html += official.map((item, i) => `
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 15px; margin: 0 0 4px 0;">
            <a href="${t(`edition_${i}`, item.url)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(item.title)}</a>
          </h3>
          <p style="font-size: 14px; color: #555; margin: 4px 0;">${escapeHtml(item.summary)}</p>
          ${item.takeaways && item.takeaways.length > 0 ? `
          <ul style="margin: 8px 0 4px 0; padding-left: 20px;">
            ${item.takeaways.map((tw) => `<li style="font-size: 14px; color: #333; margin-bottom: 6px; line-height: 1.5;">${escapeHtml(tw)}</li>`).join('')}
          </ul>
          ` : `
          <p style="font-size: 13px; color: #1a1a2e; margin: 4px 0; font-style: italic;">${escapeHtml(item.whyItMatters)}</p>
          `}
        </div>
        `).join('');
        html += '<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">';
      }
      if (external.length > 0) {
        html += `<h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 16px;">Industry intel</h2>`;
        html += external.map((item, i) => `
        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 15px; margin: 0 0 4px 0;">
            <a href="${t(`intel_${i}`, item.url)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(item.title)}</a>
          </h3>
          <p style="font-size: 14px; color: #555; margin: 4px 0;">${escapeHtml(item.summary)}</p>
          <p style="font-size: 13px; color: #1a1a2e; margin: 4px 0; font-style: italic;">${escapeHtml(item.whyItMatters)}</p>
        </div>
        `).join('');
        html += '<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">';
      }
      return html;
    })()}

    <!-- What Shipped -->
    ${content.whatShipped && content.whatShipped.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 16px;">What shipped</h2>
    ${content.whatShipped.map((item, i) => `
    <div style="margin-bottom: 14px;">
      <p style="font-size: 14px; margin: 0;">
        <a href="${t(`shipped_${i}`, item.url)}" style="color: #2563eb; text-decoration: none; font-weight: 600;">${escapeHtml(item.title)}</a>
        ${item.summary ? ` — ${escapeHtml(item.summary)}` : ''}
      </p>
    </div>
    `).join('')}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
    ` : ''}

    <!-- From the Inside -->
    ${renderInsiderHtml(content.fromTheInside, userWorkingGroupNames, t, segment)}

    <!-- Voices -->
    ${content.voices.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 16px;">Voices</h2>
    ${content.voices.map((item, i) => `
    <div style="margin-bottom: 18px;">
      <h3 style="font-size: 15px; margin: 0 0 4px 0;">
        <a href="${t(`voice_${i}`, item.url)}" style="color: #2563eb; text-decoration: none;">${escapeHtml(item.title)}</a>
      </h3>
      <p style="font-size: 13px; color: #666; margin: 4px 0 6px 0;">by ${escapeHtml(item.authorName)}${item.publishedAt ? ` · ${escapeHtml(formatDate(item.publishedAt.slice(0, 10)))}` : ''}</p>
      ${item.excerpt ? `<p style="font-size: 14px; color: #555; margin: 0;">${escapeHtml(item.excerpt)}</p>` : ''}
    </div>
    `).join('')}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
    ` : ''}

    <!-- Shareable Take -->
    ${content.shareableTake ? `
    <div style="margin: 0 0 20px 0; padding: 16px 20px; background: #f8f9fa; border-radius: 6px; text-align: center;">
      <p style="font-size: 14px; color: #1a1a2e; margin: 0 0 8px 0; font-style: italic;">"${escapeHtml(content.shareableTake)}"</p>
      <p style="font-size: 12px; color: #888; margin: 0;">Copy and share this take</p>
    </div>
    ` : ''}

    ${content.newMembers.length > 0 ? `
    <p style="font-size: 14px; color: #555; margin: 0 0 16px 0;">
      Welcome to ${content.newMembers.map((m) => `<strong>${escapeHtml(m.name)}</strong>`).join(', ')} who joined this week.
    </p>
    ` : ''}

    <!-- Take Action -->
    ${content.takeActions && content.takeActions.length > 0 ? `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">Take action</h2>
    ${content.takeActions.map((action, i) => `
    <div style="margin-bottom: 12px;">
      <p style="font-size: 14px; color: #333; margin: 0; line-height: 1.5;">
        ${escapeHtml(action.text)}
        <a href="${t(`action_${i}`, action.ctaUrl)}" style="color: #2563eb; font-weight: 600; text-decoration: none; white-space: nowrap;">${escapeHtml(action.ctaLabel)} &rarr;</a>
      </p>
    </div>
    `).join('')}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
    ` : ''}

    <!-- Sign-off -->
    <p style="font-size: 15px; color: #333; line-height: 1.6; margin-bottom: 4px;">
      We're building this together. If something here resonated, pass it along — every share brings in someone new.
    </p>
    <p style="font-size: 15px; color: #333; margin-top: 8px;">
      Let's keep building,<br>
      Addie<br>
      <span style="font-size: 13px; color: #666;">AgenticAdvertising.org</span>
    </p>

    ${renderCta(segment, trackingId)}

    <!-- Feedback -->
    <p style="font-size: 13px; color: #888; text-align: center; margin-top: 30px;">
      Was this useful?
      <a href="${t('feedback_yes', `${BASE_URL}/perspectives/the-prompt-${editionDate}/feedback?vote=yes&t=${trackingId}`)}" style="text-decoration: none; font-size: 16px;">&#128077;</a>
      <a href="${t('feedback_no', `${BASE_URL}/perspectives/the-prompt-${editionDate}/feedback?vote=no&t=${trackingId}`)}" style="text-decoration: none; font-size: 16px;">&#128078;</a>
    </p>
  </div>`.trim();

  const text = renderDigestText(content, editionDate, segment, firstName, userWorkingGroupNames);

  return { html, text };
}

/**
 * Render the "From the inside" section with per-recipient WG expansion.
 * User's groups get full detail; others get one-line summaries.
 */
function renderInsiderHtml(
  groups: DigestInsiderGroup[],
  userWorkingGroupNames: string[] | undefined,
  t: (tag: string, url: string) => string,
  segment: DigestSegment,
): string {
  if (groups.length === 0) return '';

  const userWGs = new Set(userWorkingGroupNames || []);

  // Sort user's groups first
  const sorted = userWGs.size > 0
    ? [...groups].sort((a, b) => {
        const aMatch = userWGs.has(a.name) ? 1 : 0;
        const bMatch = userWGs.has(b.name) ? 1 : 0;
        return bMatch - aMatch || a.name.localeCompare(b.name);
      })
    : groups;

  const items = sorted.map((group, i) => {
    const isMember = userWGs.has(group.name);
    const borderStyle = isMember ? ' border-left: 3px solid #2563eb; padding-left: 12px;' : '';

    if (isMember) {
      // Expanded view for user's groups
      return `
      <div style="margin-bottom: 16px;${borderStyle}">
        <p style="font-size: 14px; margin: 0;">
          <strong>${escapeHtml(group.name)}</strong>: ${escapeHtml(group.summary.slice(0, 200))}
          ${group.nextMeeting ? `<br><span style="font-size: 13px; color: #666;">Next: ${escapeHtml(group.nextMeeting)}</span>` : ''}
        </p>
        ${group.meetingRecaps.length > 0 ? group.meetingRecaps.map((recap) => `
        <div style="margin: 8px 0 4px 0; padding: 8px 12px; background: #f8f9fa; border-radius: 4px;">
          <p style="font-size: 13px; color: #333; margin: 0;">
            <strong>${escapeHtml(recap.title)}</strong> (${escapeHtml(recap.date)})
            ${recap.summary ? `<br><span style="color: #555;">${escapeHtml(recap.summary.slice(0, 150))}</span>` : ''}
          </p>
        </div>
        `).join('') : ''}
        ${group.activeThreads.length > 0 && segment !== 'website_only' ? group.activeThreads.map((thread) => `
        <p style="font-size: 13px; color: #555; margin: 4px 0;">
          ${thread.starter ? `${escapeHtml(thread.starter)}: ` : ''}"${escapeHtml(thread.summary.slice(0, 100))}" · ${thread.replyCount} replies
          <a href="${t(`thread_${i}`, thread.threadUrl)}" style="color: #2563eb;">Join →</a>
        </p>
        `).join('') : ''}
      </div>`;
    }

    // One-line summary for non-member groups
    return `
    <div style="margin-bottom: 12px;${borderStyle}">
      <p style="font-size: 14px; margin: 0;">
        <strong>${escapeHtml(group.name)}</strong>: ${escapeHtml(group.summary.slice(0, 150))}
        ${group.nextMeeting ? `<br><span style="font-size: 13px; color: #666;">Next: ${escapeHtml(group.nextMeeting)}</span>` : ''}
      </p>
    </div>`;
  }).join('');

  return `
    <h2 style="font-size: 17px; color: #1a1a2e; margin-bottom: 12px;">From the inside</h2>
    ${items}
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">`;
}

function renderCta(segment: DigestSegment, trackingId: string): string {
  const t = (tag: string, url: string) => trackLink(trackingId, tag, url);

  switch (segment) {
    case 'website_only':
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px; margin-top: 20px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 8px 0;">
          The conversation continues in Slack — 1,400+ practitioners, no fluff.
        </p>
        <a href="${t('cta_slack_join', `${BASE_URL}/slack`)}" style="display: inline-block; padding: 10px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
          Join the conversation
        </a>
      </div>`;
    case 'slack_only':
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px; margin-top: 20px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0 0 8px 0;">
          Get listed in the member directory and unlock your full profile.
        </p>
        <a href="${t('cta_signup', `${BASE_URL}/signup`)}" style="display: inline-block; padding: 10px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 6px; font-size: 14px;">
          Create your account
        </a>
      </div>`;
    case 'both':
    case 'active':
    default:
      return `
      <div style="text-align: center; padding: 16px; background: #f0f4ff; border-radius: 8px; margin-top: 20px;">
        <p style="font-size: 15px; color: #1a1a2e; margin: 0;">
          Know someone who should be reading this?
          <a href="${t('cta_invite', `${BASE_URL}/invite`)}" style="color: #2563eb;">Forward it.</a>
        </p>
      </div>`;
  }
}

// ─── Email Plain Text ───────────────────────────────────────────────────

function renderDigestText(
  content: DigestContent,
  editionDate: string,
  segment: DigestSegment,
  firstName?: string,
  userWorkingGroupNames?: string[],
): string {
  const lines: string[] = [
    `The Prompt — from Addie`,
    formatDate(editionDate),
    '',
  ];
  if (firstName) lines.push(`Hi ${firstName},`, '');
  lines.push(content.openingTake, '');

  if (content.editorsNote) {
    lines.push(
      isHtml(content.editorsNote)
        ? htmlToPlainText(content.editorsNote)
        : slackLinksToPlainText(content.editorsNote),
      '',
    );
  }

  if (content.newMembers.length > 0) {
    lines.push(`Welcome to ${content.newMembers.map((m) => m.name).join(', ')} who joined this week.`, '');
  }

  if (content.whatToWatch.length > 0) {
    const officialText = content.whatToWatch.filter((item) => item.tags?.includes('official'));
    const externalText = content.whatToWatch.filter((item) => !item.tags?.includes('official'));

    for (const item of officialText) {
      lines.push(`* ${item.title}`);
      lines.push(`  ${item.summary}`);
      if (item.takeaways && item.takeaways.length > 0) {
        for (const tw of item.takeaways) {
          lines.push(`  - ${tw}`);
        }
      }
      lines.push(`  ${item.url}`);
      lines.push('');
    }

    if (externalText.length > 0) {
      lines.push('--- INDUSTRY INTEL ---', '');
      for (const item of externalText) {
        lines.push(`* ${item.title}`);
        lines.push(`  ${item.summary}`);
        lines.push(`  ${item.whyItMatters}`);
        lines.push(`  ${item.url}`);
        lines.push('');
      }
    }
  }

  if (content.fromTheInside.length > 0) {
    const userWGs = new Set(userWorkingGroupNames || []);
    lines.push('--- FROM THE INSIDE ---', '');
    for (const group of content.fromTheInside) {
      lines.push(`* ${group.name}: ${group.summary.slice(0, 150)}`);
      if (group.nextMeeting) lines.push(`  Next: ${group.nextMeeting}`);
      if (userWGs.has(group.name)) {
        for (const recap of group.meetingRecaps) {
          lines.push(`  - ${recap.title} (${recap.date})${recap.summary ? `: ${recap.summary.slice(0, 100)}` : ''}`);
        }
        for (const thread of group.activeThreads) {
          if (segment !== 'website_only') {
            lines.push(`  - "${thread.summary.slice(0, 80)}" (${thread.replyCount} replies) ${thread.threadUrl}`);
          }
        }
      }
      lines.push('');
    }
  }

  if (content.voices.length > 0) {
    lines.push('--- VOICES ---', '');
    for (const item of content.voices) {
      lines.push(`* ${item.title}`);
      lines.push(`  by ${item.authorName}`);
      if (item.excerpt) lines.push(`  ${item.excerpt}`);
      lines.push(`  ${item.url}`);
      lines.push('');
    }
  }

  if (content.takeActions && content.takeActions.length > 0) {
    lines.push('--- TAKE ACTION ---', '');
    for (const action of content.takeActions) {
      lines.push(`* ${action.text}`);
      lines.push(`  ${action.ctaLabel}: ${action.ctaUrl}`);
      lines.push('');
    }
  }

  lines.push('---', '');
  lines.push("We're building this together. If something here resonated, pass it along.", '');
  lines.push("Let's keep building,");
  lines.push('Addie');
  lines.push('AgenticAdvertising.org', '');
  lines.push(`Read online: ${BASE_URL}/perspectives/the-prompt-${editionDate}`);

  return lines.join('\n');
}

// ─── Slack Block Kit ────────────────────────────────────────────────────

/**
 * Render The Prompt as a Slack Block Kit message
 */
export function renderDigestSlack(content: DigestContent, editionDate: string): SlackBlockMessage {
  const webUrl = `${BASE_URL}/perspectives/the-prompt-${editionDate}`;
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `The Prompt — ${formatDate(editionDate)}` },
  });

  // Opening take
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: escapeSlackMrkdwn(content.openingTake) },
  });

  // Editor's note
  if (content.editorsNote) {
    const mrkdwn = isHtml(content.editorsNote)
      ? htmlToSlackMrkdwn(content.editorsNote)
      : escapeSlackMrkdwnPreserveLinks(content.editorsNote);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: mrkdwn.split('\n').map((line) => `> ${line}`).join('\n') },
    });
  }

  // Official content (with takeaways)
  const officialSlack = content.whatToWatch.filter((item) => item.tags?.includes('official'));
  const externalSlack = content.whatToWatch.filter((item) => !item.tags?.includes('official'));

  if (officialSlack.length > 0) {
    const officialText = officialSlack
      .map((item) => {
        let text = `> *<${item.url}|${escapeSlackMrkdwn(item.title)}>*`;
        if (item.takeaways && item.takeaways.length > 0) {
          text += '\n' + item.takeaways.map((tw) => `> • ${escapeSlackMrkdwn(tw)}`).join('\n');
        } else {
          text += `\n> _${escapeSlackMrkdwn(item.whyItMatters)}_`;
        }
        return text;
      })
      .join('\n\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: officialText },
    });
  }

  // Industry intel
  if (externalSlack.length > 0) {
    const watchText = externalSlack
      .map((item) => `> *<${item.url}|${escapeSlackMrkdwn(item.title)}>*\n> _${escapeSlackMrkdwn(item.whyItMatters)}_`)
      .join('\n\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Industry intel*\n\n${watchText}` },
    });
  }

  // From the inside
  if (content.fromTheInside.length > 0) {
    const insiderText = content.fromTheInside
      .map((g) => {
        const meeting = g.nextMeeting ? `\n>    _Next: ${escapeSlackMrkdwn(g.nextMeeting)}_` : '';
        return `> *${escapeSlackMrkdwn(g.name)}*: ${escapeSlackMrkdwn(g.summary.slice(0, 150))}${meeting}`;
      })
      .join('\n\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*From the inside*\n\n${insiderText}` },
    });
  }

  // Voices
  if (content.voices.length > 0) {
    const voicesText = content.voices
      .map((item) => `> *<${item.url}|${escapeSlackMrkdwn(item.title)}>*\n> _by ${escapeSlackMrkdwn(item.authorName)}_`)
      .join('\n\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Voices*\n\n${voicesText}` },
    });
  }

  // Take action
  if (content.takeActions && content.takeActions.length > 0) {
    const actionText = content.takeActions
      .map((a) => `• ${escapeSlackMrkdwn(a.text)} <${a.ctaUrl}|${escapeSlackMrkdwn(a.ctaLabel)}>`)
      .join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Take action*\n\n${actionText}` },
    });
  }

  // Read more
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `<${webUrl}|Read the full Prompt>` },
  });

  const fallbackText = `The Prompt — ${formatDate(editionDate)}: ${content.openingTake}`;
  return { text: fallbackText, blocks };
}

// ─── Slack Review Message ───────────────────────────────────────────────

/**
 * Render The Prompt for the Slack review message in the Editorial channel
 */
export function renderDigestReview(content: DigestContent, editionDate: string): SlackBlockMessage {
  const slackMessage = renderDigestSlack(content, editionDate);
  const blocks: SlackBlock[] = slackMessage.blocks || [];

  blocks.unshift({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*The Prompt — Draft for ${formatDate(editionDate)}*\n:white_check_mark: Approve for 10am ET delivery · :arrows_counterclockwise: Regenerate from scratch\nReply in thread to edit — e.g. "remove the first article", "editor's note: Don't miss our March town hall", or ask for any changes.`,
    },
  });
  blocks.splice(1, 0, { type: 'divider' });

  return {
    text: `The Prompt draft ready for review — ${formatDate(editionDate)}`,
    blocks,
  };
}

// ─── Web Page ───────────────────────────────────────────────────────────

/**
 * Render The Prompt as a full web-viewable HTML page
 */
export function renderDigestWebPage(content: DigestContent, editionDate: string): string {
  const { html: innerHtml } = renderDigestEmail(content, 'web', editionDate, 'both');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Prompt — ${formatDate(editionDate)} | AgenticAdvertising.org</title>
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

// ─── Utilities ──────────────────────────────────────────────────────────


function formatDate(editionDate: string): string {
  const date = new Date(editionDate + 'T12:00:00Z');
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
