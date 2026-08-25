import { TOOL_REQUEST_SCHEMAS } from '@adcp/sdk/schemas';
import { customToolFor } from './custom-tool-helper.js';
import { handleListAccounts, handleSyncGovernance } from '../account-handlers.js';
import type { TrainingContext } from '../types.js';

const SYNC_GOVERNANCE_SCHEMA = TOOL_REQUEST_SCHEMAS.sync_governance.shape;

function listAccountsSchema(storyboardCompat?: TrainingContext['storyboardCompat']) {
  const { account, ...baseShape } = TOOL_REQUEST_SCHEMAS.list_accounts.shape;
  return storyboardCompat?.version === '3.0'
    ? baseShape
    : { ...baseShape, account };
}

export function listAccountsTool(storyboardCompat?: TrainingContext['storyboardCompat']) {
  return customToolFor(
    'list_accounts',
    'List accounts accessible to the authenticated agent. Supports status and sandbox filtering with cursor-based pagination.',
    listAccountsSchema(storyboardCompat),
    handleListAccounts,
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
      ...(storyboardCompat && { trainingContext: { storyboardCompat } }),
    },
  );
}

export function syncGovernanceTool(storyboardCompat?: TrainingContext['storyboardCompat']) {
  return customToolFor(
    'sync_governance',
    'Register one governance agent endpoint on each account. Uses replace semantics and supplies the relationship used to require signed authorization before governed commitments.',
    SYNC_GOVERNANCE_SCHEMA,
    handleSyncGovernance,
    {
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      enforceIdempotency: true,
      ...(storyboardCompat && { trainingContext: { storyboardCompat } }),
    },
  );
}
