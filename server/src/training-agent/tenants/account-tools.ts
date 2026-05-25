import { z } from 'zod';
import { customToolFor } from './custom-tool-helper.js';
import { handleListAccounts } from '../account-handlers.js';

const LIST_ACCOUNTS_SCHEMA = {
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

export function listAccountsTool() {
  return customToolFor(
    'list_accounts',
    'List accounts accessible to the authenticated agent. Supports status and sandbox filtering with cursor-based pagination.',
    LIST_ACCOUNTS_SCHEMA,
    handleListAccounts,
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
      responseSummary: (result) => {
        const accounts = Array.isArray(result.accounts) ? result.accounts.length : 0;
        return `Found ${accounts} accounts`;
      },
    },
  );
}
