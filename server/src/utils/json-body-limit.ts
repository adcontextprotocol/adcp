const SMALL_BODY_JSON_ROUTES = new Set([
  '/api/brands/resolve/bulk',
  // Native OAuth v2 carries only fixed-size state, PKCE, and grant fields.
  '/auth/native/start',
  '/auth/native/token',
]);

/** Select a transport-level JSON cap before route handlers run. */
export function jsonBodyLimitForPath(path: string): string {
  if (/^\/api\/si\/sessions\/[^/]+\/messages(?:\/stream)?$/.test(path)) {
    return '32kb';
  }
  if (/^\/api\/addie\/chat\/[^/]+\/feedback$/.test(path)) {
    return '16kb';
  }
  return SMALL_BODY_JSON_ROUTES.has(path) ? '16kb' : '10mb';
}
