import { z } from 'zod';
import { customToolFor } from './custom-tool-helper.js';
import { handleListAccounts } from '../account-handlers.js';
import type { TrainingContext } from '../types.js';

const ACCOUNT_REF_SCHEMA = z.union([
  z.object({
    account_id: z.string(),
  }),
  z.object({
    brand: z.object({
      domain: z.string(),
      brand_id: z.string().optional(),
    }),
    operator: z.string(),
    sandbox: z.boolean().optional(),
  }),
]);

function listAccountsSchema(storyboardCompat?: TrainingContext['storyboardCompat']) {
  return {
    ...(storyboardCompat?.version === '3.0' ? {} : { account: ACCOUNT_REF_SCHEMA.optional() }),
    status: z.enum(['active', 'pending_approval', 'rejected', 'payment_required', 'suspended', 'closed']).optional(),
    sandbox: z.boolean().optional(),
    pagination: z.object({
      max_results: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }).optional(),
    idempotency_key: z.string().optional(),
    context: z.any().optional(),
    ext: z.any().optional(),
  };
}

export function listAccountsTool(storyboardCompat?: TrainingContext['storyboardCompat']) {
  return customToolFor(
    'list_accounts',
    'List accounts accessible to the authenticated agent. Supports status and sandbox filtering with cursor-based pagination.',
    listAccountsSchema(storyboardCompat),
    handleListAccounts,
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
  );
}
