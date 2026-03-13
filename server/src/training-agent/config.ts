/** Resolve the agent URL for format references and catalog links. */
export function getAgentUrl(): string {
  return (
    process.env.TRAINING_AGENT_URL ||
    process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || process.env.CONDUCTOR_PORT || '3000'}`
  ).replace(/\/$/, '') + '/api/training-agent';
}
