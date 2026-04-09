/**
 * Shared Email Layout
 *
 * Renders the common email shell used by all newsletters: preheader, header,
 * sign-off, CTA, feedback buttons, and the web page wrapper for preview.
 * Colors and branding come from the newsletter config.
 */

import type { NewsletterPalette } from './config.js';
import { trackedUrl } from '../notifications/email.js';

const BASE_URL = process.env.BASE_URL || 'https://agenticadvertising.org';

// ─── Utilities ─────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function trackLink(trackingId: string, linkTag: string, destinationUrl: string): string {
  if (trackingId === 'web' || trackingId === 'preview') return destinationUrl;
  return trackedUrl(trackingId, linkTag, destinationUrl);
}

export function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// ─── Email Shell ───────────────────────────────────────────────────────

export interface EmailShellOptions {
  newsletterName: string;
  author: string;
  palette: NewsletterPalette;
  perspectiveSlugPrefix: string;
  signOff: { text: string; attribution: string; domain: string };
  preheaderText: string;
  editionDate: string;
  trackingId: string;
  segment: string;
  firstName?: string;
  /** Optional cover image URL for the edition */
  coverImageUrl?: string;
  /** Newsletter-specific body HTML (all content sections) */
  bodyHtml: string;
}

/**
 * Wrap newsletter-specific content in the shared email shell.
 * Returns the complete inner HTML (sendMarketingEmail wraps this in the outer chrome + footer).
 */
export function renderEmailShell(opts: EmailShellOptions): string {
  const { newsletterName, author, palette, perspectiveSlugPrefix, signOff, preheaderText, editionDate, trackingId, segment, firstName, coverImageUrl, bodyHtml } = opts;
  const t = (tag: string, url: string) => trackLink(trackingId, tag, url);
  const viewUrl = t('view_browser', `${BASE_URL}/perspectives/${perspectiveSlugPrefix}-${editionDate}`);
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : '';

  return `
  <div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${escapeHtml(preheaderText)}
  </div>
  <div style="max-width: 560px; margin: 0 auto;">
    <!-- View in browser -->
    <p style="text-align: right; margin-bottom: 16px;">
      <a href="${viewUrl}" style="font-size: 12px; color: #888; text-decoration: none;">View in browser</a>
    </p>

    <!-- Header -->
    ${coverImageUrl ? `
    <div style="margin-bottom: 16px; border-radius: 8px; overflow: hidden;">
      <img src="${escapeHtml(coverImageUrl)}" alt="${escapeHtml(newsletterName)} — ${formatDate(editionDate)}" style="width: 100%; height: auto; display: block;">
    </div>` : ''}
    <h1 style="font-size: 22px; color: ${palette.dark}; margin-bottom: 0;">${escapeHtml(newsletterName)}</h1>
    <p style="font-size: 14px; color: #666; margin-top: 4px;">from ${escapeHtml(author)} &middot; ${formatDate(editionDate)}</p>

    ${greeting ? `<p style="font-size: 15px; color: #333; margin-bottom: 0;">${greeting}</p>` : ''}

    ${bodyHtml}

    <!-- Sign-off -->
    <p style="font-size: 15px; color: #333; line-height: 1.6; margin-bottom: 4px;">
      ${escapeHtml(signOff.text)}
    </p>
    <p style="font-size: 15px; color: #333; margin-top: 8px;">
      — ${escapeHtml(signOff.attribution)}<br>
      <span style="font-size: 13px; color: #666;">${escapeHtml(signOff.domain)}</span>
    </p>

    ${renderCta(segment, trackingId, palette)}

    <!-- Feedback -->
    <p style="font-size: 13px; color: #888; text-align: center; margin-top: 30px;">
      Was this useful?
      <a href="${t('feedback_yes', `${BASE_URL}/perspectives/${perspectiveSlugPrefix}-${editionDate}/feedback?vote=yes&t=${trackingId}`)}" style="text-decoration: none; font-size: 16px;">&#128077;</a>
      <a href="${t('feedback_no', `${BASE_URL}/perspectives/${perspectiveSlugPrefix}-${editionDate}/feedback?vote=no&t=${trackingId}`)}" style="text-decoration: none; font-size: 16px;">&#128078;</a>
    </p>
  </div>`.trim();
}

