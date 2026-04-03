/**
 * The Build — Email Template
 *
 * Renders Sage's biweekly contributor briefing as email HTML + text.
 * Teal palette. Direct, factual tone.
 */

import type { BuildContent } from '../../db/build-db.js';
import type { SlackBlockMessage } from '../../slack/types.js';
import { escapeHtml, trackLink, formatDate, renderEmailShell } from '../email-layout.js';

const BUILD_PALETTE = {
  primary: '#0d9488',
  light: '#f0fdfa',
  dark: '#1a1a2e',
};

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

export type BuildSegment = 'website_only' | 'slack_only' | 'both' | 'active';

// ─── Email Rendering ───────────────────────────────────────────────────

export function renderBuildEmail(
  content: BuildContent,
  trackingId: string,
  editionDate: string,
  segment: BuildSegment,
  firstName?: string,
): { html: string; text: string } {
  const t = (tag: string, url: string) => trackLink(trackingId, tag, url);

  // Build the body sections
  const sections: string[] = [];

  // Status line
  sections.push(`<p style="font-size: 15px; color: #333; line-height: 1.6;">${escapeHtml(content.statusLine)}</p>`);

  // Editor's note
  if (content.editorsNote) {
    sections.push(`
    <div style="margin: 20px 0; padding: 16px 20px; background: ${BUILD_PALETTE.light}; border-left: 4px solid ${BUILD_PALETTE.primary}; border-radius: 0 6px 6px 0;">
      <p style="font-size: 15px; color: #1a1a2e; margin: 0; line-height: 1.6;">${escapeHtml(content.editorsNote)}</p>
    </div>`);
  }

  sections.push('<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">');

  // Decisions & Proposals
  if (content.decisions.length > 0) {
    sections.push(`<h2 style="font-size: 17px; color: ${BUILD_PALETTE.dark}; margin-bottom: 16px;">Decisions & proposals</h2>`);
    for (const d of content.decisions) {
      const badge = d.status === 'decided'
        ? '<span style="display:inline-block;padding:2px 8px;background:#065f46;color:white;font-size:11px;border-radius:3px;margin-right:8px;">DECIDED</span>'
        : d.status === 'open_for_comment'
          ? '<span style="display:inline-block;padding:2px 8px;background:#d97706;color:white;font-size:11px;border-radius:3px;margin-right:8px;">OPEN</span>'
          : '<span style="display:inline-block;padding:2px 8px;background:#6366f1;color:white;font-size:11px;border-radius:3px;margin-right:8px;">REVIEW</span>';
      sections.push(`
      <div style="margin-bottom: 16px;">
        <p style="font-size: 14px; margin: 0 0 4px 0;">${badge}<strong>${escapeHtml(d.workingGroup)}</strong></p>
        <h3 style="font-size: 15px; margin: 0 0 4px 0;">
          <a href="${t(`decision_${content.decisions.indexOf(d)}`, d.url)}" style="color: ${BUILD_PALETTE.primary}; text-decoration: none;">${escapeHtml(d.title)}</a>
        </h3>
        <p style="font-size: 14px; color: #555; margin: 4px 0;">${escapeHtml(d.summary)}</p>
        ${d.commentDeadline ? `<p style="font-size: 13px; color: #d97706; margin: 4px 0;">Comment by ${escapeHtml(formatDate(d.commentDeadline))}</p>` : ''}
      </div>`);
    }
    sections.push('<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">');
  }

  // What Shipped
  if (content.whatShipped.length > 0) {
    sections.push(`<h2 style="font-size: 17px; color: ${BUILD_PALETTE.dark}; margin-bottom: 16px;">What shipped</h2>`);
    // Breaking changes first
    const sorted = [...content.whatShipped].sort((a, b) => (b.breaking ? 1 : 0) - (a.breaking ? 1 : 0));
    for (const r of sorted) {
      const breakingBadge = r.breaking
        ? '<span style="display:inline-block;padding:2px 6px;background:#dc2626;color:white;font-size:10px;border-radius:3px;margin-right:6px;">BREAKING</span>'
        : '';
      sections.push(`
      <div style="margin-bottom: 14px;">
        <p style="font-size: 14px; margin: 0;">
          ${breakingBadge}<a href="${t(`shipped_${sorted.indexOf(r)}`, r.releaseUrl)}" style="color: ${BUILD_PALETTE.primary}; text-decoration: none; font-weight: 600;">${escapeHtml(r.repo)} ${escapeHtml(r.version)}</a>
          — ${escapeHtml(r.summary)}
        </p>
        ${r.migrationNote ? `<p style="font-size: 13px; color: #dc2626; margin: 4px 0 0 0;">Migration: ${escapeHtml(r.migrationNote)}</p>` : ''}
      </div>`);
    }
    sections.push('<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">');
  }

  // Deep Dive
  if (content.deepDive) {
    sections.push(`<h2 style="font-size: 17px; color: ${BUILD_PALETTE.dark}; margin-bottom: 16px;">Deep dive: ${escapeHtml(content.deepDive.title)}</h2>`);
    // Show excerpt, not full body — link to the perspective
    const excerpt = content.deepDive.body.slice(0, 300).trim();
    sections.push(`
    <p style="font-size: 14px; color: #555; line-height: 1.6; margin: 0 0 8px 0;">${escapeHtml(excerpt)}...</p>
    <a href="${t('deep_dive', `${BASE_URL}/perspectives/${content.deepDive.slug}`)}" style="font-size: 14px; color: ${BUILD_PALETTE.primary};">Read the full deep dive &rarr;</a>`);
    sections.push('<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">');
  }

  // Help Needed
  if (content.helpNeeded.length > 0) {
    sections.push(`<h2 style="font-size: 17px; color: ${BUILD_PALETTE.dark}; margin-bottom: 16px;">Help needed</h2>`);
    for (const item of content.helpNeeded) {
      const typeLabel = item.type === 'code' ? 'Code' : item.type === 'review' ? 'Review' : item.type === 'writing' ? 'Writing' : 'Expertise';
      sections.push(`
      <div style="margin-bottom: 14px;">
        <p style="font-size: 14px; margin: 0;">
          <span style="display:inline-block;padding:2px 6px;background:#e5e7eb;color:#374151;font-size:11px;border-radius:3px;margin-right:6px;">${typeLabel}</span>
          <a href="${t(`help_${content.helpNeeded.indexOf(item)}`, item.url)}" style="color: ${BUILD_PALETTE.primary}; text-decoration: none; font-weight: 600;">${escapeHtml(item.title)}</a>
        </p>
        <p style="font-size: 13px; color: #666; margin: 4px 0;">${escapeHtml(item.source)} — ${escapeHtml(item.context)}</p>
      </div>`);
    }
    sections.push('<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0;">');
  }

  // Contributor Spotlight
  if (content.contributorSpotlight.length > 0) {
    sections.push(`<h2 style="font-size: 17px; color: ${BUILD_PALETTE.dark}; margin-bottom: 16px;">Contributor spotlight</h2>`);
    for (const c of content.contributorSpotlight) {
      sections.push(`
      <p style="font-size: 14px; margin: 0 0 10px 0;">
        <strong>${escapeHtml(c.name)}</strong>${c.handle ? ` (${escapeHtml(c.handle)})` : ''}
        — ${escapeHtml(c.contribution)}
        ${c.url ? ` <a href="${t(`contributor_${content.contributorSpotlight.indexOf(c)}`, c.url.startsWith('/') ? BASE_URL + c.url : c.url)}" style="color: ${BUILD_PALETTE.primary}; text-decoration: none;">&rarr;</a>` : ''}
      </p>`);
    }
  }

  const bodyHtml = sections.join('\n');

  const html = renderEmailShell({
    newsletterName: 'The Build',
    author: 'Sage',
    palette: BUILD_PALETTE,
    perspectiveSlugPrefix: 'the-build',
    signOff: {
      text: "That's the cycle. If something broke, file an issue. If something's missing, open a PR.",
      attribution: 'Sage',
      domain: 'docs.adcontextprotocol.org',
    },
    preheaderText: content.statusLine,
    editionDate,
    trackingId,
    segment,
    firstName,
    bodyHtml,
  });

  const text = renderBuildText(content, editionDate);
  return { html, text };
}

