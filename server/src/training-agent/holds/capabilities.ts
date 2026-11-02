/**
 * get_adcp_capabilities for the experimental 3.3 holds (holds/service.ts):
 * the four feature ids in `experimental_features`, the
 * `media_buy.proposal_refinement.hold_extension` gate for `extend_hold`, and
 * the `force_hold_unavailable` controller scenario. Declared only where the
 * hold surfaces are served: a 3.3 caller on the sales tenant's default
 * routes.
 */

import type { TrainingContext } from '../types.js';
import { FORCE_HOLD_UNAVAILABLE, HOLD_FEATURES, holdsServed } from './service.js';

interface CapabilitiesView {
  experimental_features?: unknown;
  media_buy?: Record<string, unknown>;
  compliance_testing?: Record<string, unknown>;
}

export function applyHoldCapabilities(
  structured: CapabilitiesView,
  servedVersion: string | undefined,
  proposalNegotiationProfile: TrainingContext['proposalNegotiationProfile'] | undefined,
  storyboardCompat: TrainingContext['storyboardCompat'] | undefined,
): void {
  if (!holdsServed({ servedAdcpVersion: servedVersion, proposalNegotiationProfile, storyboardCompat })) return;
  const features = Array.isArray(structured.experimental_features)
    ? structured.experimental_features.filter((feature): feature is string => typeof feature === 'string')
    : [];
  for (const feature of HOLD_FEATURES) if (!features.includes(feature)) features.push(feature);
  structured.experimental_features = features;
  const mediaBuy = structured.media_buy ?? {};
  const refinement = mediaBuy.proposal_refinement && typeof mediaBuy.proposal_refinement === 'object'
    ? mediaBuy.proposal_refinement as Record<string, unknown>
    : { supported_dimensions: [] };
  mediaBuy.proposal_refinement = { ...refinement, hold_extension: true };
  structured.media_buy = mediaBuy;
  const testing = structured.compliance_testing ?? {};
  const scenarios = Array.isArray(testing.scenarios)
    ? testing.scenarios.filter((scenario): scenario is string => typeof scenario === 'string')
    : [];
  if (!scenarios.includes(FORCE_HOLD_UNAVAILABLE)) scenarios.push(FORCE_HOLD_UNAVAILABLE);
  structured.compliance_testing = { ...testing, scenarios };
}
