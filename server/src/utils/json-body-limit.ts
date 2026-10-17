import { CREATIVE_FEATURES_VERIFIER_PATH } from '../training-agent/creative-features-verifier-path.js';

const SMALL_BODY_JSON_ROUTES = new Set([
  '/api/brands/resolve/bulk',
  '/api/json/validate-upload', // File bytes must arrive as bounded multipart input.
  // Native OAuth v2 carries only fixed-size state, PKCE, and grant fields.
  '/auth/native/start',
  '/auth/native/token',
]);

/** Mount prefix of the embedded training agent on the main app. */
const TRAINING_AGENT_MOUNT_PREFIX = '/api/training-agent';

/**
 * True for every spelling of the public, unauthenticated creative-features
 * verifier: bare on the training-agent host, and under the main app's
 * `/api/training-agent` mount. Express routing is case-insensitive and accepts
 * one trailing slash, so normalize both before comparing; an exact-string match
 * would let `/Governance/...` or `.../mcp/` fall through to the 10 MB default.
 */
function isCreativeFeaturesVerifierPath(path: string): boolean {
  let normalized = path.toLowerCase();
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized.startsWith(`${TRAINING_AGENT_MOUNT_PREFIX}/`)) {
    normalized = normalized.slice(TRAINING_AGENT_MOUNT_PREFIX.length);
  }
  return normalized === CREATIVE_FEATURES_VERIFIER_PATH;
}

/** Select a transport-level JSON cap before route handlers run. */
export function jsonBodyLimitForPath(path: string): string {
  if (/^\/api\/si\/sessions\/[^/]+\/messages(?:\/stream)?$/.test(path)) {
    return '32kb';
  }
  if (/^\/api\/addie\/chat\/[^/]+\/feedback$/.test(path)) {
    return '16kb';
  }
  // Public unauthenticated verifier: a manifest is a few KB.
  if (isCreativeFeaturesVerifierPath(path)) return '16kb';
  return SMALL_BODY_JSON_ROUTES.has(path) ? '16kb' : '10mb';
}
