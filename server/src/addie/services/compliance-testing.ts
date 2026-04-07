import {
  testAllScenarios,
  DEFAULT_SCENARIOS,
  setAgentTesterLogger,
  type TestOptions,
  type TestResult,
  type TestScenario,
  type AgentProfile,
} from '@adcp/client/testing';

export { setAgentTesterLogger };

export type ComplianceTrack =
  | 'core'
  | 'products'
  | 'media_buy'
  | 'creative'
  | 'reporting'
  | 'governance'
  | 'campaign_governance'
  | 'signals'
  | 'si'
  | 'audiences';

export type PlatformType =
  | 'display_ad_server'
  | 'video_ad_server'
  | 'social_platform'
  | 'pmax_platform'
  | 'dsp'
  | 'retail_media'
  | 'search_platform'
  | 'audio_platform'
  | 'creative_transformer'
  | 'creative_library'
  | 'creative_ad_server'
  | 'si_platform'
  | 'ai_ad_network'
  | 'ai_platform'
  | 'generative_dsp';

export interface ComplyOptions extends TestOptions {
  tracks?: ComplianceTrack[];
  platform_type?: PlatformType;
  timeout_ms?: number;
  /** Limit to specific scenarios (e.g. from a storyboard). Bypasses track-based selection. */
  scenarios?: TestScenario[];
}

export interface PlatformProfile {
  label: string;
  expected_tracks: ComplianceTrack[];
  expected_tools: string[];
  expected_channels: string[];
}

export interface SampleBrief {
  name: string;
  vertical: string;
  brief: string;
}

export interface ComplianceObservation {
  severity: 'error' | 'warning' | 'suggestion' | 'info';
  category: string;
  message: string;
  evidence?: unknown;
}

export interface ComplianceTrackResult {
  track: ComplianceTrack;
  label: string;
  status: 'pass' | 'fail' | 'partial' | 'skip';
  scenarios: TestResult[];
  duration_ms: number;
}

export interface PlatformCoherenceFinding {
  severity: 'error' | 'warning' | 'suggestion' | 'info';
  expected: string;
  actual: string;
  guidance: string;
}

export interface PlatformCoherence {
  label: string;
  coherent: boolean;
  expected_tracks: ComplianceTrack[];
  missing_tracks: ComplianceTrack[];
  findings: PlatformCoherenceFinding[];
}

export interface ComplyResult {
  agent_profile: AgentProfile;
  tracks: ComplianceTrackResult[];
  summary: {
    headline: string;
    tracks_passed: number;
    tracks_failed: number;
    tracks_partial: number;
    tracks_skipped: number;
  };
  observations: ComplianceObservation[];
  total_duration_ms: number;
  dry_run: boolean;
  platform_coherence?: PlatformCoherence;
  v3_gate_failed?: boolean;
}

const TRACK_LABELS: Record<ComplianceTrack, string> = {
  core: 'Core protocol',
  products: 'Product discovery',
  media_buy: 'Media buy flow',
  creative: 'Creative workflows',
  reporting: 'Reporting',
  governance: 'Governance',
  campaign_governance: 'Campaign governance',
  signals: 'Signals',
  si: 'Sponsored intelligence',
  audiences: 'Audience sync',
};

export const TRACK_SCENARIOS: Record<ComplianceTrack, TestScenario[]> = {
  core: ['health_check', 'discovery', 'capability_discovery'],
  products: ['behavior_analysis', 'response_consistency', 'schema_compliance'],
  media_buy: [
    'create_media_buy',
    'full_sales_flow',
    'pricing_edge_cases',
    'error_handling',
    'validation',
    'temporal_validation',
  ],
  creative: ['creative_sync', 'creative_inline', 'creative_flow', 'creative_lifecycle'],
  reporting: ['deterministic_delivery'],
  governance: ['governance_property_lists', 'governance_content_standards', 'property_list_filters'],
  campaign_governance: [
    'campaign_governance',
    'campaign_governance_denied',
    'campaign_governance_conditions',
    'campaign_governance_delivery',
    'seller_governance_context',
  ],
  signals: ['signals_flow'],
  si: ['si_session_lifecycle', 'si_availability', 'si_handoff'],
  audiences: ['sync_audiences'],
};

