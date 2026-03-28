/**
 * Working Group Digest Prep Email Template
 *
 * Sent to WG leaders on Monday before the biweekly Wednesday digest,
 * highlighting content gaps (missing meeting notes, stale summaries)
 * so leaders can fill them in before the digest goes out.
 */

import type { WgDigestGap } from '../services/wg-digest-builder.js';

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function renderWgDigestPrepEmail(
  gap: WgDigestGap,
  firstName?: string,
): { html: string; text: string; subject: string } {
  const subject = `${gap.groupName} digest goes out Wednesday — a few gaps to fill`;
  const groupUrl = `${BASE_URL}/working-groups/${gap.groupSlug}`;
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,';

  // --- HTML ---
  const htmlSections: string[] = [];

  htmlSections.push(`
  <div style="max-width: 560px; margin: 0 auto;">
    <p style="font-size: 15px; color: #333; margin-bottom: 16px;">${greeting}</p>
    <p style="font-size: 14px; color: #444; line-height: 1.6; margin-bottom: 20px;">
      The <strong>${escapeHtml(gap.groupName)}</strong> digest goes out to members on Wednesday.
      A quick look turned up a few things that could use your input before then.
    </p>
  `);

  if (gap.meetingsWithoutNotes.length > 0) {
    const meetingList = gap.meetingsWithoutNotes.map(m => `
      <li style="margin-bottom: 8px;">
        <a href="${escapeHtml(m.meetingUrl)}" style="color: #0077b6; text-decoration: none; font-weight: 500;">${escapeHtml(m.title)}</a>
        <span style="font-size: 12px; color: #888;"> (${escapeHtml(m.date)})</span>
      </li>
    `).join('');

    htmlSections.push(`
    <div style="margin-bottom: 20px;">
      <p style="font-size: 14px; font-weight: 600; color: #1a1a2e; margin-bottom: 8px;">Meetings without notes</p>
      <ul style="padding-left: 20px; margin: 0;">${meetingList}</ul>
    </div>
    `);
  }

  if (gap.missingSummary) {
    htmlSections.push(`
    <div style="margin-bottom: 20px;">
      <p style="font-size: 14px; font-weight: 600; color: #1a1a2e; margin-bottom: 8px;">Activity summary</p>
      <p style="font-size: 14px; color: #444;">
        No activity summary on file.
        <a href="${groupUrl}" style="color: #0077b6; text-decoration: none;">Add one on the group page &rarr;</a>
      </p>
    </div>
    `);
  }

  htmlSections.push(`
    <p style="font-size: 13px; color: #888; margin-top: 16px;">
      No action needed if everything looks right — this is just a heads-up.
    </p>
  </div>
  `);

  const html = htmlSections.join('');

  // --- Plaintext ---
  const textLines: string[] = [];
  textLines.push(greeting, '');
  textLines.push(`The ${gap.groupName} digest goes out to members on Wednesday.`);
  textLines.push('A quick look turned up a few things that could use your input before then.', '');

  if (gap.meetingsWithoutNotes.length > 0) {
    textLines.push('MEETINGS WITHOUT NOTES');
    for (const m of gap.meetingsWithoutNotes) {
      textLines.push(`  ${m.title} (${m.date})`, `  ${m.meetingUrl}`);
    }
    textLines.push('');
  }

  if (gap.missingSummary) {
    textLines.push('ACTIVITY SUMMARY');
    textLines.push(`  No activity summary on file. Add one: ${groupUrl}`, '');
  }

  textLines.push('No action needed if everything looks right.', '');

  return { html, text: textLines.join('\n'), subject };
}
