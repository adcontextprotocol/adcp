/**
 * SVG badge rendering for AAO Verified agents.
 *
 * Generates shields.io-style badges: "AAO Verified | Media Buy Agent"
 * with the AAO teal color scheme.
 */

import { ADCP_DOMAINS } from './adcp-taxonomy.js';

const AAO_TEAL = '#076D63'; // WCAG AA contrast ≥ 4.5:1 against white
const LABEL_BG = '#555';
const NOT_VERIFIED_BG = '#6b7280'; // WCAG AA contrast ≥ 4.5:1 against white
const FONT_SIZE = 11;
const PADDING = 8;
const BADGE_HEIGHT = 20;

// Badge roles = AdCP domains. Sourced from enums/adcp-domain.json via adcp-taxonomy.
export const VALID_BADGE_ROLES = ADCP_DOMAINS;

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

export function renderBadgeSvg(role: string, verified: boolean): string {
  const label = 'AAO Verified';
  const message = verified ? (ROLE_LABELS[role] || escapeXml(role)) : 'Not Verified';
  const messageBg = verified ? AAO_TEAL : NOT_VERIFIED_BG;
  const idSuffix = `${escapeXml(role)}-${verified ? 'v' : 'nv'}`;

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
