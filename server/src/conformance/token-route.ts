/**
 * REST surface for adopter-facing conformance tokens.
 *
 * `POST /api/conformance/token` issues a fresh JWT bound to the
 * caller's resolved WorkOS organization. The endpoint is authenticated
 * via the existing `requireAuth` middleware. The token is what an
 * adopter pastes into their `@adcp/conformance-client` config.
 *
 * `GET /api/conformance/_debug` lists active sessions (dev only).
 * Removed in production builds via NODE_ENV gate.
 */

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { resolveCallerOrgId } from '../routes/helpers/resolve-caller-org.js';
import { createLogger } from '../logger.js';
import { issueConformanceToken } from './token.js';
import { conformanceSessions } from './session-store.js';

const logger = createLogger('conformance-token-route');

function buildSocketUrl(req: Request): string {
  const explicit = process.env.CONFORMANCE_WS_PUBLIC_URL;
  if (explicit) return explicit;
  const host = req.get('host');
  const proto = req.protocol === 'https' ? 'wss' : 'ws';
  return `${proto}://${host}/conformance/connect`;
}

export function buildConformanceTokenRouter(): Router {
  const router = Router();

  router.post('/token', requireAuth, async (req: Request, res: Response) => {
    const orgId = await resolveCallerOrgId(req);
    if (!orgId) {
      res.status(403).json({
        error: 'no_organization',
        message:
          'A WorkOS organization is required to issue a conformance token. Sign in or pass an org-scoped credential.',
      });
      return;
    }

    let issued;
    try {
      issued = issueConformanceToken(orgId);
    } catch (err) {
      logger.error({ err }, 'conformance token issuance failed');
      res.status(500).json({
        error: 'token_issuance_failed',
        message: 'CONFORMANCE_JWT_SECRET is not configured on the server.',
      });
      return;
    }

    res.json({
      token: issued.token,
      url: buildSocketUrl(req),
      expires_at: issued.expiresAt,
      ttl_seconds: issued.ttlSeconds,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    router.get('/_debug', requireAuth, async (req: Request, res: Response) => {
      const orgId = await resolveCallerOrgId(req);
      res.json({
        callerOrgId: orgId,
        activeSessions: conformanceSessions.list(),
      });
    });
  }

  return router;
}
