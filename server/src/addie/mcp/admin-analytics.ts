import { ToolError } from '../tool-error.js';
import type { AddieTool } from '../types.js';

export const ADMIN_ANALYTICS_TOOL_NAME = 'query_admin_analytics';

export const ADMIN_ANALYTICS_TOOL: AddieTool = {
  name: 'query_admin_analytics',
  description:
    'Query one read-only administrative analytics view: platform totals, member-search performance, organizations ranked by user count, or people ranked by engagement.',
  usage_hints:
    'Use platform_stats for platform-wide people/organization counts; member_search for search and introduction analytics; organizations_by_users for organization rankings; users_by_engagement for contributor and community-engagement rankings.',
  input_schema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: [
          'platform_stats',
          'member_search',
          'organizations_by_users',
          'users_by_engagement',
        ],
        description: 'Administrative analytics view to query.',
      },
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 365,
        description: 'member_search only: days to look back (default 30).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Ranking views only: maximum rows to return.',
      },
      member_status: {
        type: 'string',
        enum: ['member', 'prospect', 'churned', 'all'],
        description: 'organizations_by_users only: organization status filter.',
      },
      min_users: {
        type: 'integer',
        minimum: 1,
        maximum: 1_000_000,
        description: 'organizations_by_users only: minimum users per organization.',
      },
      stage: {
        type: 'string',
        enum: [
          'prospect',
          'welcomed',
          'exploring',
          'participating',
          'contributing',
          'leading',
          'all',
        ],
        description: 'users_by_engagement only: relationship-stage filter.',
      },
      member_only: {
        type: 'boolean',
        description: 'users_by_engagement only: include only paying-member organizations.',
      },
      membership_tier: {
        type: 'string',
        enum: ['individual', 'company', 'all'],
        description: 'users_by_engagement only: membership-tier filter.',
      },
      include_breakdown: {
        type: 'boolean',
        description: 'users_by_engagement only: include points by action type.',
      },
    },
    required: ['view'],
    additionalProperties: false,
  },
};

type AdminAnalyticsView =
  | 'platform_stats'
  | 'member_search'
  | 'organizations_by_users'
  | 'users_by_engagement';

type AdminToolHandler = (input: Record<string, unknown>) => Promise<string>;

const VIEW_HANDLERS: Readonly<Record<AdminAnalyticsView, string>> = {
  platform_stats: 'get_platform_stats',
  member_search: 'get_member_search_analytics',
  organizations_by_users: 'list_organizations_by_users',
  users_by_engagement: 'list_users_by_engagement',
};

const VIEW_FIELDS: Readonly<Record<AdminAnalyticsView, ReadonlySet<string>>> = {
  platform_stats: new Set(['view']),
  member_search: new Set(['view', 'days']),
  organizations_by_users: new Set(['view', 'limit', 'member_status', 'min_users']),
  users_by_engagement: new Set([
    'view',
    'limit',
    'stage',
    'member_only',
    'membership_tier',
    'include_breakdown',
  ]),
};

function requireInteger(
  input: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): void {
  const value = input[field];
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ToolError(`${field} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function requireEnum(
  input: Record<string, unknown>,
  field: string,
  values: readonly string[],
): void {
  const value = input[field];
  if (value === undefined) return;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ToolError(`${field} is not valid for the selected analytics view.`);
  }
}

function requireBoolean(input: Record<string, unknown>, field: string): void {
  const value = input[field];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ToolError(`${field} must be a boolean.`);
  }
}

export function resolveAdminAnalyticsInvocation(input: Record<string, unknown>): {
  handlerName: string;
  handlerInput: Record<string, unknown>;
} {
  const view = input.view;
  if (
    typeof view !== 'string'
    || !Object.prototype.hasOwnProperty.call(VIEW_HANDLERS, view)
  ) {
    throw new ToolError('view must select a supported administrative analytics view.');
  }

  const typedView = view as AdminAnalyticsView;
  const allowedFields = VIEW_FIELDS[typedView];
  if (Object.keys(input).some((field) => !allowedFields.has(field))) {
    throw new ToolError('Input contains fields that are not supported by the selected analytics view.');
  }

  switch (typedView) {
    case 'platform_stats':
      break;
    case 'member_search':
      requireInteger(input, 'days', 1, 365);
      break;
    case 'organizations_by_users':
      requireInteger(input, 'limit', 1, 100);
      requireInteger(input, 'min_users', 1, 1_000_000);
      requireEnum(input, 'member_status', ['member', 'prospect', 'churned', 'all']);
      break;
    case 'users_by_engagement':
      requireInteger(input, 'limit', 1, 100);
      requireEnum(input, 'stage', [
        'prospect',
        'welcomed',
        'exploring',
        'participating',
        'contributing',
        'leading',
        'all',
      ]);
      requireBoolean(input, 'member_only');
      requireEnum(input, 'membership_tier', ['individual', 'company', 'all']);
      requireBoolean(input, 'include_breakdown');
      break;
  }

  const { view: _view, ...handlerInput } = input;
  return { handlerName: VIEW_HANDLERS[typedView], handlerInput };
}

/** Register the single public analytics entry point over private legacy implementations. */
export function registerAdminAnalyticsHandler(
  handlers: Map<string, AdminToolHandler>,
): void {
  const privateHandlers = new Map<string, AdminToolHandler>();
  for (const handlerName of Object.values(VIEW_HANDLERS)) {
    const handler = handlers.get(handlerName);
    if (handler) privateHandlers.set(handlerName, handler);
    handlers.delete(handlerName);
  }

  handlers.set(ADMIN_ANALYTICS_TOOL_NAME, async (input) => {
    const invocation = resolveAdminAnalyticsInvocation(input);
    const handler = privateHandlers.get(invocation.handlerName);
    if (!handler) {
      throw new ToolError('The selected administrative analytics view is unavailable.');
    }
    return handler(invocation.handlerInput);
  });
}
