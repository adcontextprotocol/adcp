import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { BrandManager } from '../brand-manager.js';
import { createLogger } from '../logger.js';
import {
  INVALID_DOMAIN_MESSAGE, LOOKUP_BUSY_MESSAGE, InvalidTrustLookupDomain, TrustLookupBusy, TrustLookupService,
} from '../services/trust-lookup.js';

const logger = createLogger('trust-lookup-route');

export function createTrustLookupRouter(config: {
  brandManager: BrandManager;
  service?: Pick<TrustLookupService, 'lookup'>;
}): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const service = config.service ?? new TrustLookupService(config.brandManager);
  const limit = rateLimit({
    windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many lookups. Try again in a minute.' },
  });
  router.get('/lookup', limit, async (req, res) => {
    if (typeof req.query.domain !== 'string') return res.status(400).json({ error: 'Enter a brand domain.' });
    try {
      return res.json(await service.lookup(req.query.domain));
    } catch (error) {
      if (error instanceof InvalidTrustLookupDomain) return res.status(400).json({ error: INVALID_DOMAIN_MESSAGE });
      if (error instanceof TrustLookupBusy) {
        res.setHeader('Retry-After', '10');
        return res.status(503).json({ error: LOOKUP_BUSY_MESSAGE });
      }
      logger.error({ err: error }, 'Trust lookup failed');
      return res.status(500).json({ error: 'The lookup could not be completed. Try again later.' });
    }
  });
  return router;
}
