/**
 * Working Group Digest Email Template
 *
 * Renders per-group biweekly digest as HTML + plaintext email content.
 * The outer shell (DOCTYPE, footer, unsubscribe) is added by sendBatchMarketingEmails.
 */

import type { WgDigestContent } from '../../db/wg-digest-db.js';
import { markdownToEmailHtml } from '../../utils/markdown.js';

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function renderWgDigestEmail(
  content: WgDigestContent,
  groupSlug: string,
  firstName?: string,
): { html: string; text: string; subject: string } {
  const subject = `${content.groupName} — Biweekly Update`;
  const groupUrl = `${BASE_URL}/working-groups/${groupSlug}`;
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : '';

  // --- HTML ---
  const htmlSections: string[] = [];

  htmlSections.push(`
  <div style="max-width: 560px; margin: 0 auto;">
    <h1 style="font-size: 20px; color: #1a1a2e; margin-bottom: 4px;">${escapeHtml(content.groupName)}</h1>
    <p style="font-size: 13px; color: #888; margin-top: 0;">Biweekly Update</p>

    ${greeting ? `<p style="font-size: 15px; color: #333; margin-bottom: 16px;">${greeting}</p>` : ''}
  `);

  // Activity summary
  if (content.summary) {
    htmlSections.push(`
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; color: #1a1a2e; margin-bottom: 8px;">What's Happening</h2>
      <div style="font-size: 14px; color: #444; line-height: 1.6;">${markdownToEmailHtml(content.summary)}</div>
    </div>
    `);
  }

  // Meeting recaps
  if (content.meetingRecaps.length > 0) {
    const recapHtml = content.meetingRecaps.map(m => `
      <div style="margin-bottom: 12px; padding: 12px; background: #f8f9fa; border-radius: 6px;">
        <p style="font-size: 14px; font-weight: 600; color: #1a1a2e; margin: 0 0 4px 0;">${escapeHtml(m.title)}</p>
        <p style="font-size: 12px; color: #888; margin: 0 0 8px 0;">${escapeHtml(m.date)}</p>
        <div style="font-size: 14px; color: #444; line-height: 1.5; margin: 0;">${markdownToEmailHtml(m.summary)}</div>
      </div>
    `).join('');

    htmlSections.push(`
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; color: #1a1a2e; margin-bottom: 8px;">Meeting Recaps</h2>
      ${recapHtml}
    </div>
    `);
  }

  // Next meeting
  if (content.nextMeeting) {
    htmlSections.push(`
    <div style="margin-bottom: 24px; padding: 16px; background: #e8f4f8; border-radius: 6px; border-left: 3px solid #0077b6;">
      <p style="font-size: 14px; font-weight: 600; color: #1a1a2e; margin: 0 0 4px 0;">Next Meeting</p>
      <p style="font-size: 14px; color: #444; margin: 0;">${escapeHtml(content.nextMeeting.title)} — ${escapeHtml(content.nextMeeting.date)}</p>
    </div>
    `);
  }

  // Active discussions
  if (content.activeThreads.length > 0) {
    const threadHtml = content.activeThreads.map(t => {
      const truncated = t.summary.length > 100 ? t.summary.slice(0, 100) + '...' : t.summary;
      return `
      <div style="margin-bottom: 8px;">
        <a href="${escapeHtml(t.threadUrl)}" style="font-size: 14px; color: #0077b6; text-decoration: none;">${escapeHtml(truncated)}</a>
        <span style="font-size: 12px; color: #888;"> (${t.replyCount} replies)</span>
      </div>
    `;
    }).join('');

    htmlSections.push(`
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; color: #1a1a2e; margin-bottom: 8px;">Active Discussions</h2>
      ${threadHtml}
    </div>
    `);
  }

  // New members
  if (content.newMembers.length > 0) {
    const names = content.newMembers.map(n => escapeHtml(n)).join(', ');
    htmlSections.push(`
    <div style="margin-bottom: 24px;">
      <h2 style="font-size: 16px; color: #1a1a2e; margin-bottom: 8px;">New Members</h2>
      <p style="font-size: 14px; color: #444;">Welcome ${names}!</p>
    </div>
    `);
  }

  // Footer link
  htmlSections.push(`
    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">
    <p style="font-size: 13px; color: #888; text-align: center;">
      <a href="${groupUrl}" style="color: #0077b6; text-decoration: none;">View group page</a>
    </p>
  </div>
  `);

  const html = htmlSections.join('');

  // --- Plaintext ---
  const textLines: string[] = [];
  textLines.push(`${content.groupName} — Biweekly Update`);
  textLines.push('');
  if (greeting) textLines.push(greeting, '');

  if (content.summary) {
    textLines.push('WHAT\'S HAPPENING', content.summary, '');
  }

  if (content.meetingRecaps.length > 0) {
    textLines.push('MEETING RECAPS');
    for (const m of content.meetingRecaps) {
      textLines.push(`  ${m.title} (${m.date})`, `  ${m.summary}`, '');
    }
  }

  if (content.nextMeeting) {
    textLines.push(`NEXT MEETING: ${content.nextMeeting.title} — ${content.nextMeeting.date}`, '');
  }

  if (content.activeThreads.length > 0) {
    textLines.push('ACTIVE DISCUSSIONS');
    for (const t of content.activeThreads) {
      const truncated = t.summary.length > 100 ? t.summary.slice(0, 100) + '...' : t.summary;
      textLines.push(`  ${truncated} (${t.replyCount} replies)`, `  ${t.threadUrl}`);
    }
    textLines.push('');
  }

  if (content.newMembers.length > 0) {
    textLines.push(`NEW MEMBERS: Welcome ${content.newMembers.join(', ')}!`, '');
  }

  textLines.push(`View group page: ${groupUrl}`);

  return { html, text: textLines.join('\n'), subject };
}
