import type { ComplianceResult, Storyboard } from '@adcp/sdk/testing';
import { getStoryboardsForVersion } from './storyboards.js';

/**
 * Tasks each `supported_protocols` claim brings with it: every row of
 * docs/protocol/required-tasks.mdx under that protocol, at any requirement
 * level, plus tasks whose request schema lives in the protocol's schema
 * directory but which the table does not list. Listing optional rows keeps a
 * declared protocol's own surface graded exactly as before.
 */
const PROTOCOL_TASKS: Readonly<Record<string, readonly string[]>> = {
  media_buy: [
    'get_products',
    'create_media_buy',
    'update_media_buy',
    'get_media_buys',
    'get_media_buy_delivery',
    'provide_performance_feedback',
    'sync_creatives',
    'list_creatives',
    'sync_catalogs',
    'sync_event_sources',
    'log_event',
    'sync_audiences',
    'get_reporting_status',
    'sync_reporting_status',
    'sync_reporting_receipts',
    'list_creative_formats',
  ],
  creative: [
    'list_transformers',
    'build_creative',
    'preview_creative',
    'list_creatives',
    'sync_creatives',
    'get_creative_delivery',
    'validate_input',
    'list_creative_formats',
  ],
  signals: ['get_signals', 'activate_signal'],
  brand: ['get_brand_identity', 'get_rights', 'acquire_rights', 'update_rights'],
  governance: [
    'sync_plans',
    'check_governance',
    'report_plan_outcome',
    'get_plan_audit_logs',
    'create_property_list',
    'get_property_list',
    'update_property_list',
    'delete_property_list',
    'list_property_lists',
    'validate_property_delivery',
    'create_collection_list',
    'get_collection_list',
    'update_collection_list',
    'list_collection_lists',
    'delete_collection_list',
    'create_content_standards',
    'get_content_standards',
    'list_content_standards',
    'update_content_standards',
    'calibrate_content',
    'validate_content_delivery',
    'get_media_buy_artifacts',
    'get_creative_features',
  ],
  sponsored_intelligence: [
    'si_get_offering',
    'si_initiate_session',
    'si_send_message',
    'si_terminate_session',
  ],
};

/** Accounts Protocol tasks, owed by any agent that accepts accounts. */
const ACCOUNT_TASKS: ReadonlySet<string> = new Set([
  'sync_accounts',
  'list_accounts',
  'request_account',
  'sync_governance',
  'report_usage',
  'get_account_financials',
]);

const PRINCIPAL_TASKS: ReadonlySet<string> = new Set(['sync_principal', 'get_principal']);

/**
 * Discovery is owed by every agent, and the test controller keeps its
 * existing controller-gap semantics, so neither ever reads as not applicable.
 */
const ALWAYS_OWED_TASKS: ReadonlySet<string> = new Set([
  'get_adcp_capabilities',
  'comply_test_controller',
]);

const CAPABILITY_CONDITIONAL_TASKS: ReadonlySet<string> = new Set([
  ...ACCOUNT_TASKS,
  ...PRINCIPAL_TASKS,
  'sync_agent_notification_configs',
]);

const KNOWN_TASKS: ReadonlySet<string> = new Set([
  ...Object.values(PROTOCOL_TASKS).flat(),
  ...CAPABILITY_CONDITIONAL_TASKS,
  ...ALWAYS_OWED_TASKS,
]);

/** Whether the obligation table classifies `tool`; unclassified tools are always owed. */
export function isClassifiedTask(tool: string): boolean {
  return KNOWN_TASKS.has(tool);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Whether the agent's own declarations make `tool` part of what it must
 * offer. Unknown tasks, and capability-conditional tasks when the raw
 * capabilities are unavailable, are treated as owed (fail closed).
 */
export function agentOwesTool(
  tool: string,
  declaredProtocols: ReadonlySet<string>,
  rawCapabilities: unknown,
): boolean {
  if (ALWAYS_OWED_TASKS.has(tool) || !KNOWN_TASKS.has(tool)) return true;
  for (const protocol of declaredProtocols) {
    if (PROTOCOL_TASKS[protocol]?.includes(tool)) return true;
  }
  if (!CAPABILITY_CONDITIONAL_TASKS.has(tool)) return false;

  const capabilities = record(rawCapabilities);
  if (!capabilities) return true;
  if (ACCOUNT_TASKS.has(tool)) return record(capabilities.account) !== undefined;
  const adcp = record(capabilities.adcp);
  if (PRINCIPAL_TASKS.has(tool)) return record(adcp?.principal)?.supported === true;
  const notifications = record(record(adcp?.capability_changes)?.notifications);
  return notifications?.supported === true
    && (notifications.registration_task === undefined
      || notifications.registration_task === 'sync_agent_notification_configs');
}

const catalogByVersion = new Map<string, ReadonlyMap<string, Storyboard>>();

function catalogForVersion(version: string): ReadonlyMap<string, Storyboard> {
  const cached = catalogByVersion.get(version);
  if (cached) return cached;
  let catalog: ReadonlyMap<string, Storyboard> = new Map();
  try {
    catalog = new Map(getStoryboardsForVersion(version).map(storyboard => [storyboard.id, storyboard]));
  } catch {
    // An unknown release cannot prove a storyboard's required tools. Never
    // substitute another release's catalog.
  }
  catalogByVersion.set(version, catalog);
  return catalog;
}

/**
 * Storyboards the runner skipped for missing tools that do not apply to this
 * agent: it advertises none of their `required_tools`, and none of those tools
 * is owed under a protocol it declares or a shared capability it declares.
 * `alsoDeclared` adds protocols the caller already attributes to the agent,
 * such as a badge role derived from its specialisms. Returns an empty set when
 * the declarations or the graded release's catalog are unavailable, so callers
 * fail closed.
 */
export function undeclaredSurfaceMissingToolStoryboards(
  result: ComplianceResult,
  alsoDeclared: Iterable<string> = [],
): Set<string> {
  const missing = result.storyboards_missing_tools ?? [];
  const protocols = result.agent_profile?.supported_protocols;
  if (missing.length === 0 || !Array.isArray(protocols) || !result.adcp_version) return new Set();

  const declared = new Set([...protocols, ...alsoDeclared]);
  const advertised = new Set(result.agent_profile?.tools ?? []);
  const rawCapabilities = result.agent_profile?.raw_capabilities;
  const catalog = catalogForVersion(result.adcp_version);
  const undeclared = new Set<string>();
  for (const storyboardId of missing) {
    const tools = catalog.get(storyboardId)?.required_tools ?? [];
    // An empty list cannot be missing, and an advertised tool contradicts the
    // missing-tools record; neither is evidence that the surface is unclaimed.
    if (tools.length === 0 || tools.some(tool => advertised.has(tool))) continue;
    if (tools.some(tool => agentOwesTool(tool, declared, rawCapabilities))) continue;
    undeclared.add(storyboardId);
  }
  return undeclared;
}
