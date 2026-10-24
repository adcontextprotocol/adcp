/**
 * Single source of truth for the public creative-features verifier's route
 * path. Kept dependency-free so transport middleware (CSRF, body limits) can
 * import it without pulling in the training-agent handler graph.
 */
export const CREATIVE_FEATURES_VERIFIER_PATH = '/governance/creative-features/mcp';
