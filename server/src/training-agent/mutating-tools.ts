// The training agent's mutating tool names, kept import-free so that readers
// (Addie's side-effect claims) do not load the idempotency store, the
// database client and the SDK server build.

/**
 * Tasks whose request schemas require `idempotency_key`.
 * Derived from static/schemas/source/**\/*-request.json — every schema whose
 * top-level `required` list includes `idempotency_key` maps to the
 * corresponding tool. The regression test in idempotency.test.ts re-derives
 * this set from the schemas at test time and asserts equality, so drift
 * between this list and the schemas will fail CI.
 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'accept_proposal',
  'acquire_rights',
  'activate_signal',
  'build_creative',
  'buy_products',
  'calibrate_content',
  'create_collection_list',
  'create_content_standards',
  'create_media_buy',
  'create_property_list',
  'creative_approval',
  'control_media_buy',
  'delete_collection_list',
  'delete_property_list',
  'decline_proposals',
  'log_event',
  'provide_performance_feedback',
  'request_proposals',
  'refine_proposals',
  'report_media_buy_issue',
  'report_plan_adjustment',
  'report_plan_outcome',
  'report_usage',
  'request_account',
  'si_initiate_session',
  'si_send_message',
  'sync_accounts',
  'sync_principal',
  'sync_agent_notification_configs',
  'sync_audiences',
  'sync_catalogs',
  'sync_creatives',
  'sync_event_sources',
  'sync_governance',
  'sync_plans',
  'sync_reporting_receipts',
  'sync_reporting_status',
  'update_collection_list',
  'update_content_standards',
  'update_media_buy',
  'update_property_list',
  'update_rights',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}
