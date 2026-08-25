import { describe, expect, it } from 'vitest';
import type { ExecutionPlan } from '../../../src/addie/router.js';
import {
  OFFICIAL_DOCS_PROFILE,
  applyOfficialDocsProfile,
  hasOfficialDocsToolBoundary,
  normalizeReplayableSiResult,
  selectOfficialDocsCohort,
} from '../../../src/addie/jobs/shadow-replay-cohort.js';

const CHANNEL_ID = 'C_PUBLIC_DOCS';
const enabledEnv = {
  ADDIE_OFFICIAL_DOCS_COHORT_ENABLED: 'true',
  ADDIE_OFFICIAL_DOCS_COHORT_CHANNEL_IDS: `C_OTHER, ${CHANNEL_ID}`,
};

function plan(overrides: Partial<Extract<ExecutionPlan, { action: 'respond' }>> = {}) {
  return {
    action: 'respond' as const,
    tool_sets: ['knowledge'] as const,
    confidence: 'high' as const,
    requires_precision: false,
    requires_depth: false,
    reason: 'protocol documentation question',
    decision_method: 'quick_match' as const,
    latency_ms: 1,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL_ID,
    channelIsPublic: true,
    isAdmin: false,
    channelUsesDepthModel: false,
    plan: plan(),
    siRetrievalResult: null,
    ...overrides,
  } as Parameters<typeof selectOfficialDocsCohort>[0];
}

describe('official docs replay cohort', () => {
  it('admits only an explicitly allowlisted, public, bounded knowledge response', () => {
    const decision = selectOfficialDocsCohort(input(), enabledEnv);
    expect(decision).toMatchObject({
      eligible: true,
      reason: 'eligible',
      profile: OFFICIAL_DOCS_PROFILE,
    });
    expect(JSON.stringify(decision)).not.toContain(CHANNEL_ID);
    expect(applyOfficialDocsProfile(plan())).toMatchObject({
      capability_profile: OFFICIAL_DOCS_PROFILE,
      capability_profile_reason: 'eligible',
    });
  });

  it.each([
    ['disabled', {}, {}],
    ['channel_not_allowlisted', { channelId: 'C_NOT_ALLOWED' }, enabledEnv],
    ['channel_not_public', { channelIsPublic: false }, enabledEnv],
    ['admin_user', { isAdmin: true }, enabledEnv],
    ['not_high_confidence_knowledge', { plan: plan({ confidence: 'medium' }) }, enabledEnv],
    ['not_high_confidence_knowledge', { plan: plan({ tool_sets: ['community'] }) }, enabledEnv],
    ['specialized_model_required', { plan: plan({ requires_precision: true }) }, enabledEnv],
    ['specialized_model_required', { channelUsesDepthModel: true }, enabledEnv],
    [
      'si_context_present',
      {
        siRetrievalResult: {
          agents: [{
            slug: 'example',
            display_name: 'Example',
            tagline: null,
            description: null,
            offerings: [],
            relevance_score: 1,
          }],
          retrieval_time_ms: 1,
        },
      },
      enabledEnv,
    ],
  ])('rejects with %s when the boundary is not met', (reason, overrides, env) => {
    expect(selectOfficialDocsCohort(input(overrides), env)).toMatchObject({
      eligible: false,
      reason,
      profile: null,
    });
  });

  it('normalizes an empty SI result but retains substantive retrieval context', () => {
    expect(normalizeReplayableSiResult({ agents: [], retrieval_time_ms: 7 })).toBeNull();
    const substantive = {
      agents: [{
        slug: 'example',
        display_name: 'Example',
        tagline: null,
        description: null,
        offerings: [],
        relevance_score: 1,
      }],
      retrieval_time_ms: 1,
    };
    expect(normalizeReplayableSiResult(substantive)).toBe(substantive);
  });

  it('requires both canonical tools to exist on the shared production client', () => {
    const client = {
      hasRegisteredTools: (names: readonly string[]) =>
        names.length === 2 && names[0] === 'search_docs' && names[1] === 'get_doc',
    };
    expect(hasOfficialDocsToolBoundary(client)).toBe(true);
    expect(hasOfficialDocsToolBoundary({ hasRegisteredTools: () => false })).toBe(false);
    expect(hasOfficialDocsToolBoundary(null)).toBe(false);
  });
});
