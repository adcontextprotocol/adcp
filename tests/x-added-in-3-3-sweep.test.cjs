/**
 * 3.3 coherence: every property and enum file new in 3.3 carries
 * `x-added-in: "3.3.0"`, the only machine-readable "new in 3.3" marker SDK
 * generators have. Surfaces that shipped in 3.2 must not carry it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'static', 'schemas', 'source');
const load = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const at = (obj, keys) => keys.reduce((o, k) => o[k], obj);

const WHOLE_FILE_3_3 = [
  // Account requests (account.requests, #8280).
  'core/pending-action.json',
  'core/account-request-record.json',
  'core/account-candidate.json',
  'core/account-request-changed-webhook.json',
  'enums/account-request-state.json',
  'enums/account-request-resolution.json',
  'enums/pending-action-kind.json',
  'enums/pending-action-party.json',
  'error-details/account-ambiguous.json',
  'account/request-account-response.json',
  'core/audience-size.json',
  'enums/audience-size-precision.json',
  'enums/audience-match-rate-basis.json',
  'enums/spot-status.json',
  'core/dooh-inventory-summary.json',
  'core/catalog-ingestion-capability.json',
  'error-details/unsupported-targeting-dimension.json',
  'trust/v1/trust.json',
  'trust/v1/trust-acknowledgements.json',
  'core/assets/video-brief-asset.json',
  'core/identity-relying-party.json',
  'enums/webhook-signing-profile.json',
  'extensions/adcp.json',
  // Reporting subscriptions (media_buy.reporting_subscriptions, RFC #8543 Part B).
  'core/reporting-subscription.json',
  'core/reporting-subscription-state.json',
  'core/reporting-subscription-coverage.json',
  'enums/reporting-dimension.json',
];

const PROPERTIES_3_3 = [
  ['account/list-accounts-request.json', ['properties', 'include_requests']],
  ['account/list-accounts-request.json', ['properties', 'request_ids']],
  ['account/list-accounts-response.json', ['properties', 'account_requests']],
  ['account/list-accounts-response.json', ['properties', 'account_requests_pagination']],
  ['account/list-accounts-request.json', ['properties', 'requests_pagination']],
  ['account/sync-accounts-response.json', ['oneOf', 0, 'properties', 'accounts', 'items', 'properties', 'request_id']],
  ['account/sync-accounts-response.json', ['oneOf', 0, 'properties', 'accounts', 'items', 'properties', 'resolution']],
  ['account/sync-accounts-response.json', ['oneOf', 0, 'properties', 'accounts', 'items', 'properties', 'setup', 'properties', 'waiting_on']],
  ['account/sync-accounts-response.json', ['oneOf', 0, 'properties', 'accounts', 'items', 'properties', 'setup', 'properties', 'kind']],
  ['core/account.json', ['properties', 'setup', 'properties', 'waiting_on']],
  ['core/account.json', ['properties', 'setup', 'properties', 'kind']],
  ['core/principal-relationship.json', ['properties', 'setup', 'properties', 'waiting_on']],
  ['core/principal-relationship.json', ['properties', 'setup', 'properties', 'kind']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'account', 'properties', 'requests']],
  ['media-buy/sync-audiences-response.json', ['oneOf', 0, 'properties', 'audiences', 'items', 'properties', 'audience_size']],
  ['media-buy/sync-audiences-response.json', ['oneOf', 0, 'properties', 'audiences', 'items', 'properties', 'targetable_size']],
  ['media-buy/sync-audiences-response.json', ['oneOf', 0, 'properties', 'audiences', 'items', 'properties', 'match_rate_basis']],
  ['core/spot-reporting-capability.json', ['properties', 'available_statuses']],
  ['core/spot-reporting-capability.json', ['properties', 'supports_break_position']],
  ['core/media-buy-features.json', ['properties', 'catalog_ingestion']],
  ['core/media-buy-features.json', ['properties', 'supports_property_breakdown']],
  ['core/media-buy-features.json', ['properties', 'supports_installment_property_breakdown']],
  ['core/canonical-placement.json', ['definitions', 'CanonicalDoohPlacementAttributes', 'properties', 'location']],
  ['core/placement-definition.json', ['definitions', 'PublisherDoohPlacementAttributes', 'properties', 'location']],
  ['core/placement.json', ['definitions', 'ProductDoohPlacementAttributes', 'properties', 'location']],
  ['core/canonical-product.json', ['properties', 'dooh_inventory_summary']],
  ['core/product.json', ['properties', 'dooh_inventory_summary']],
  ['core/delivery-metrics.json', ['properties', 'print_metrics']],
  ['core/reporting-webhook.json', ['properties', 'operation_id']],
  ['governance/sync-plans-request.json', ['properties', 'plans', 'items', 'properties', 'budget', 'properties', 'periods']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'governance', 'properties', 'supports_budget_periods']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'request_signing', 'properties', 'operation_sources']],
  ['formats/canonical/video_hosted.json', ['properties', 'loudness']],
  ['core/installment-deadlines.json', ['properties', 'change_cutoff']],
  ['core/reporting-status-issue.json', ['properties', 'reporting_revision_id']],
  ['governance/check-governance-request.json', ['properties', 'budget_period_id']],
  ['governance/check-governance-response.json', ['properties', 'budget_period_id']],
  ['media-buy/sync-audiences-response.json', ['oneOf', 0, 'properties', 'audiences', 'items', 'properties', 'platform_id']],
  ['media-buy/sync-event-sources-response.json', ['oneOf', 0, 'properties', 'event_sources', 'items', 'properties', 'platform_id']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'adcp', 'properties', 'implementation']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'account', 'properties', 'stable_account_id']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'media_buy', 'properties', 'vendor_metric_optimization', 'properties', 'supported_metrics']],
  ['core/assets/zip-asset.json', ['properties', 'sizes']],
  ['core/assets/html-asset.json', ['properties', 'sizes']],
  ['core/assets/display-tag-asset.json', ['properties', 'sizes']],
  ['brand.json', ['definitions', 'brand', 'properties', 'prohibited_terms']],
  ['core/agent-notification-config.json', ['properties', 'signing_profile']],
  ['core/notification-config.json', ['properties', 'signing_profile']],
  ['core/push-notification-config.json', ['properties', 'signing_profile']],
  ['core/reporting-webhook.json', ['properties', 'signing_profile']],
  ['media-buy/create-media-buy-request.json', ['properties', 'artifact_webhook', 'properties', 'signing_profile']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'request_signing', 'properties', 'profiles']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'webhook_signing', 'properties', 'profiles']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'media_buy', 'properties', 'event_source_archive']],
  ['media-buy/sync-event-sources-request.json', ['properties', 'event_sources', 'items', 'properties', 'archived']],
  ['media-buy/sync-event-sources-response.json', ['oneOf', 0, 'properties', 'event_sources', 'items', 'properties', 'archived']],
  ['creative/list-creatives-response.json', ['properties', 'creatives', 'items', 'properties', 'provenance']],
  ['core/error.json', ['properties', 'mutation_outcome']],
  ['core/evaluator-spec.json', ['oneOf', 1, 'properties', 'agent_url']],
  ['core/canonical-projection-ref.json', ['properties', 'supported_delivery_types']],
  ['media-buy/request-proposals-response.json', ['properties', 'later_proposals']],
  ['creative/validate-input-result.json', ['properties', 'warnings', 'items', 'properties', 'field']],
  ['core/targeting.json', ['properties', 'collection_lists']],
  ['core/targeting.json', ['properties', 'collection_lists_exclude']],
  ['core/targeting-input.json', ['properties', 'collection_lists']],
  ['core/targeting-input.json', ['properties', 'collection_lists_exclude']],
  ['core/targeting-overlay-requirements.json', ['properties', 'collection_lists']],
  ['core/targeting-overlay-requirements.json', ['properties', 'collection_lists_exclude']],
  ['core/targeting-overlay-support.json', ['properties', 'collection_lists']],
  ['core/targeting-overlay-support.json', ['properties', 'collection_lists_exclude']],
  ['core/performance-standard.json', ['properties', 'metric_id']],
  ['core/canonical-performance-standard.json', ['properties', 'metric_id']],
  ['core/product-offer-filters.json', ['properties', 'required_performance_standards', 'items', 'properties', 'metric_id']],
  ['protocol/sync-principal-request.json', ['properties', 'configuration', 'properties', 'reporting_subscriptions']],
  ['core/principal-state.json', ['properties', 'reporting_subscriptions']],
  ['media-buy/get-reporting-status-response.json', ['properties', 'subscription_coverage']],
  ['core/reporting-delivery-capabilities.json', ['properties', 'configuration_tasks']],
  ['core/reporting-delivery-capabilities.json', ['properties', 'subscriptions']],
  ['core/reporting-obligation.json', ['properties', 'offering_id']],
  ['core/media-buy.json', ['properties', 'completed_at']],
  ['core/account-authorization.json', ['properties', 'authorized_at']],
  ['core/media-buy.json', ['properties', 'cancellation_effective_at']],
  ['media-buy/get-media-buys-response.json', ['properties', 'media_buys', 'items', 'properties', 'cancellation_effective_at']],
  ['core/reporting-obligation.json', ['properties', 'stub']],
  ['protocol/get-principal-response.json', ['properties', 'result', 'oneOf', 0, 'properties', 'reporting_subscription_page']],
  ['core/account-authorization.json', ['properties', 'regranted_at']],
  ['core/media-buy.json', ['properties', 'flight_history']],
  ['media-buy/get-media-buys-response.json', ['properties', 'media_buys', 'items', 'properties', 'flight_history']],
  ['media-buy/get-media-buys-response.json', ['properties', 'media_buys', 'items', 'properties', 'packages', 'items', 'properties', 'reporting_delivery_offering_ids']],
  ['core/reporting-delivery-offering.json', ['properties', 'available_from']],
  ['core/reporting-delivery-offering.json', ['properties', 'withdrawn_at']],
  ['core/reporting-consumer-status.json', ['properties', 'offering_id']],
  ['media-buy/get-reporting-status-response.json', ['properties', 'scope', 'properties', 'delivery_config_generations', 'items', 'properties', 'offering_id']],
  ['compliance/comply-test-controller-request.json', ['properties', 'params', 'properties', 'allowed_tasks']],
  ['compliance/comply-test-controller-request.json', ['properties', 'params', 'properties', 'timezone']],
  ['core/reporting-delivery-offering.json', ['properties', 'standard_dimensions']],
  ['core/reporting-delivery-offering.json', ['properties', 'unmapped_dimensions']],
  ['media-buy/get-media-buys-response.json', ['properties', 'media_buys', 'items', 'properties', 'completed_at']],
];

// Task request schemas are deliberately absent: `x-added-in` on a request makes the
// tool's `added_in` 3.3.0, and the 3.2.1 production MCP profile then rejects any
// role profile that names it (list_collections), so tools are gated by `x-status`.
test('whole-file 3.3 schemas and enums carry x-added-in 3.3.0', () => {
  for (const f of WHOLE_FILE_3_3) assert.equal(load(f)['x-added-in'], '3.3.0', f);
});

test('expected_confirmation_at sites carry x-added-in 3.3.0', () => {
  const sites = [
    ['media-buy/create-media-buy-async-response-submitted.json', ['properties', 'expected_confirmation_at']],
    ['media-buy/create-media-buy-response.json', ['oneOf', 2, 'properties', 'expected_confirmation_at']],
    ['media-buy/media-buy-commitment-response.json', ['oneOf', 2, 'properties', 'expected_confirmation_at']],
    ['media-buy/refine-proposals-async-response-submitted.json', ['properties', 'expected_confirmation_at']],
    ['media-buy/refine-proposals-response.json', ['properties', 'expected_confirmation_at']],
  ];
  for (const [f, keys] of sites) assert.equal(at(load(f), keys)['x-added-in'], '3.3.0', f);
});

test('3.3 properties carry x-added-in 3.3.0', () => {
  for (const [f, keys] of PROPERTIES_3_3) {
    assert.equal(at(load(f), keys)['x-added-in'], '3.3.0', `${f} ${keys.join('.')}`);
  }
});

test('by_spot lifecycle fields carry x-added-in 3.3.0', () => {
  const resp = load('media-buy/get-media-buy-delivery-response.json');
  const spot = resp.properties.media_buy_deliveries.items.properties.by_package.items.allOf[1].properties.by_spot.items.allOf[1].properties;
  for (const k of ['spot_status', 'scheduled_at', 'replaces_spot_id', 'break_position']) {
    assert.equal(spot[k]['x-added-in'], '3.3.0', k);
  }
});

test('added enum values are noted in the enum description', () => {
  assert.match(load('enums/demographic-system.json').description, /`nmo` and `videoamp`.*3\.3/);
  const video = load('formats/canonical/video_hosted.json').properties;
  assert.match(video.video_codecs.description, /`mpeg2`, `avc_intra`, and `xavc`.*3\.3/);
  assert.match(video.containers.description, /`mxf`.*3\.3/);
});

test('surfaces shipped in 3.2 are not marked 3.3', () => {
  // placement-evidence and ooh_metrics are in the 3.2 release artifacts.
  assert.equal(load('core/placement-evidence.json')['x-added-in'], '3.2.0');
  assert.equal(load('core/delivery-metrics.json').properties.ooh_metrics['x-added-in'], undefined);
});