export const SAMPLE_BRIEFS: SampleBrief[] = [
  {
    name: 'Retail launch brief',
    vertical: 'retail',
    brief: 'Retail brand launching a seasonal promotion and looking for broad-reach placements with product detail support and measurable sales outcomes.',
  },
  {
    name: 'Travel demand brief',
    vertical: 'travel',
    brief: 'Travel advertiser promoting summer bookings and seeking premium placements that can drive consideration and booking intent.',
  },
  {
    name: 'Finance acquisition brief',
    vertical: 'finance',
    brief: 'Financial services brand looking for compliant customer acquisition inventory with strong audience targeting and trusted environments.',
  },
  {
    name: 'Automotive launch brief',
    vertical: 'automotive',
    brief: 'Auto advertiser launching a new vehicle and looking for video and high-impact display inventory that can support awareness and dealer traffic.',
  },
  {
    name: 'Technology demand gen brief',
    vertical: 'technology',
    brief: 'B2B technology brand seeking qualified demand-generation inventory with audience targeting, premium editorial context, and measurable engagement.',
  },
];

const PLATFORM_PROFILES: Record<PlatformType, PlatformProfile> = {
  display_ad_server: {
    label: 'Display ad server',
    expected_tracks: ['core', 'products', 'media_buy'],
    expected_tools: ['get_products', 'create_media_buy'],
    expected_channels: ['display'],
  },
  video_ad_server: {
    label: 'Video ad server',
    expected_tracks: ['core', 'products', 'media_buy'],
    expected_tools: ['get_products', 'create_media_buy'],
    expected_channels: ['olv', 'ctv'],
  },
  social_platform: {
    label: 'Social platform',
    expected_tracks: ['core', 'products', 'media_buy', 'creative'],
    expected_tools: ['get_products', 'create_media_buy', 'sync_creatives'],
    expected_channels: ['social'],
  },
  pmax_platform: {
    label: 'Performance max platform',
    expected_tracks: ['core', 'products', 'media_buy', 'creative'],
    expected_tools: ['get_products', 'create_media_buy', 'sync_creatives'],
    expected_channels: ['display', 'olv', 'native'],
  },
  dsp: {
    label: 'DSP',
    expected_tracks: ['core', 'products', 'media_buy', 'audiences'],
    expected_tools: ['get_products', 'create_media_buy', 'sync_audiences'],
    expected_channels: ['display', 'olv', 'ctv', 'audio'],
  },
  retail_media: {
    label: 'Retail media platform',
    expected_tracks: ['core', 'products', 'media_buy', 'audiences'],
    expected_tools: ['get_products', 'create_media_buy', 'sync_audiences'],
    expected_channels: ['display', 'native'],
  },
  search_platform: {
    label: 'Search platform',
    expected_tracks: ['core', 'products', 'media_buy'],
    expected_tools: ['get_products', 'create_media_buy'],
    expected_channels: ['search'],
  },
  audio_platform: {
    label: 'Audio platform',
    expected_tracks: ['core', 'products', 'media_buy'],
    expected_tools: ['get_products', 'create_media_buy'],
    expected_channels: ['audio', 'podcast', 'streaming_audio'],
  },
  creative_transformer: {
    label: 'Creative transformer',
    expected_tracks: ['core', 'creative'],
    expected_tools: ['build_creative'],
    expected_channels: [],
  },
  creative_library: {
    label: 'Creative library',
    expected_tracks: ['core', 'creative'],
    expected_tools: ['build_creative'],
    expected_channels: [],
  },
  creative_ad_server: {
    label: 'Creative ad server',
    expected_tracks: ['core', 'creative'],
    expected_tools: ['build_creative', 'preview_creative'],
    expected_channels: ['display', 'olv'],
  },
  si_platform: {
    label: 'Sponsored intelligence platform',
    expected_tracks: ['core', 'si'],
    expected_tools: ['si_initiate_session'],
    expected_channels: [],
  },
  ai_ad_network: {
    label: 'AI ad network',
    expected_tracks: ['core', 'products', 'media_buy', 'creative'],
    expected_tools: ['get_products', 'create_media_buy', 'build_creative'],
    expected_channels: ['display', 'native', 'olv'],
  },
  ai_platform: {
    label: 'AI platform',
    expected_tracks: ['core', 'products', 'creative'],
    expected_tools: ['get_products', 'build_creative'],
    expected_channels: ['display', 'native'],
  },
  generative_dsp: {
    label: 'Generative DSP',
    expected_tracks: ['core', 'products', 'media_buy', 'creative', 'audiences'],
    expected_tools: ['get_products', 'create_media_buy', 'build_creative', 'sync_audiences'],
    expected_channels: ['display', 'native', 'olv', 'social'],
  },
};

