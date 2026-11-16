import type { Request } from 'express';

/**
 * The signed-in admin's user id, or null when no person is behind the
 * request.
 *
 * `requireAdmin` also accepts the static `ADMIN_API_KEY` and API keys for
 * internal tooling. Actions recorded against an actor (registry moderation,
 * the enrichment cleanup) need a person, so they refuse those callers.
 */
export function humanAdminUserId(req: Request): string | null {
  const isStaticAdminKey = (req as Request & { isStaticAdminApiKey?: boolean }).isStaticAdminApiKey === true;
  const userId = req.user?.id;
  if (
    isStaticAdminKey
    || (req as Request & { apiKey?: unknown }).apiKey
    || !userId
    || userId === 'admin_api_key'
    || userId.startsWith('api_key_')
  ) {
    return null;
  }
  return userId;
}
