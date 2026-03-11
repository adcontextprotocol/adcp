/**
 * Deterministic alignment checks for geo, channel, flight dates, and seller authorization.
 *
 * No LLM needed — these are structural validations against the plan.
 */

import type { GovernancePlan, Finding } from '../db/governance-db.js';

/**
 * Check geographic alignment between action and plan.
 */
export function checkGeoAlignment(
  plan: GovernancePlan,
  targetCountries?: string[],
  targetRegions?: string[]
): Finding[] {
  const findings: Finding[] = [];

  if (plan.countries.length === 0 && plan.regions.length === 0) {
    return findings; // No geo restrictions
  }

  // Check countries
  if (targetCountries && targetCountries.length > 0 && plan.countries.length > 0) {
    const unauthorized = targetCountries.filter(c => !plan.countries.includes(c));
    if (unauthorized.length > 0) {
      findings.push({
        category_id: 'strategic_alignment',
        severity: 'critical',
        explanation: `Targeting unauthorized countries: ${unauthorized.join(', ')}. Authorized: ${plan.countries.join(', ')}.`,
      });
    }
  }

  // Check regions
  if (targetRegions && targetRegions.length > 0 && plan.regions.length > 0) {
    const unauthorized = targetRegions.filter(r => !plan.regions.includes(r));
    if (unauthorized.length > 0) {
      findings.push({
        category_id: 'strategic_alignment',
        severity: 'critical',
        explanation: `Targeting unauthorized regions: ${unauthorized.join(', ')}. Authorized: ${plan.regions.join(', ')}.`,
      });
    }
  }

  return findings;
}

/**
 * Check channel alignment between action and plan.
 */
export function checkChannelAlignment(
  plan: GovernancePlan,
  targetChannels?: string[]
): Finding[] {
  if (!targetChannels || targetChannels.length === 0) return [];

  const findings: Finding[] = [];
  const allowedChannels = new Set([
    ...plan.channels_required,
    ...plan.channels_allowed,
  ]);

  // If no channel restrictions, all channels are allowed
  if (allowedChannels.size === 0) return [];

  const unauthorized = targetChannels.filter(c => !allowedChannels.has(c));
  if (unauthorized.length > 0) {
    findings.push({
      category_id: 'strategic_alignment',
      severity: 'critical',
      explanation: `Targeting unauthorized channels: ${unauthorized.join(', ')}. Allowed: ${[...allowedChannels].join(', ')}.`,
    });
  }

  return findings;
}

/**
 * Check flight date alignment.
 */
export function checkFlightAlignment(
  plan: GovernancePlan,
  startTime?: string,
  endTime?: string
): Finding[] {
  const findings: Finding[] = [];

  if (startTime) {
    const actionStart = new Date(startTime);
    if (actionStart < plan.flight_start) {
      findings.push({
        category_id: 'strategic_alignment',
        severity: 'warning',
        explanation: `Action start date (${startTime}) is before plan flight start (${plan.flight_start.toISOString()}).`,
      });
    }
  }

  if (endTime) {
    const actionEnd = new Date(endTime);
    if (actionEnd > plan.flight_end) {
      findings.push({
        category_id: 'strategic_alignment',
        severity: 'warning',
        explanation: `Action end date (${endTime}) extends beyond plan flight end (${plan.flight_end.toISOString()}).`,
      });
    }
  }

  return findings;
}

/**
 * Check seller authorization.
 * Compares by hostname when the seller value is a URL, or by exact match for domains.
 */
export function checkSellerAuthorization(
  plan: GovernancePlan,
  sellerUrl?: string
): Finding[] {
  if (!plan.approved_sellers || !sellerUrl) return [];

  // Extract hostname from URL, or use as-is if it's a bare domain
  let sellerHost: string;
  try {
    sellerHost = new URL(sellerUrl).hostname;
  } catch {
    sellerHost = sellerUrl.toLowerCase();
  }

  const findings: Finding[] = [];
  const isApproved = plan.approved_sellers.some(s => {
    try {
      return new URL(s).hostname === sellerHost;
    } catch {
      return s.toLowerCase() === sellerHost || sellerHost.endsWith(`.${s.toLowerCase()}`);
    }
  });

  if (!isApproved) {
    findings.push({
      category_id: 'seller_verification',
      severity: 'critical',
      explanation: `Seller ${sellerUrl} is not in the approved sellers list.`,
    });
  }

  return findings;
}

/**
 * Extract geo, channel, and timing info from a payload or planned delivery.
 */
export function extractActionContext(
  payload?: Record<string, unknown>,
  plannedDelivery?: Record<string, unknown>
): {
  countries?: string[];
  regions?: string[];
  channels?: string[];
  startTime?: string;
  endTime?: string;
  sellerUrl?: string;
} {
  const source = plannedDelivery || payload;
  if (!source) return {};

  const geo = source.geo as { countries?: string[]; regions?: string[] } | undefined;

  return {
    countries: geo?.countries || (source.countries as string[] | undefined),
    regions: geo?.regions || (source.regions as string[] | undefined),
    channels: source.channels as string[] | undefined,
    startTime: source.start_time as string | undefined,
    endTime: source.end_time as string | undefined,
    sellerUrl: (payload?.seller_url || payload?.seller) as string | undefined,
  };
}
