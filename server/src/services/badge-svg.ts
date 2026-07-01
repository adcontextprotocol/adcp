/**
 * SVG badge rendering for AAO Verified agents.
 *
 * Generates shields.io-style badges: "AAO Verified | Media Buy Agent 3.0 (Spec)"
 * with the AAO teal color scheme.
 *
 * The version segment between the role and the qualifier conveys *which AdCP
 * release* the badge was issued against (3.0, 3.1, ...). The qualifier in
 * parens conveys *which axes of verification* the agent has earned: (Spec)
 * means protocol storyboards pass, (Live) means AAO has observed real
 * production traffic via canonical campaigns. An agent can have either or
 * both, e.g. "(Spec + Live)". An empty modes array renders "Not Verified".
 */

import { VERIFICATION_MODES, isVerificationMode } from './adcp-taxonomy.js';

/**
 * Shape constraint for AdCP versions in badge labels. Same regex the JWT
 * signer enforces — a poisoned DB row that smuggled a non-MAJOR.MINOR
 * value drops the version from the rendered label rather than letting
 * arbitrary text reach a public-facing image. The badge still renders
 * (verified-without-version) so a degraded DB row doesn't blank a buyer's
 * embedded badge — that's the security/UX trade-off for this surface,
 * versus the JWT signer which fails closed.
 */
const ADCP_VERSION_RE = /^[1-9][0-9]*\.[0-9]+$/;

// Re-exported for backward compatibility — canonical home is adcp-taxonomy.ts.
export { VERIFICATION_MODES };
export type { VerificationMode } from './adcp-taxonomy.js';

const AAO_TEAL = '#076D63'; // WCAG AA contrast ≥ 4.5:1 against white
const LABEL_BG = '#555';
const NOT_VERIFIED_BG = '#6b7280'; // WCAG AA contrast ≥ 4.5:1 against white
const FONT_SIZE = 11;
const PADDING = 8;
const BADGE_HEIGHT = 20;

// Badge roles = AdCP protocols that have shipped specialism storyboards
// and a corresponding DB CHECK constraint (migration 453). Newer protocols
// like `measurement` join this list once their storyboards ship.
export const VALID_BADGE_ROLES = [
  'media-buy',
  'creative',
  'signals',
  'governance',
  'brand',
  'sponsored-intelligence',
] as const;

const ROLE_LABELS: Record<string, string> = {
  'media-buy': 'Media Buy Agent',
  'creative': 'Creative Agent',
  'signals': 'Signals Agent',
  'governance': 'Governance Agent',
  'brand': 'Brand Agent',
  'sponsored-intelligence': 'SI Agent',
};

// Per-character width table for Verdana 11px (from font metrics).
// Shields.io uses a similar approach for accurate text measurement.
const VERDANA_11_WIDTHS: Record<string, number> = {
  A: 7.51, B: 7.31, C: 7.18, D: 7.78, E: 6.74, F: 6.2, G: 7.85,
  H: 7.78, I: 4.46, J: 5.07, K: 7.31, L: 6.2, M: 8.72, N: 7.78,
  O: 7.85, P: 6.74, Q: 7.85, R: 7.51, S: 7.18, T: 6.67, U: 7.78,
  V: 7.51, W: 10.22, X: 7.31, Y: 6.67, Z: 6.67,
  a: 6.14, b: 6.54, c: 5.47, d: 6.54, e: 6.14, f: 3.67, g: 6.54,
  h: 6.6, i: 2.87, j: 3.67, k: 6.07, l: 2.87, m: 10.0, n: 6.6,
  o: 6.34, p: 6.54, q: 6.54, r: 4.34, s: 5.47, t: 3.93, u: 6.6,
  v: 6.07, w: 8.47, x: 6.07, y: 6.07, z: 5.47,
  ' ': 3.47,
};

function measureText(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += VERDANA_11_WIDTHS[ch] ?? 6.5;
  }
  return Math.ceil(width) + PADDING * 2;
}

