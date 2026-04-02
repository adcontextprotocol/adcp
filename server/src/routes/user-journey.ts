import { Router } from 'express';
import { createLogger } from '../logger.js';
import { requireAuth } from '../middleware/auth.js';
import { assembleUserJourney } from '../services/user-journey.js';

const logger = createLogger('user-journey-routes');

export function createUserJourneyRouter(): Router {
  const router = Router();

  // GET /api/me/journey — personal journey data
  router.get('/', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const journey = await assembleUserJourney(userId);
      res.json(journey);
    } catch (error) {
      logger.error({ error }, 'Failed to load user journey');
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
