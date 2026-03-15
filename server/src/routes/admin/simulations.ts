/**
 * Admin simulation routes
 *
 * Provides endpoints for running outreach simulations and
 * assessing historical behavior.
 *
 * Routes:
 * - GET /api/admin/simulations/personas       — List available simulation personas
 * - POST /api/admin/simulations/run           — Run simulations for selected personas
 * - GET /api/admin/simulations/assessment     — Historical behavior assessment
 */

import { Router } from 'express';
import { createLogger } from '../../logger.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';
import {
  PERSONAS,
  simulate,
  runAllSimulations,
  assessHistoricalBehavior,
} from '../../addie/services/outreach-simulator.js';

const logger = createLogger('admin-simulations');

export function setupSimulationRoutes(apiRouter: Router): void {

  // GET /api/admin/simulations/personas — List available personas
  apiRouter.get('/simulations/personas', requireAuth, requireAdmin, (_req, res) => {
    res.json({
      personas: PERSONAS.map((p, i) => ({
        index: i,
        name: p.name,
        description: p.description,
        stage: p.stage,
        hasSlack: p.hasSlack,
        hasEmail: p.hasEmail,
        responseBehavior: p.responseBehavior,
        company: p.company,
      })),
    });
  });

  // POST /api/admin/simulations/run — Run simulations
  apiRouter.post('/simulations/run', requireAuth, requireAdmin, (req, res) => {
    try {
      const durationDays = Math.max(1, Math.min(parseInt(req.body.durationDays) || 60, 365));
      const personaIndexes: number[] | undefined = req.body.personas;

      let results;
      if (personaIndexes && personaIndexes.length > 0) {
        results = personaIndexes
          .filter(i => i >= 0 && i < PERSONAS.length)
          .map(i => simulate(PERSONAS[i], durationDays));
      } else {
        results = runAllSimulations(durationDays);
      }

      res.json({ results, durationDays });
    } catch (error) {
      logger.error({ error }, 'Error running simulations');
      res.status(500).json({ error: 'Failed to run simulations' });
    }
  });

  // GET /api/admin/simulations/assessment — Historical behavior assessment
  apiRouter.get('/simulations/assessment', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const assessment = await assessHistoricalBehavior();
      res.json(assessment);
    } catch (error) {
      logger.error({ error }, 'Error assessing historical behavior');
      res.status(500).json({ error: 'Failed to assess behavior' });
    }
  });
}
