import type { RequestHandler } from 'express';
import { IdentityMutationDisabledError } from '../db/identity-mutation-policy.js';

/** Refuse after authentication, before any provider or local mutation. */
export const refuseIdentityConsolidation: RequestHandler = (_req, res) => {
  const error = new IdentityMutationDisabledError();
  res.status(409).json({ error: error.code, message: error.message });
};
