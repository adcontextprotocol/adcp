/** Trusted local storyboard processes may serve their generated source bundle.
 * Production and ordinary training-agent processes serve released contracts
 * only: the stable lines and, unless disabled, the published preview below.
 * This selects a wire release only; it does not enable experimental features. */
export function trainingAgentCandidateVersion(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.NODE_ENV !== 'test' || env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE !== '1') return undefined;
  const version = env.ADCP_TRAINING_CANDIDATE_VERSION;
  return version && /^3\.\d+(?:-(?:beta|rc)\.\d+)?$/.test(version) ? version : undefined;
}

export const TRAINING_AGENT_CANDIDATE_ADCP_VERSION = trainingAgentCandidateVersion();

/**
 * The published prerelease the hosted training agent serves as an opt-in
 * preview (#8181): wire value and the committed, immutable schema bundle
 * (`dist/schemas/<bundle>`) its responses validate against.
 *
 * It must name the prerelease the installed @adcp/sdk negotiates, or SDK
 * buyers settle on 3.2 instead: 17.0.0-beta.24 and later negotiate exactly
 * `3.3-beta.6`. Its published schemas must also match what the agent emits.
 * One preview is served at a time, so advance it with the SDK's bundled beta;
 * tenants/served-release-shape.test.ts grades the agent's preview responses
 * against this bundle, and training-agent-preview-version.test.ts checks
 * that the installed SDK selects it.
 */
export const TRAINING_AGENT_HOSTED_PREVIEW = Object.freeze({
  wireVersion: '3.3-beta.6',
  bundle: '3.3.0-beta.6',
} as const);

/** Ops kill switch: set to `1` or `true` to stop advertising and serving the
 * preview. Read at startup, so it takes effect on the next restart without a
 * code change. A process with the switch set negotiates exactly as one that
 * never listed the preview. */
export const TRAINING_AGENT_PREVIEW_KILL_SWITCH = 'TRAINING_AGENT_DISABLE_ADCP_PREVIEW';

export function trainingAgentPreviewDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[TRAINING_AGENT_PREVIEW_KILL_SWITCH]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * The one prerelease this process serves to callers that pin it exactly:
 * the trusted storyboard candidate when candidate mode is on, otherwise the
 * hosted preview unless the kill switch is set. Never served to unpinned,
 * major-only or release-pinned callers (versioning.mdx, "Pre-release pins").
 */
export function trainingAgentPreviewVersion(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const candidate = trainingAgentCandidateVersion(env);
  if (candidate) return candidate;
  return trainingAgentPreviewDisabled(env) ? undefined : TRAINING_AGENT_HOSTED_PREVIEW.wireVersion;
}

export const TRAINING_AGENT_PREVIEW_ADCP_VERSION = trainingAgentPreviewVersion();

/** Whether this process serves the published hosted preview (as opposed to a
 * local candidate, or no prerelease at all). */
export const TRAINING_AGENT_SERVES_HOSTED_PREVIEW = TRAINING_AGENT_PREVIEW_ADCP_VERSION !== undefined
  && TRAINING_AGENT_PREVIEW_ADCP_VERSION !== TRAINING_AGENT_CANDIDATE_ADCP_VERSION;

/** Whether an MCP request selects this process's preview by an exact pin: a
 * `tools/call` whose arguments carry it, or a `tools/list` that carries it in
 * params or `params._meta` (as @adcp/sdk sends it). */
export function requestPinsPreview(
  body: unknown,
  preview: string | undefined = TRAINING_AGENT_PREVIEW_ADCP_VERSION,
): boolean {
  if (!preview || !body || typeof body !== 'object') return false;
  const { method, params } = body as { method?: unknown; params?: Record<string, unknown> };
  if (!params || typeof params !== 'object') return false;
  if (method === 'tools/call') {
    const args = params.arguments as { adcp_version?: unknown } | undefined;
    return args?.adcp_version === preview;
  }
  if (method === 'tools/list') {
    const meta = params._meta as { adcp_version?: unknown } | undefined;
    return params.adcp_version === preview || meta?.adcp_version === preview;
  }
  return false;
}