export function getBriefsByVertical(vertical: string): SampleBrief[] {
  const normalized = vertical.trim().toLowerCase();
  return SAMPLE_BRIEFS.filter((brief) => brief.vertical === normalized);
}

export function getAllPlatformTypes(): PlatformType[] {
  return Object.keys(PLATFORM_PROFILES) as PlatformType[];
}

export function getPlatformProfile(platformType: PlatformType): PlatformProfile | undefined {
  return PLATFORM_PROFILES[platformType];
}

export function buildScenarioList(tracks?: ComplianceTrack[]): TestScenario[] {
  const requestedTracks = tracks?.length ? tracks : (Object.keys(TRACK_SCENARIOS) as ComplianceTrack[]);
  const scenarios = new Set<TestScenario>();
  for (const track of requestedTracks) {
    for (const scenario of TRACK_SCENARIOS[track]) {
      scenarios.add(scenario);
    }
  }
  // Start with DEFAULT_SCENARIOS order for shared scenarios, then append
  // track-specific scenarios that aren't in DEFAULT_SCENARIOS.
  const ordered = DEFAULT_SCENARIOS.filter((scenario) => scenarios.has(scenario));
  for (const scenario of scenarios) {
    if (!ordered.includes(scenario)) ordered.push(scenario);
  }
  return ordered;
}

function buildTrackResults(
  requestedTracks: ComplianceTrack[],
  scenarioResults: TestResult[],
): ComplianceTrackResult[] {
  const resultByScenario = new Map<TestScenario, TestResult>();
  for (const result of scenarioResults) {
    resultByScenario.set(result.scenario, result);
  }

  return requestedTracks.map((track) => {
    const scenarios = TRACK_SCENARIOS[track]
      .map((scenario) => resultByScenario.get(scenario))
      .filter((result): result is TestResult => Boolean(result));

    if (scenarios.length === 0) {
      return {
        track,
        label: TRACK_LABELS[track],
        status: 'skip',
        scenarios: [],
        duration_ms: 0,
      };
    }

    const passed = scenarios.filter((scenario) => scenario.overall_passed).length;
    const failed = scenarios.length - passed;
    let status: ComplianceTrackResult['status'];
    if (failed === 0) {
      status = 'pass';
    } else if (passed === 0) {
      status = 'fail';
    } else {
      status = 'partial';
    }

    return {
      track,
      label: TRACK_LABELS[track],
      status,
      scenarios,
      duration_ms: scenarios.reduce((sum, scenario) => sum + scenario.total_duration_ms, 0),
    };
  });
}

function buildObservations(trackResults: ComplianceTrackResult[]): ComplianceObservation[] {
  const observations: ComplianceObservation[] = [];

  for (const track of trackResults) {
    if (track.status === 'fail') {
      observations.push({
        severity: 'error',
        category: track.track,
        message: `${track.label} failed across all attempted scenarios.`,
      });
    } else if (track.status === 'partial') {
      observations.push({
        severity: 'warning',
        category: track.track,
        message: `${track.label} is only partially implemented.`,
      });
    }

    for (const scenario of track.scenarios) {
      const failedSteps = (scenario.steps ?? []).filter((step) => !step.passed);
      for (const step of failedSteps.slice(0, 2)) {
        observations.push({
          severity: 'warning',
          category: track.track,
          message: `${scenario.scenario}: ${step.step}${step.error ? ` — ${step.error}` : ''}`,
          evidence: step.response_preview,
        });
      }
    }
  }

  return observations;
}

