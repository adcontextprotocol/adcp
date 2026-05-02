/**
 * Static catalog mapping each canonical AdCP tool name to the tenants that
 * serve it. Surfaces in the `_training_agent_tenants` discovery extension
 * on `/.well-known/adagents.json` so a developer can pick the right URL
 * without trial-and-error.
 *
 * NOT used for request-path interception. The storyboard runner's
 * missing-tool detection (`/Unknown tool[:\s]/i` + `!taskResult`) doesn't
 * classify any of `result.isError`, JSON-RPC error, or `adcp_error`-wrapped
 * responses as graceful skips — so any custom error format breaks the
 * runner. Keep the catalog as a discovery hint only until upstream SDK
 * adds a wrong-tenant classifier.
 *
 * Multi-tenant tools (e.g., `sync_creatives` served by sales / creative /
 * creative-builder) appear in multiple tenants' lists.
 *
 * Drift detection: `tests/integration/training-agent-tool-catalog-drift.test.ts`
 * boots each tenant and asserts this catalog matches the live `tools/list`
 * response. Universal tools (`get_adcp_capabilities`, `comply_test_controller`,
 * `tasks_get`) are excluded from the catalog by convention — they're on
 * every tenant and never form a "wrong tenant" hint.
 */

export const TOOL_CATALOG: Readonly<Record<string, readonly string[]>> = {
  // sales
  get_products: ['sales'],
  create_media_buy: ['sales'],
  update_media_buy: ['sales'],
  get_media_buys: ['sales'],
  get_media_buy_delivery: ['sales'],
  provide_performance_feedback: ['sales'],
  list_creative_formats: ['sales'],

  // creative — exposed on multiple tenants
  list_creatives: ['sales', 'creative', 'creative-builder'],
  sync_creatives: ['sales', 'creative', 'creative-builder'],
  build_creative: ['creative', 'creative-builder'],
  preview_creative: ['creative', 'creative-builder'],
  get_creative_delivery: ['creative', 'creative-builder'],

  // signals
  get_signals: ['signals'],
  activate_signal: ['signals'],

  // governance — campaign
  sync_plans: ['governance'],
  check_governance: ['governance'],
  report_plan_outcome: ['governance'],
  get_plan_audit_logs: ['governance'],

  // governance — property lists
  create_property_list: ['governance'],
  update_property_list: ['governance'],
  list_property_lists: ['governance'],
  get_property_list: ['governance'],
  delete_property_list: ['governance'],
  validate_content_delivery: ['governance'],

  // governance — collection lists
  create_collection_list: ['governance'],
  update_collection_list: ['governance'],
  list_collection_lists: ['governance'],
  get_collection_list: ['governance'],
  delete_collection_list: ['governance'],

  // governance — content standards
  create_content_standards: ['governance'],
  update_content_standards: ['governance'],
  list_content_standards: ['governance'],
  get_content_standards: ['governance'],
  calibrate_content: ['governance'],

  // brand
  get_brand_identity: ['brand'],
  get_rights: ['brand'],
  acquire_rights: ['brand'],
  update_rights: ['brand'],
  creative_approval: ['brand'],
};

/** Build the tool list a given tenant serves — inverse view of TOOL_CATALOG. */
export function toolsForTenant(tenantId: string): string[] {
  return Object.entries(TOOL_CATALOG)
    .filter(([, tenants]) => tenants.includes(tenantId))
    .map(([tool]) => tool)
    .sort();
}