// ─── Plain Text ────────────────────────────────────────────────────────

function renderBuildText(content: BuildContent, editionDate: string): string {
  const lines: string[] = [
    `The Build — from Sage — ${formatDate(editionDate)}`,
    '',
    content.statusLine,
    '',
  ];

  if (content.decisions.length > 0) {
    lines.push('DECISIONS & PROPOSALS', '');
    for (const d of content.decisions) {
      lines.push(`[${d.status.toUpperCase()}] ${d.workingGroup}: ${d.title}`);
      lines.push(`  ${d.summary}`);
      lines.push(`  ${d.url}`);
      lines.push('');
    }
  }

  if (content.whatShipped.length > 0) {
    lines.push('WHAT SHIPPED', '');
    for (const r of content.whatShipped) {
      lines.push(`${r.breaking ? '[BREAKING] ' : ''}${r.repo} ${r.version} — ${r.summary}`);
      lines.push(`  ${r.releaseUrl}`);
      lines.push('');
    }
  }

  if (content.helpNeeded.length > 0) {
    lines.push('HELP NEEDED', '');
    for (const h of content.helpNeeded) {
      lines.push(`[${h.type.toUpperCase()}] ${h.title} (${h.source})`);
      lines.push(`  ${h.context}`);
      lines.push(`  ${h.url}`);
      lines.push('');
    }
  }

  if (content.contributorSpotlight.length > 0) {
    lines.push('CONTRIBUTOR SPOTLIGHT', '');
    for (const c of content.contributorSpotlight) {
      lines.push(`${c.name}${c.handle ? ` (${c.handle})` : ''} — ${c.contribution}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push("That's the cycle. If something broke, file an issue. If something's missing, open a PR.");
  lines.push('— Sage');
  lines.push('docs.adcontextprotocol.org');

  return lines.join('\n');
}

// ─── Slack Rendering ───────────────────────────────────────────────────

export function renderBuildSlack(content: BuildContent, editionDate: string): SlackBlockMessage {
  const blocks: Array<Record<string, unknown>> = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `The Build — ${formatDate(editionDate)}` },
  });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: content.statusLine },
  });

  if (content.decisions.length > 0) {
    const decisionLines = content.decisions.slice(0, 3).map((d) =>
      `• *[${d.status.toUpperCase()}]* ${d.workingGroup}: <${d.url}|${d.title}>`
    ).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Decisions & proposals*\n${decisionLines}` },
    });
  }

  if (content.whatShipped.length > 0) {
    const releaseLines = content.whatShipped.slice(0, 3).map((r) =>
      `• ${r.breaking ? ':rotating_light: ' : ''}<${r.releaseUrl}|${r.repo} ${r.version}> — ${r.summary}`
    ).join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*What shipped*\n${releaseLines}` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_from Sage — docs.adcontextprotocol.org_' }],
  });

  return { text: `The Build — ${formatDate(editionDate)}`, blocks: blocks as never[] };
}

export function renderBuildReview(content: BuildContent, editionDate: string): SlackBlockMessage {
  const stats = [
    `${content.decisions.length} decisions`,
    `${content.whatShipped.length} releases`,
    `${content.helpNeeded.length} help asks`,
    `${content.contributorSpotlight.length} spotlights`,
  ].join(' · ');

  return {
    text: `The Build draft — ${editionDate}\n${stats}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*The Build* — ${editionDate}\n${stats}` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: content.statusLine },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'build_approve' },
          { type: 'button', text: { type: 'plain_text', text: 'Edit' }, action_id: 'build_edit', url: `${BASE_URL}/admin/the-build` },
        ],
      },
    ] as never[],
  };
}
