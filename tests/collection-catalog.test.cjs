'use strict';

/**
 * Schema contract for experimental list_collections and the collection card
 * webhooks (media_buy.collection_catalog, #8183).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const read = file => JSON.parse(fs.readFileSync(path.join(SCHEMAS, file), 'utf8'));
const readText = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const CARD_EVENTS = ['collection_card.updated', 'collection_card.removed', 'collection_catalog.bulk_change'];
const ENTITY_TYPE = {
  'collection_card.updated': 'collection',
  'collection_card.removed': 'collection',
  'collection_catalog.bulk_change': 'feed',
};

function loadAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema);
      }
    }
  };
  walk(SCHEMAS);
  return ajv;
}

const ajv = loadAjv();
const requestSchema = ajv.getSchema('/schemas/media-buy/list-collections-request.json');
const responseSchema = ajv.getSchema('/schemas/media-buy/list-collections-response.json');

test('the three card event types appear in every enumeration of webhook types', () => {
  const lists = {
    'enums/notification-type.json': read('enums/notification-type.json').enum,
    'core/notification-config.json event_types': read('core/notification-config.json').properties.event_types.items.enum,
    'wholesale_feed_webhooks.event_types': read('protocol/get-adcp-capabilities-response.json')
      .properties.wholesale_feed_webhooks.properties.event_types.items.enum,
    'core/wholesale-feed-event.json event_type': read('core/wholesale-feed-event.json').properties.event_type.enum,
    'core/wholesale-feed-webhook.json notification_type': read('core/wholesale-feed-webhook.json').properties.notification_type.enum,
    'core/agent-notification-config.json account-anchored list': read('core/agent-notification-config.json')
      .if.properties.event_types.contains.enum,
  };
  for (const [name, values] of Object.entries(lists)) {
    for (const type of CARD_EVENTS) assert.ok(values.includes(type), `${name} lists ${type}`);
  }
  const descriptions = read('enums/notification-type.json').enumDescriptions;
  for (const type of CARD_EVENTS) {
    assert.match(descriptions[type], /Experimental \(media_buy\.collection_catalog\) account-anchored/);
    assert.match(descriptions[type], /\*\*notification_id\*\*: equals `event\.event_id`/);
  }
});

test('each card event has an event-union branch with its entity_type and an envelope type binding', () => {
  const event = read('core/wholesale-feed-event.json');
  assert.ok(event.properties.entity_type.enum.includes('collection'));
  for (const type of CARD_EVENTS) {
    const branches = event.oneOf.filter(b => b.properties.event_type.const === type);
    assert.equal(branches.length, 1, type);
    assert.equal(branches[0].properties.entity_type.const, ENTITY_TYPE[type], type);
    assert.equal(branches[0]['x-status'], 'experimental');
    assert.equal(branches[0]['x-added-in'], '3.3.0');
    assert.ok(branches[0].properties.payload.required.includes('applies_to'), `${type} requires applies_to`);
  }
  const updated = event.oneOf.find(b => b.properties.event_type.const === 'collection_card.updated');
  assert.equal(updated.properties.payload.properties.collection.$ref, '/schemas/core/response-collection.json');
  const envelope = read('core/wholesale-feed-webhook.json');
  for (const type of CARD_EVENTS) {
    assert.ok(envelope.allOf.some(rule => (
      rule.if && rule.if.properties.notification_type && rule.if.properties.notification_type.const === type
      && rule.then.properties.event.properties.event_type.const === type
    )), `envelope binds ${type}`);
  }
});

test('the bulk event is not a wholesale_feed.bulk_change and the closed affected_entity_type enum is unchanged', () => {
  const event = read('core/wholesale-feed-event.json');
  const wholesale = event.oneOf.find(b => b.properties.event_type.const === 'wholesale_feed.bulk_change');
  assert.deepEqual(wholesale.properties.payload.properties.affected_entity_type.enum, ['product', 'signal']);
});

test('list_collections request: selectors, filters and pagination, strict', () => {
  const ok = {
    adcp_version: '3.3',
    collections: [{ publisher_domain: 'novacreators.example', collection_ids: ['kitchen_lab'] }, { publisher_domain: 'pinnaclepods.example' }],
    filters: {
      kinds: ['series'], statuses: ['active'], languages: ['en'], genres_include: ['IAB1-8'], genre_taxonomy: 'iab_content_3.0',
      talent: [{ domain: 'jordanvega.example' }], platforms: ['videoplatform.example'], name_contains: 'kitchen',
    },
    pagination: { max_results: 100, cursor: 'abc' },
    if_collections_version: 'cc_1',
    account: { account_id: 'acct_1' },
  };
  assert.equal(requestSchema(ok), true, JSON.stringify(requestSchema.errors));
  assert.equal(requestSchema({}), true, 'every field is optional: an empty request browses the catalog');
  assert.equal(requestSchema({ ...ok, include_products: true }), false, 'the request rejects unknown fields');
  assert.equal(requestSchema({ ...ok, filters: { audience_size_min: 1000 } }), false, 'unknown filters are rejected');
  assert.equal(requestSchema({ ...ok, filters: { sort: 'followers' } }), false, 'there is no sort');
  assert.equal(requestSchema({ ...ok, pagination: { max_results: 101 } }), false, 'pagination caps at 100');
  assert.equal(requestSchema({ ...ok, filters: { talent: [{ domain: 'jordanvega.example', countries: ['US'] }] } }), false,
    'talent filters read only domain and brand_id');
  assert.equal(requestSchema({ ...ok, filters: { statuses: ['paused'] } }), false, 'statuses use collection-status');
  const schema = read('media-buy/list-collections-request.json');
  assert.equal(schema['x-status'], 'experimental');
  assert.ok(schema['x-tool-summary'] && schema['x-tool-summary'].length <= 160);
  assert.equal(schema.properties.collections.items.$ref, '/schemas/core/collection-selector.json');
  assert.equal(schema.properties.pagination.$ref, '/schemas/core/pagination-request.json');
  assert.match(schema.description, /list_collection_lists/);
  assert.match(schema.description, /media_buy\.collection_catalog and media_buy\.collection_cards/);
  assert.match(schema.description, /below 3\.3; it fails the request with UNSUPPORTED_FEATURE/);
  assert.match(schema.description, /takes no push_notification_config, so a call never creates a subscription/);
  for (const legacy of ['context_id', 'governance_context', 'push_notification_config']) {
    assert.equal(schema.properties[legacy], undefined, `${legacy} is a 3.x compatibility field, not part of a 3.3 task`);
  }
});

test('list_collections response: listed and unchanged arms', () => {
  const card = { publisher_domain: 'novacreators.example', collection_id: 'kitchen_lab', name: 'Kitchen Lab' };
  const listed = { outcome: 'listed', collections: [card], pagination: { has_more: false }, collections_version: 'cc_1', cache_scope: 'public' };
  assert.equal(responseSchema(listed), true, JSON.stringify(responseSchema.errors));
  assert.equal(responseSchema({ ...listed, collections: [] }), true, 'an empty page is listed');
  const { collections: _c, ...noCollections } = listed;
  assert.equal(responseSchema(noCollections), false, 'listed requires collections');
  const { publisher_domain: _d, ...unscoped } = card;
  assert.equal(responseSchema({ ...listed, collections: [unscoped] }), false, 'entries require publisher_domain');
  const unchanged = { outcome: 'unchanged', collections_version: 'cc_1', cache_scope: 'account' };
  assert.equal(responseSchema(unchanged), true, JSON.stringify(responseSchema.errors));
  assert.equal(responseSchema({ ...unchanged, collections: [card] }), false, 'unchanged carries no collections');
  assert.equal(responseSchema({ ...unchanged, pagination: { has_more: false } }), false, 'unchanged carries no page');
  assert.equal(responseSchema({ ...listed, products: [] }), false, 'the response never carries products');
  const { collections_version: _v, ...noVersion } = listed;
  assert.equal(responseSchema(noVersion), false, 'collections_version is required');
  const schema = read('media-buy/list-collections-response.json');
  assert.equal(schema['x-status'], 'experimental');
  assert.equal(schema.properties.collections.items.$ref, '/schemas/core/response-collection.json');
  assert.equal(schema.properties.pagination.$ref, '/schemas/core/pagination-response.json');
  assert.match(schema.description, /MUST equal the one a product or proposal read with include_collections returns/);
  assert.match(schema.properties.collections_version.description, /bounds and precision unchanged is not a change/);
  assert.match(schema.properties.collections_version.description, /Independent of feed_version and wholesale_feed_version/);
});

test('capabilities: collection_catalog requires collection_cards, and card events require collection_catalog', () => {
  const caps = read('protocol/get-adcp-capabilities-response.json');
  const rule = text => caps.allOf.find(r => r.description && r.description.includes(text));
  const catalogNeedsCards = ajv.compile(rule('requires media_buy.collection_cards'));
  assert.equal(catalogNeedsCards({ experimental_features: ['media_buy.collection_catalog'] }), false);
  assert.equal(catalogNeedsCards({ experimental_features: ['media_buy.collection_catalog', 'media_buy.collection_cards'] }), true);
  assert.equal(catalogNeedsCards({ experimental_features: ['media_buy.collection_cards'] }), true);
  const eventsNeedCatalog = ajv.compile(rule('repaired through list_collections'));
  for (const type of CARD_EVENTS) {
    const doc = { wholesale_feed_webhooks: { supported: true, event_types: [type] } };
    assert.equal(eventsNeedCatalog(doc), false, `${type} without the feature id`);
    assert.equal(eventsNeedCatalog({ ...doc, experimental_features: ['media_buy.collection_catalog'] }), true, type);
  }
  assert.equal(eventsNeedCatalog({ wholesale_feed_webhooks: { supported: true, event_types: ['product.updated'] } }), true);
  const constraint = caps.properties.wholesale_feed_webhooks.properties.event_types['x-adcp-validation']
    .verifier_constraints.wholesale_feed_webhook_capability_consistency;
  assert.deepEqual(constraint.collection_events_require, { field: 'experimental_features', contains_item: 'media_buy.collection_catalog' });
});

test('list_collections is registered as a media-buy task and in the media-buy MCP role profile', () => {
  const index = read('index.json');
  const task = index.schemas['media-buy'].tasks['list-collections'];
  assert.equal(task.request.$ref, '/schemas/media-buy/list-collections-request.json');
  assert.equal(task.response.$ref, '/schemas/media-buy/list-collections-response.json');
  assert.match(readText('scripts/build-schemas.cjs'), /'list_collections',/);
});

test('follower as_of means when the count last changed', () => {
  const followers = read('core/collection-distribution.json').properties.followers.description;
  assert.match(followers, /as_of is when the count last changed, not when it was last read/);
  assert.doesNotMatch(followers, /time the platform's count was read/);
  const guide = readText('docs/media-buy/product-discovery/collections-and-installments.mdx');
  assert.match(guide, /`as_of` is when the count last changed, not when it was last read/);
  assert.doesNotMatch(guide, /`as_of` is the time the platform's count was read/);
});

test('collection selectors no longer say adagents.json is the only way to resolve a collection', () => {
  const desc = read('core/collection-selector.json').description;
  assert.doesNotMatch(desc, /Buyers resolve full collection objects by fetching the adagents\.json/);
  assert.match(desc, /include_collections/);
  assert.match(desc, /list_collections/);
  assert.match(desc, /never authorization evidence/);
});

test('docs carry the task page, the registry row, and no stale future-work note', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/media-buy/task-reference/list_collections.mdx')));
  const registry = readText('docs/reference/experimental-status.mdx');
  const row = registry.split('\n').find(line => line.startsWith('| `media_buy.collection_catalog` |'));
  assert.ok(row, 'experimental-status lists media_buy.collection_catalog');
  assert.match(row, /list_collections/);
  for (const type of CARD_EVENTS) assert.ok(row.includes(type), `registry row names ${type}`);
  const guide = readText('docs/media-buy/product-discovery/collections-and-installments.mdx');
  assert.doesNotMatch(guide, /is future work/);
  for (const doc of ['docs/media-buy/task-reference/get_products.mdx', 'docs/media-buy/task-reference/list_products.mdx', 'docs/media-buy/product-discovery/collections-and-installments.mdx']) {
    assert.match(readText(doc), /collection_card\.\*/, `${doc} points webhook-fed mirrors at the card events`);
  }
});
