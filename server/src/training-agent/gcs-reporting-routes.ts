import { Router } from 'express';
import { z } from 'zod';
import { AdcpError } from '@adcp/sdk/server';
import { getTrainingGcsReporting } from './gcs-reporting.js';

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const provisioning = z.object({ account_id: id, source_config_id: id, destination_ref: id }).strict();
const notifications = z.array(z.object({ subscriber_id: id, url: z.string().url().max(2048), event_types: z.array(z.enum(['reporting.ledger_changed', 'reporting.status_changed', 'reporting.delivery_ready'])).min(1).max(3), active: z.boolean().optional() }).strict()).max(2);

/** Mounted behind the training agent's existing transport authenticator. */
export function trainingGcsReportingRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/destinations', async (req, res) => {
    try {
      const input = provisioning.parse(req.body);
      const runtime = getTrainingGcsReporting();
      if (!runtime) return res.status(503).json({ error: 'REPORTING_DISABLED' });
      const grant = await runtime.provision(res.locals.trainingPrincipal, input.account_id, input.source_config_id, input.destination_ref);
      return res.status(200).json({ grant, buyer: await runtime.buyerConfiguration(res.locals.trainingPrincipal, input.account_id, input.destination_ref), capabilities: runtime.service.capabilities });
    } catch (error) { return fail(res, error); }
  });
  router.get('/destinations/:accountId/:destination', async (req, res) => {
    try {
      const runtime = getTrainingGcsReporting();
      if (!runtime) return res.status(503).json({ error: 'REPORTING_DISABLED' });
      const grant = await runtime.grant(res.locals.trainingPrincipal, id.parse(req.params.accountId), id.parse(req.params.destination), 1);
      if (!grant) return res.status(404).json({ error: 'ACCOUNT_NOT_FOUND' });
      return res.json({ grant, buyer: await runtime.buyerConfiguration(res.locals.trainingPrincipal, grant.account_id, grant.destination_ref) });
    } catch (error) { return fail(res, error); }
  });
  router.delete('/destinations/:accountId/:destination', async (req, res) => {
    try {
      const runtime = getTrainingGcsReporting();
      if (!runtime) return res.status(503).json({ error: 'REPORTING_DISABLED' });
      const revoked = await runtime.revoke(res.locals.trainingPrincipal, id.parse(req.params.accountId), id.parse(req.params.destination), 1);
      return res.json({ revoked });
    } catch (error) { return fail(res, error); }
  });
  router.put('/notifications/:accountId', async (req, res) => {
    try {
      const runtime = getTrainingGcsReporting();
      if (!runtime) return res.status(503).json({ error: 'REPORTING_DISABLED' });
      return res.json(await runtime.replaceNotifications(res.locals.trainingPrincipal, id.parse(req.params.accountId), notifications.parse(req.body)));
    } catch (error) { return fail(res, error); }
  });
  return router;
}

function fail(res: import('express').Response, error: unknown) {
  if (error instanceof z.ZodError) return res.status(400).json({ error: 'VALIDATION_ERROR' });
  if (error instanceof AdcpError) return res.status(error.code === 'ACCOUNT_NOT_FOUND' ? 404 : error.code === 'SERVICE_UNAVAILABLE' ? 503 : 400).json({ error: error.code, message: error.message });
  return res.status(503).json({ error: 'REPORTING_UNAVAILABLE' });
}