// ─── CTA Block ─────────────────────────────────────────────────────────

function renderCta(segment: string, trackingId: string, palette: NewsletterPalette): string {
  const t = (tag: string, url: string) => trackLink(trackingId, tag, url);

  if (segment === 'website_only') {
    return `
    <div style="margin: 24px 0; padding: 16px 20px; background: ${palette.light}; border-radius: 6px; text-align: center;">
      <p style="font-size: 14px; color: ${palette.dark}; margin: 0 0 8px 0;">Join the conversation on Slack</p>
      <a href="${t('cta_join_slack', `${BASE_URL}/join`)}" style="display: inline-block; padding: 10px 24px; background: ${palette.primary}; color: white; text-decoration: none; border-radius: 5px; font-size: 14px; font-weight: 600;">Join Slack</a>
    </div>`;
  }

  return `
  <div style="margin: 24px 0; padding: 16px 20px; background: ${palette.light}; border-radius: 6px; text-align: center;">
    <p style="font-size: 14px; color: ${palette.dark}; margin: 0 0 8px 0;">Know someone who should be reading this?</p>
    <a href="${t('cta_invite', `${BASE_URL}/join`)}" style="display: inline-block; padding: 10px 24px; background: ${palette.primary}; color: white; text-decoration: none; border-radius: 5px; font-size: 14px; font-weight: 600;">Invite a colleague</a>
  </div>`;
}

// ─── Preview Page Wrapper ──────────────────────────────────────────────

export interface PreviewPageOptions {
  newsletterName: string;
  emailHtml: string;
  editionDate: string;
  status: string;
  segment: string;
  firstName?: string;
  personaCluster?: string;
  palette: NewsletterPalette;
  /** Additional query params to preserve across segment/persona switches */
  extraParams?: Record<string, string>;
}

/**
 * Wrap rendered email HTML in a preview page with segment and persona switchers.
 */
export function renderPreviewPage(opts: PreviewPageOptions): string {
  const { newsletterName, emailHtml, editionDate, status, segment, firstName, personaCluster, palette } = opts;

  const params = (s: string, p: string | undefined) =>
    `segment=${s}&firstName=${encodeURIComponent(firstName || '')}&date=${editionDate}&persona=${p || ''}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(newsletterName)} Preview - ${segment} - ${editionDate}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f5f5f5; }
    .preview-bar { background: ${palette.dark}; color: white; padding: 12px 20px; display: flex; align-items: center; gap: 16px; font-size: 14px; flex-wrap: wrap; }
    .preview-bar a { color: #93c5fd; text-decoration: none; }
    .preview-bar a:hover { text-decoration: underline; }
    .preview-bar .active { color: white; font-weight: 600; text-decoration: underline; }
    .preview-content { max-width: 640px; margin: 20px auto; padding: 20px; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .preview-bar label { font-weight: 600; }
  </style>
</head>
<body>
  <div class="preview-bar">
    <label>Segment:</label>
    ${(['website_only', 'both', 'slack_only', 'active'] as const).map((s) =>
      `<a href="?${params(s, personaCluster)}" class="${s === segment ? 'active' : ''}">${s}</a>`
    ).join(' ')}
    <span style="margin: 0 8px; color: #555;">|</span>
    <label>Persona:</label>
    ${(['', 'builder', 'strategist', 'newcomer'] as const).map((p) =>
      `<a href="?${params(segment, p || undefined)}" class="${(p || undefined) === personaCluster ? 'active' : ''}">${p || 'default'}</a>`
    ).join(' ')}
    <span style="margin-left: auto;">Status: ${escapeHtml(status)} | ${escapeHtml(editionDate)}</span>
  </div>
  <div class="preview-content">
    ${emailHtml}
  </div>
</body>
</html>`;
}
