import type { Response } from 'express';
import { AAOAdminLookupUnavailableError } from '../addie/admin-status-lookup.js';
import { PlatformAdminToolPermissionDeniedError } from '../addie/admin-tool-boundary.js';

/** Shared deterministic unavailable/forbidden authorization responses. */
export function respondToAdminAuthorizationError(error: unknown, res: Response): boolean {
  if (error instanceof PlatformAdminToolPermissionDeniedError) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return true;
  }
  if (!(error instanceof AAOAdminLookupUnavailableError)) return false;
  res.setHeader('Retry-After', '5');
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({ error: error.code, message: error.message });
  return true;
}