function buildPlatformCoherence(
  platformType: PlatformType | undefined,
  trackResults: ComplianceTrackResult[],
): PlatformCoherence | undefined {
  if (!platformType) return undefined;

  const profile = getPlatformProfile(platformType);
  if (!profile) return undefined;

  const trackStatus = new Map(trackResults.map((track) => [track.track, track.status]));
  const missingTracks = profile.expected_tracks.filter((track) => {
    const status = trackStatus.get(track);
    return status === undefined || status === 'skip';
  });

  const findings: PlatformCoherenceFinding[] = [];
  for (const track of profile.expected_tracks) {
    const status = trackStatus.get(track);
    if (status === 'fail') {
      findings.push({
        severity: 'error',
        expected: `${TRACK_LABELS[track]} should pass`,
        actual: 'Track failed',
        guidance: `Prioritize the ${TRACK_LABELS[track].toLowerCase()} gaps before positioning this agent as a ${profile.label}.`,
      });
    } else if (status === 'partial') {
      findings.push({
        severity: 'warning',
        expected: `${TRACK_LABELS[track]} should be complete`,
        actual: 'Track is only partially passing',
        guidance: `Close the remaining ${TRACK_LABELS[track].toLowerCase()} gaps to align with ${profile.label} expectations.`,
      });
    }
  }

  return {
    label: profile.label,
    coherent: missingTracks.length === 0 && findings.length === 0,
    expected_tracks: profile.expected_tracks,
    missing_tracks: missingTracks,
    findings,
  };
}

const ALL_KNOWN_SCENARIOS = new Set<string>(
  (Object.values(TRACK_SCENARIOS) as TestScenario[][]).flat(),
);

/**
 * Filter an array of scenario name strings to only those that exist in TRACK_SCENARIOS.
 * Logs a warning for any unknown scenario names.
 */
export function filterToKnownScenarios(candidates: string[]): TestScenario[] {
  return candidates.filter((s) => ALL_KNOWN_SCENARIOS.has(s)) as TestScenario[];
}

/**
 * Reverse-map a set of scenarios to the tracks that contain them.
 */
function tracksForScenarios(scenarios: TestScenario[]): ComplianceTrack[] {
  const scenarioSet = new Set(scenarios);
  const tracks: ComplianceTrack[] = [];
  for (const [track, trackScenarios] of Object.entries(TRACK_SCENARIOS)) {
    if (trackScenarios.some((s) => scenarioSet.has(s))) {
      tracks.push(track as ComplianceTrack);
    }
  }
  return tracks;
}

export async function comply(agentUrl: string, options: ComplyOptions = {}): Promise<ComplyResult> {
  // When explicit scenarios are provided (e.g. from a storyboard), use them
  // directly and derive tracks by reverse-mapping.
  const scenarioList = options.scenarios ?? buildScenarioList(options.tracks);
  const requestedTracks = options.scenarios
    ? tracksForScenarios(options.scenarios)
    : options.tracks?.length
      ? options.tracks
      : (Object.keys(TRACK_SCENARIOS) as ComplianceTrack[]);

  const suite = await testAllScenarios(agentUrl, {
    ...options,
    scenarios: scenarioList,
  });

  const trackResults = buildTrackResults(requestedTracks, suite.results);
  const tracks_passed = trackResults.filter((track) => track.status === 'pass').length;
  const tracks_failed = trackResults.filter((track) => track.status === 'fail').length;
  const tracks_partial = trackResults.filter((track) => track.status === 'partial').length;
  const tracks_skipped = trackResults.filter((track) => track.status === 'skip').length;

  const observations = buildObservations(trackResults);
  const headline = `${tracks_passed} track${tracks_passed === 1 ? '' : 's'} passed, ${tracks_failed} failed, ${tracks_partial} partial, ${tracks_skipped} skipped`;

  // Hard-fail agents that do not support v3
  const agentVersion = suite.agent_profile.adcp_version;
  const v3GateFailed = !agentVersion || agentVersion === 'v2';
  if (v3GateFailed) {
    observations.push({
      severity: 'error',
      category: 'v3_readiness',
      message:
        'Agent does not support AdCP v3. Comply testing requires v3 protocol support. See the v3 readiness checklist: https://adcontextprotocol.org/docs/reference/migration/v3-readiness',
      evidence: { detected_version: agentVersion ?? 'unknown' },
    });
  }

  return {
    agent_profile: suite.agent_profile,
    tracks: trackResults,
    summary: {
      headline: v3GateFailed ? `v3 required — ${headline}` : headline,
      tracks_passed,
      tracks_failed,
      tracks_partial,
      tracks_skipped,
    },
    observations,
    total_duration_ms: suite.total_duration_ms,
    dry_run: suite.dry_run,
    platform_coherence: buildPlatformCoherence(options.platform_type, trackResults),
    v3_gate_failed: v3GateFailed || undefined,
  };
}
