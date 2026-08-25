import { z } from 'zod';
import { TOOL_REQUEST_SCHEMAS } from '@adcp/sdk/schemas';
import { customToolFor } from './custom-tool-helper.js';
import { handleListAccountChanges, handleListAccounts, handleSyncGovernance } from '../account-handlers.js';
import { resolveServedAdcpVersion } from '../task-handlers.js';
import { supportsAccountChangeFeed, type TrainingContext, type ToolArgs } from '../types.js';

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

export function listAccountChangesTool(storyboardCompat?: TrainingContext['storyboardCompat']) {
  return customToolFor(
    'list_account_changes',
    'List durable ordered changes to authoritative AdCP-visible state for one shared account. Use a latest checkpoint before snapshot bootstrap and drain after notifications.',
    {
      adcp_version: TOOL_REQUEST_SCHEMAS.list_accounts.shape.adcp_version,
      adcp_major_version: TOOL_REQUEST_SCHEMAS.list_accounts.shape.adcp_major_version,
      account: TOOL_REQUEST_SCHEMAS.list_accounts.shape.account.unwrap(),
      cursor: z.string().min(1).max(4096).optional(),
      starting_position: z.enum(['earliest', 'latest']).optional(),
      resource_types: z.array(
        z.string().min(1).max(100).regex(/^[a-z][a-z0-9_.-]{0,99}$/),
      ).min(1).max(50).refine(values => new Set(values).size === values.length, {
        message: 'resource_types must contain unique values',
      }).optional(),
      max_results: z.number().int().min(1).max(100).optional(),
      context: z.unknown().optional(),
      ext: z.unknown().optional(),
    },
    (args: ToolArgs, ctx: TrainingContext) => {
      const version = resolveServedAdcpVersion(args as unknown as Record<string, unknown>);
      if (!version.ok) {
        const error = {
          code: 'VERSION_UNSUPPORTED',
          message: version.message,
          field: version.field,
          details: version.details,
          recovery: 'correctable',
        };
        return {
          status: 'failed',
          adcp_error: error,
          errors: [error],
        };
      }
      if (!supportsAccountChangeFeed(version.servedVersion)) {
        const error = {
          code: 'UNSUPPORTED_FEATURE',
          message: 'list_account_changes requires AdCP 3.2 or later',
          field: 'adcp_version',
          details: { served_adcp_version: version.servedVersion },
          recovery: 'correctable',
        };
        return {
          status: 'failed',
          adcp_version: version.servedVersion,
          adcp_error: error,
          errors: [error],
        };
      }
      return {
        ...handleListAccountChanges(args, { ...ctx, servedAdcpVersion: version.servedVersion }) as Record<string, unknown>,
        adcp_version: version.servedVersion,
      };
    },
    {
      annotations: { readOnlyHint: true, idempotentHint: true },
      payloadErrorsAsSuccess: true,
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
