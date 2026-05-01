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
 * Multi-tenant tools (e.g., `list_creative_formats` on sales / creative /
 * creative-builder) appear in multiple tenants' lists.
 */

export const TOOL_CATALOG: Readonly<Record<string, readonly string[]>> = {
  // sales
  get_products: ['sales'],
  create_media_buy: ['sales'],
  update_media_buy: ['sales'],
  get_media_buys: ['sales'],
  get_media_buy_delivery: ['sales'],
  provide_performance_feedback: ['sales'],
  report_usage: ['sales', 'creative', 'signals'],

  // creative discovery / management — exposed by multiple tenants
  list_creative_formats: ['sales', 'creative', 'creative-builder'],
  list_creatives: ['sales', 'creative'],
  sync_creatives: ['sales', 'creative'],
  build_creative: ['creative', 'creative-builder'],
  preview_creative: ['creative', 'creative-builder'],
  get_creative_delivery: ['creative'],

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
  validate_property_delivery: ['governance'],

  // governance — collection lists
  create_collection_list: ['governance'],
  update_collection_list: ['governance'],
  list_collection_lists: ['governance'],
  get_collection_list: ['governance'],

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
