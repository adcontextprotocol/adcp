/** Trusted local storyboard processes may serve their generated source bundle.
 * Production and ordinary training-agent processes retain released contracts.
 * This selects a wire release only; it does not enable experimental features. */
export function trainingAgentCandidateVersion(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.NODE_ENV !== 'test' || env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE !== '1') return undefined;
  const version = env.ADCP_TRAINING_CANDIDATE_VERSION;
  return version && /^3\.\d+(?:-(?:beta|rc)\.\d+)?$/.test(version) ? version : undefined;
}

export const TRAINING_AGENT_CANDIDATE_ADCP_VERSION = trainingAgentCandidateVersion();