function escapeXml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

/**
 * Format verification modes for badge display.
 * Always renders Spec before Live; unknown modes are dropped (defense in
 * depth — corrupted DB rows or third-party-injected modes don't reach
 * public badge text). The signed JWT is filtered the same way upstream.
 *
 *   formatModes(['spec'])         → 'Spec'
 *   formatModes(['spec', 'live']) → 'Spec + Live'
 *   formatModes([])               → ''
 *   formatModes(['platinum'])     → '' (unknown mode dropped)
 */
function formatModes(modes: readonly string[]): string {
  const ordered: string[] = [];
  for (const known of VERIFICATION_MODES) {
    if (modes.includes(known)) ordered.push(known);
  }
  return ordered
    .map(m => m.charAt(0).toUpperCase() + m.slice(1))
    .join(' + ');
}

export interface RenderBadgeSvgOptions {
  /**
   * AdCP release this badge was issued against, MAJOR.MINOR (e.g. '3.0').
   * Embeds in the message as `Media Buy Agent 3.0 (Spec)`. Validated
   * against the same regex as the DB CHECK and JWT signer; a malformed
   * value renders without the version segment rather than failing the
   * whole image (#3524 stage 3).
   */
  adcpVersion?: string;
}

export function renderBadgeSvg(
  role: string,
  modes: readonly string[] = [],
  options: RenderBadgeSvgOptions = {},
): string {
  // Filter to known modes — unknown values from corrupted DB rows or
  // tampered input don't reach public badge text.
  const safeModes = modes.filter(isVerificationMode);
  const label = 'AAO Verified';
  const isVerified = safeModes.length > 0;
  const roleLabel = ROLE_LABELS[role] || escapeXml(role);
  const qualifier = formatModes(safeModes);
  // Same shape filter as the JWT signer. A malformed adcp_version drops
  // from the rendered label without failing the badge — degraded display
  // is acceptable for an embedded SVG, where a missing image would be
  // worse for the buyer.
  const safeVersion = options.adcpVersion && ADCP_VERSION_RE.test(options.adcpVersion)
    ? options.adcpVersion
    : undefined;
  // Role + optional version: "Media Buy Agent" or "Media Buy Agent 3.0".
  const verifiedRoleSegment = safeVersion ? `${roleLabel} ${safeVersion}` : roleLabel;
  const message = isVerified
    ? (qualifier ? `${verifiedRoleSegment} (${qualifier})` : verifiedRoleSegment)
    : 'Not Verified';
  const messageBg = isVerified ? AAO_TEAL : NOT_VERIFIED_BG;
  const idSuffix = `${escapeXml(role)}-${isVerified ? 'v' : 'nv'}`;

  const labelWidth = measureText(label);
  const msgWidth = measureText(message);
  const totalWidth = labelWidth + msgWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${BADGE_HEIGHT}" role="img" aria-label="${escapeXml(label)}: ${escapeXml(message)}">
  <title>${escapeXml(label)}: ${escapeXml(message)}</title>
  <desc>AAO verification badge showing ${escapeXml(message)} status</desc>
  <linearGradient id="s-${idSuffix}" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r-${idSuffix}"><rect width="${totalWidth}" height="${BADGE_HEIGHT}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r-${idSuffix})">
    <rect width="${labelWidth}" height="${BADGE_HEIGHT}" fill="${LABEL_BG}"/>
    <rect x="${labelWidth}" width="${msgWidth}" height="${BADGE_HEIGHT}" fill="${messageBg}"/>
    <rect width="${totalWidth}" height="${BADGE_HEIGHT}" fill="url(#s-${idSuffix})"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="${FONT_SIZE}">
    <text x="${labelWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="13">${escapeXml(label)}</text>
    <text x="${labelWidth + msgWidth / 2}" y="14" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>
    <text x="${labelWidth + msgWidth / 2}" y="13">${escapeXml(message)}</text>
  </g>
</svg>`;
}
