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

    // Dev-only storyboard trigger — lets a local smoke harness exercise
    // the full PR #2 path (runStoryboardViaConformanceSocket) without
    // needing the Addie chat surface. Production builds skip this entire
    // block.
    //
    // Tenant scoping: normal authenticated callers (WorkOS users / API
    // keys) MUST run against their own resolved org. The static admin
    // API key (which has no tenant binding) is allowed to drive any
    // connected session by supplying `org_id` in the body — this is the
    // intended escape hatch for local smoke tools. Any user reaching
    // this endpoint is already on a non-production deployment with the
    // static admin key configured; the smoke-tool privilege is
    // consistent with the rest of the surface admin already touches.
    router.post('/_debug/run-storyboard', requireAuth, async (req: Request, res: Response) => {
      const isStaticAdmin = (req as Request & { isStaticAdminApiKey?: boolean })
        .isStaticAdminApiKey === true;
      const callerOrgId = await resolveCallerOrgId(req);
      const bodyOrgId = typeof req.body?.org_id === 'string' ? req.body.org_id : null;

      let targetOrgId: string;
      if (isStaticAdmin) {
        if (!bodyOrgId) {
          res.status(400).json({ error: 'org_id required for admin smoke' });
          return;
        }
        targetOrgId = bodyOrgId;
      } else {
        if (!callerOrgId) {
          res.status(403).json({ error: 'no_organization' });
          return;
        }
        if (bodyOrgId && bodyOrgId !== callerOrgId) {
          res.status(403).json({ error: 'forbidden', message: 'org_id must match caller' });
          return;
        }
        targetOrgId = callerOrgId;
      }

      const storyboardId = typeof req.body?.storyboard_id === 'string' ? req.body.storyboard_id : null;
      if (!storyboardId) {
        res.status(400).json({ error: 'storyboard_id required' });
        return;
      }
      try {
        const { runStoryboardViaConformanceSocket } = await import('./run-storyboard-via-ws.js');
        const result = await runStoryboardViaConformanceSocket(targetOrgId, storyboardId);
        res.json(result);
      } catch (err) {
        logger.error({ err, targetOrgId, storyboardId }, 'debug run-storyboard failed');
        res.status(500).json({ error: 'run_failed' });
      }
    });
  }

  return router;
}
