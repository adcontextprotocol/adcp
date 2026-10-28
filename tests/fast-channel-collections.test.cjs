const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

function schemaPathFromId(schemaId) {
  return path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
}

async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) throw new Error(`Cannot load external schema: ${uri}`);
  return JSON.parse(fs.readFileSync(schemaPathFromId(uri), 'utf8'));
}

async function compile(schemaId) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: loadExternalSchema,
  });
  addFormats(ajv);
  return ajv.compileAsync(JSON.parse(fs.readFileSync(schemaPathFromId(schemaId), 'utf8')));
}

test('channel collections can map carriage to a host property without a host-specific identifier', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const collection = {
    collection_id: 'retro_news',
    kind: 'channel',
    name: 'Acme Retro News',
    distribution: [{
      publisher_domain: 'hoststream.example',
      property_ids: ['hoststream_ctv'],
    }],
  };

  assert.equal(validate(collection), true, JSON.stringify(validate.errors, null, 2));
});

test('channel collections support publisher-scoped channel identifiers', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const collection = {
    collection_id: 'retro_news',
    kind: 'channel',
    name: 'Acme Retro News',
    distribution: [{
      publisher_domain: 'hoststream.example',
      identifiers: [{ type: 'platform_channel_id', value: 'channel_942' }],
    }],
  };

  assert.equal(validate(collection), true, JSON.stringify(validate.errors, null, 2));
});

test('collection ownership is explicit at the declaration while related collections remain local references', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const collection = {
    publisher_domain: 'channel-owner.example',
    collection_id: 'retro_news',
    name: 'Retro News',
    related_collections: [{ collection_id: 'retro_extra', relationship: 'companion' }],
  };
  assert.equal(validate(collection), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate({ ...collection, publisher_domain: 'https://channel-owner.example' }), false);
  assert.equal(validate({
    ...collection,
    related_collections: [{ ...collection.related_collections[0], publisher_domain: 'other.example' }],
  }), false, 'related collections are not cross-publisher declarations');
});

test('collection distributions reject empty carriage records', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const collection = {
    collection_id: 'retro_news',
    kind: 'channel',
    name: 'Acme Retro News',
    distribution: [{ publisher_domain: 'hoststream.example' }],
  };

  assert.equal(validate(collection), false, 'distribution requires property_ids or identifiers');
});

test('platform_channel_id is rejected in bare {type, value} filter contexts', async () => {
  const validate = await compile('/schemas/collection/collection-list-filters.json');
  const filters = {
    exclude_distribution_ids: [{ type: 'platform_channel_id', value: '1005' }],
  };

  assert.equal(validate(filters), false,
    'platform_channel_id identity is (publisher_domain, value); bare {type, value} cannot carry it');
});

test('a host can bulk-grant all collections of an external publisher', async () => {
  const validate = await compile('/schemas/adagents.json');
  const manifest = {
    $schema: '/schemas/adagents.json',
    properties: [{
      property_id: 'hoststream_ctv',
      property_type: 'ctv_app',
      name: 'HostStream CTV',
      identifiers: [{ type: 'roku_store_id', value: 'hoststream' }],
    }],
    authorized_agents: [{
      url: 'https://sales.channel-owner.example',
      authorized_for: 'Owner-sold avails, all carried channels',
      authorization_type: 'property_ids',
      property_ids: ['hoststream_ctv'],
      collections: [{ publisher_domain: 'channel-owner.example' }],
      delegation_type: 'direct',
    }],
  };

  assert.equal(validate(manifest), true, JSON.stringify(validate.errors, null, 2));
});

test('product collection selectors require explicit collection_ids', async () => {
  const validate = await compile('/schemas/core/product.json');
  const product = {
    product_id: 'owner_avails',
    name: 'Channel-owner avails',
    description: 'Owner-sold avails on the host app',
    collections: [{ publisher_domain: 'channel-owner.example' }],
  };

  const valid = validate(product);
  assert.equal(valid, false, 'domain-only selectors are for authorization scoping, not product composition');
  assert.ok(
    (validate.errors || []).some((error) => JSON.stringify(error).includes('collection_ids')),
    JSON.stringify(validate.errors, null, 2),
  );
});

test('a host can authorize owner-sold inventory by external collection selector', async () => {
  const validate = await compile('/schemas/adagents.json');
  const manifest = {
    $schema: '/schemas/adagents.json',
    properties: [{
      property_id: 'hoststream_ctv',
      property_type: 'ctv_app',
      name: 'HostStream CTV',
      identifiers: [{ type: 'roku_store_id', value: 'hoststream' }],
    }],
    authorized_agents: [{
      url: 'https://sales.channel-owner.example',
      authorized_for: 'Owner-sold avails for Acme Retro News',
      authorization_type: 'property_ids',
      property_ids: ['hoststream_ctv'],
      collections: [{
        publisher_domain: 'channel-owner.example',
        collection_ids: ['retro_news'],
      }],
      delegation_type: 'direct',
    }],
  };

  assert.equal(validate(manifest), true, JSON.stringify(validate.errors, null, 2));
});

test('collection cards carry images, sample content and a typed talent brand link', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const image = { asset_type: 'image', url: 'https://cdn.example.com/retro_news.jpg', width: 1200, height: 675 };
  const collection = {
    collection_id: 'retro_news',
    name: 'Acme Retro News',
    images: [image],
    sample_content: [{
      asset_type: 'published_post',
      post_url: 'https://video.example.com/watch/retro-news-ep-12',
      platform: 'video.example.com',
    }],
    talent: [{
      role: 'host',
      name: 'Jordan Vega',
      brand_ref: { domain: 'jordanvega.example.com' },
      brand_url: 'https://jordanvega.example.com/.well-known/brand.json',
    }],
  };
  assert.equal(validate(collection), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate({ ...collection, images: [] }), false, 'images needs at least one entry');
  assert.equal(validate({ ...collection, images: Array(11).fill(image) }), false, 'images is bounded');
  assert.equal(validate({ ...collection, sample_content: [] }), false, 'sample_content needs at least one entry');
  assert.equal(validate({ ...collection, sample_content: Array(11).fill(collection.sample_content[0]) }), false, 'sample_content is bounded');
  assert.equal(validate({ ...collection, talent: [{ role: 'host', name: 'Jordan Vega', brand_ref: { domain: 'Not A Domain' } }] }), false);
});

test('new collection card fields are experimental and added in 3.3.0', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, file), 'utf8'));
  const collection = read('core/collection.json').properties;
  const talent = read('core/talent.json').properties;
  for (const field of [collection.images, collection.sample_content, talent.brand_ref]) {
    assert.equal(field['x-status'], 'experimental');
    assert.equal(field['x-added-in'], '3.3.0');
  }
  assert.equal(talent.brand_url.deprecated, undefined, 'brand_url is not deprecated');
});

test('product card reference assets accept the sample_content role', async () => {
  const validate = await compile('/schemas/core/product-card-reference-asset.json');
  assert.equal(validate({
    role: 'sample_content',
    asset: { asset_type: 'url', url: 'https://video.example.com/watch/sizzle' },
    description: 'Sizzle reel for the show this product runs in',
  }), true, JSON.stringify(validate.errors, null, 2));
});

test('sample_content role takes a url or video asset but not a published_post', async () => {
  const validate = await compile('/schemas/core/product-card-reference-asset.json');
  const video = { role: 'sample_content', asset: { asset_type: 'video', url: 'https://cdn.example.com/sizzle.mp4', width: 1920, height: 1080 } };
  assert.equal(validate(video), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate({ role: 'sample_content', asset: { asset_type: 'published_post', post_url: 'https://video.example.com/watch/1' } }), false);
});

test('collection card fields reject malformed entries and the registry lists the feature id', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const base = { collection_id: 'retro_news', name: 'Acme Retro News' };
  assert.equal(validate({ ...base, images: [{ asset_type: 'video', url: 'https://cdn.example.com/a.mp4' }] }), false);
  assert.equal(validate({ ...base, sample_content: [{ asset_type: 'published_post' }] }), false);
  assert.equal(validate({ ...base, talent: [{ role: 'host', name: 'Jordan Vega', brand_ref: { domain: 'jordanvega.example.com', bogus: true } }] }), false);
  const role = await compile('/schemas/core/product-card-reference-asset.json');
  assert.equal(role({ role: 'bogus_role', asset: { asset_type: 'url', url: 'https://example.com' } }), false);
  const registry = fs.readFileSync(path.join(__dirname, '../docs/reference/experimental-status.mdx'), 'utf8');
  assert.ok(registry.includes('`media_buy.collection_cards`'));
});

// #8137: full collection objects in product and proposal responses.
const responseCollection = {
  publisher_domain: 'acmestreaming.example.com',
  collection_id: 'pinnacle_challenge',
  name: 'The Pinnacle Challenge',
  url: 'https://acmestreaming.example.com/shows/pinnacle-challenge',
  images: [{ asset_type: 'image', url: 'https://cdn.acmestreaming.example.com/pinnacle.jpg', width: 1200, height: 675 }],
  talent: [{ role: 'host', name: 'Jordan Vega', brand_ref: { domain: 'jordanvega.example.com' } }],
};
const selector = [{ publisher_domain: 'acmestreaming.example.com', collection_ids: ['pinnacle_challenge'] }];
const canonicalProduct = { product_id: 'pinnacle_video', name: 'Pinnacle Challenge video', collections: selector };
const legacyProduct = {
  product_id: 'pinnacle_video',
  name: 'Pinnacle Challenge video',
  description: 'Pre-roll on The Pinnacle Challenge',
  publisher_properties: [{ publisher_domain: 'acmestreaming.example.com', selection_type: 'all' }],
  format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
  delivery_type: 'guaranteed',
  delivery_measurement: { provider: 'Test' },
  pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
  reporting_capabilities: {
    available_reporting_frequencies: ['daily'],
    expected_delay_minutes: 240,
    timezone: 'UTC',
    supports_webhooks: false,
    available_metrics: ['impressions'],
    date_range_support: 'date_range',
  },
  collections: selector,
};
const draftProposal = {
  proposal_id: 'proposal-1',
  name: 'Draft Pinnacle Challenge plan',
  proposal_kind: 'new_media_buy',
  proposal_status: 'draft',
  expires_at: '2027-06-30T23:59:59Z',
  commercial_terms: {
    brand: { domain: 'nova-brands.example' },
    purchases: [{
      product_id: 'pinnacle_video',
      pricing_option_id: 'fixed-cpm',
      pricing: { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 28 },
      start_time: '2027-06-01T12:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
    }],
    start_time: 'asap',
    end_time: '2027-07-01T00:00:00Z',
  },
  terms_digest: `sha256:${'A'.repeat(43)}`,
};
const responseCases = [
  ['/schemas/media-buy/get-products-response.json', { status: 'completed', products: [legacyProduct], cache_scope: 'public' }],
  ['/schemas/media-buy/list-products-response.json', { outcome: 'listed', products: [canonicalProduct], feed_version: 'feed-v1', cache_scope: 'public' }],
  ['/schemas/media-buy/request-proposals-response.json', { outcome: 'proposed', proposals: [draftProposal], products: [canonicalProduct] }],
  ['/schemas/media-buy/refine-proposals-response.json', {
    status: 'completed',
    results: [{ source_proposal_id: 'proposal-1', outcome: 'unable', reason_code: 'commercially_declined', reason: 'Declined.' }],
    products: [canonicalProduct],
  }],
];

for (const [schemaId, base] of responseCases) {
  test(`${schemaId} accepts full collection objects alongside products`, async () => {
    const validate = await compile(schemaId);
    assert.equal(validate(base), true, JSON.stringify(validate.errors, null, 2));
    assert.equal(validate({ ...base, collections: [responseCollection] }), true, JSON.stringify(validate.errors, null, 2));
    assert.equal(validate({ ...base, collections: [] }), false, 'collections needs at least one entry');
    const { publisher_domain: _domain, ...unscoped } = responseCollection;
    assert.equal(validate({ ...base, collections: [unscoped] }), false, 'publisher_domain is required on response collections');
    const { products: _products, ...withoutProducts } = base;
    assert.equal(validate({ ...withoutProducts, collections: [responseCollection] }), false, 'collections only travel with products');
  });
}

test('collections are forbidden on rejected and unchanged outcomes', async () => {
  const proposals = await compile('/schemas/media-buy/request-proposals-response.json');
  const rejected = { outcome: 'rejected', reason: 'No available offer satisfies the campaign constraints.' };
  assert.equal(proposals(rejected), true, JSON.stringify(proposals.errors, null, 2));
  assert.equal(proposals({ ...rejected, collections: [responseCollection] }), false);
  const products = await compile('/schemas/media-buy/get-products-response.json');
  const declined = { status: 'rejected', reason: 'Budget is below the minimum for this inventory.' };
  assert.equal(products(declined), true, JSON.stringify(products.errors, null, 2));
  assert.equal(products({ ...declined, collections: [responseCollection] }), false);
  const listed = await compile('/schemas/media-buy/list-products-response.json');
  const unchanged = { outcome: 'unchanged', feed_version: 'feed-v1', cache_scope: 'public' };
  assert.equal(listed(unchanged), true, JSON.stringify(listed.errors, null, 2));
  assert.equal(listed({ ...unchanged, collections: [responseCollection] }), false);
  const refine = await compile('/schemas/media-buy/refine-proposals-response.json');
  const submitted = { status: 'submitted', task_id: 'task-1' };
  assert.equal(refine(submitted), true, JSON.stringify(refine.errors, null, 2));
  assert.equal(refine({ ...submitted, collections: [responseCollection] }), false);
});

test('collection url is a uri', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const base = { collection_id: 'pinnacle_challenge', name: 'The Pinnacle Challenge' };
  assert.equal(validate({ ...base, url: 'https://acmestreaming.example.com/shows/pinnacle-challenge' }), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate({ ...base, url: 'not a uri' }), false);
});

test('get_brand_identity links a person to their collections', async () => {
  const response = await compile('/schemas/brand/get-brand-identity-response.json');
  const identity = {
    status: 'completed',
    brand_id: 'jordan_vega',
    house: { domain: 'jordanvega.example.com', name: 'Jordan Vega Media' },
    names: [{ en: 'Jordan Vega' }],
    collections: [{
      publisher_domain: 'acmestreaming.example.com',
      collection_id: 'pinnacle_challenge',
      name: 'The Pinnacle Challenge',
      role: 'host',
      seller_agent_url: 'https://sales.acmestreaming.example.com/adcp',
    }],
    available_fields: ['collections'],
  };
  assert.equal(response(identity), true, JSON.stringify(response.errors, null, 2));
  assert.equal(response({ ...identity, collections: [{ ...identity.collections[0], publisher_domain: 'Not A Domain' }] }), false);
  assert.equal(response({ ...identity, available_fields: ['avatar'] }), false, 'avatar is not a get_brand_identity field');
  const request = await compile('/schemas/brand/get-brand-identity-request.json');
  assert.equal(request({ brand_id: 'jordan_vega', fields: ['logos', 'collections'] }), true, JSON.stringify(request.errors, null, 2));
  assert.equal(request({ brand_id: 'jordan_vega', fields: ['avatar'] }), false);
});

test('response collection fields are experimental and added in 3.3.0', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, file), 'utf8'));
  const fields = [
    read('core/collection.json').properties.url,
    read('core/response-collection.json'),
    read('media-buy/get-products-response.json').properties.collections,
    read('media-buy/list-products-response.json').properties.collections,
    read('media-buy/request-proposals-response.json').properties.collections,
    read('media-buy/refine-proposals-response.json').properties.collections,
    read('brand/get-brand-identity-response.json').oneOf[0].properties.collections,
    read('brand.json').definitions.brand.properties.collections.items.properties.publisher_domain,
  ];
  for (const field of fields) {
    assert.equal(field['x-status'], 'experimental');
    assert.equal(field['x-added-in'], '3.3.0');
  }
  for (const file of ['get-products', 'list-products', 'request-proposals', 'refine-proposals']) {
    const schema = read(`media-buy/${file}-response.json`);
    assert.equal(schema.properties.collections.items.$ref, '/schemas/core/response-collection.json');
    assert.deepEqual(schema.dependencies.collections, ['products']);
  }
});

// Review fixes on #8141: opt-in flag, https url, brand link keys, feature ids, pin exclusion.
// Every discovery request accepts unknown fields. 3.2 published the three
// proposal-flow requests closed, so their flag warns that a 3.2 validator
// rejects it.
const ACCEPTS_UNKNOWN_FIELDS = /This request accepts unknown fields/;
const CLOSED_IN_3_2 = /The 3\.2 schema of this request rejects unknown fields/;
const requestCases = [
  ['/schemas/media-buy/get-products-request.json', { buying_mode: 'brief', brief: 'Creator video for a running shoe launch' }, ACCEPTS_UNKNOWN_FIELDS],
  ['/schemas/media-buy/list-products-request.json', { brand: { domain: 'nova-brands.example' } }, CLOSED_IN_3_2],
  ['/schemas/media-buy/request-proposals-request.json', {
    idempotency_key: 'req-proposals-0001',
    brief: 'Creator video for a running shoe launch',
    brand: { domain: 'nova-brands.example' },
  }, CLOSED_IN_3_2],
  ['/schemas/media-buy/refine-proposals-request.json', {
    idempotency_key: 'refine-proposals-0001',
    refinements: [{ proposal_id: 'proposal-1', action: 'finalize' }],
  }, CLOSED_IN_3_2],
];

for (const [schemaId, base, unknownFieldPhrasing] of requestCases) {
  test(`${schemaId} takes an optional experimental include_collections flag`, async () => {
    const validate = await compile(schemaId);
    assert.equal(validate(base), true, JSON.stringify(validate.errors, null, 2));
    assert.equal(validate({ ...base, include_collections: true }), true, JSON.stringify(validate.errors, null, 2));
    assert.equal(validate({ ...base, include_collections: 'yes' }), false, 'include_collections is a boolean');
    const schema = JSON.parse(fs.readFileSync(schemaPathFromId(schemaId), 'utf8'));
    const flag = schema.properties.include_collections;
    assert.equal(flag.type, 'boolean');
    assert.equal(flag.default, false);
    assert.equal(flag['x-status'], 'experimental');
    assert.equal(flag['x-added-in'], '3.3.0');
    assert.match(flag.description, /MUST NOT return collections unless this is true/);
    assert.notEqual(schema.additionalProperties, false, 'discovery requests accept unknown fields');
    assert.match(flag.description, unknownFieldPhrasing);
  });
}

test('response collections descriptions carry the opt-in and the closed freshness list', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, file), 'utf8'));
  for (const file of ['get-products', 'list-products', 'request-proposals', 'refine-proposals']) {
    const desc = read(`media-buy/${file}-response.json`).properties.collections.description;
    assert.match(desc, /unless the request set include_collections to true/, file);
    assert.match(desc, /only on images, sample_content, url, description, season, cadence and distribution\[\]\.followers/, file);
    assert.match(desc, /appears more than once, that collection is unresolvable/, file);
  }
  const item = read('core/response-collection.json').description;
  assert.match(item, /only on images, sample_content, url, description, season, cadence and distribution\[\]\.followers/);
  assert.doesNotMatch(item, /such as images, sample_content, status and talent/);
  assert.match(item, /unverified display data/);
});

test('collection url must be https', async () => {
  const validate = await compile('/schemas/core/collection.json');
  const base = { collection_id: 'pinnacle_challenge', name: 'The Pinnacle Challenge' };
  assert.equal(validate({ ...base, url: 'https://acmestreaming.example.com/shows/pinnacle-challenge' }), true);
  assert.equal(validate({ ...base, url: 'http://acmestreaming.example.com/shows/pinnacle-challenge' }), false);
  assert.equal(validate({ ...base, url: 'javascript:alert(1)' }), false);
});

test('get_brand_identity collection links require publisher_domain and collection_id', async () => {
  const response = await compile('/schemas/brand/get-brand-identity-response.json');
  const link = { publisher_domain: 'acmestreaming.example.com', collection_id: 'pinnacle_challenge', name: 'The Pinnacle Challenge' };
  const identity = {
    status: 'completed',
    brand_id: 'jordan_vega',
    house: { domain: 'jordanvega.example.com', name: 'Jordan Vega Media' },
    names: [{ en: 'Jordan Vega' }],
    collections: [link],
  };
  assert.equal(response(identity), true, JSON.stringify(response.errors, null, 2));
  for (const key of ['publisher_domain', 'collection_id', 'name']) {
    const { [key]: _omitted, ...rest } = link;
    assert.equal(response({ ...identity, collections: [rest] }), false, `${key} is required`);
  }
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, 'brand/get-brand-identity-response.json'), 'utf8'));
  const items = schema.oneOf[0].properties.collections.items;
  assert.equal(items.properties.collection_id['x-entity'], 'collection');
  assert.match(items.properties.seller_agent_url.description, /not authorization evidence/);
  // brand.json stays lenient: only name is required on its links.
  const brand = JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, 'brand.json'), 'utf8'));
  const brandLinks = brand.definitions.brand.properties.collections.items;
  assert.deepEqual(brandLinks.required, ['name']);
  assert.match(brandLinks.properties.seller_agent_url.description, /not authorization evidence/);
});

test('brand-side collection links use their own experimental feature id', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, file), 'utf8'));
  const brandSide = [
    read('brand/get-brand-identity-response.json').oneOf[0].properties.collections.description,
    read('brand/get-brand-identity-request.json').properties.fields.description,
    read('brand.json').definitions.brand.properties.collections.items.properties.publisher_domain.description,
  ];
  for (const desc of brandSide) {
    assert.match(desc, /brand\.collection_links/);
    assert.doesNotMatch(desc, /media_buy\.collection_cards/);
  }
  const registry = fs.readFileSync(path.join(__dirname, '../docs/reference/experimental-status.mdx'), 'utf8');
  const row = (id) => registry.split('\n').find((line) => line.startsWith(`| \`${id}\` |`));
  assert.ok(row('media_buy.collection_cards'), 'media_buy.collection_cards registry row');
  assert.ok(row('brand.collection_links'), 'brand.collection_links registry row');
  assert.match(row('media_buy.collection_cards'), /include_collections/);
  assert.doesNotMatch(row('media_buy.collection_cards'), /get_brand_identity/);
  assert.match(row('brand.collection_links'), /get_brand_identity/);
});

test('collection card fields are excluded from publisher_collection definition pins', () => {
  const vectors = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../static/compliance/source/test-vectors/definition-pins/vectors.json'), 'utf8'));
  const exclude = vectors.projection_rules.publisher_collection.exclude;
  for (const key of ['images', 'sample_content', 'url']) assert.ok(exclude.includes(key), `${key} is excluded`);
  const vector = vectors.equivalence_vectors.find((v) => v.id === 'collection-card-fields-are-not-drift');
  assert.ok(vector, 'an image-only change has an equivalence vector');
  assert.equal(vector.expected.same_content_digest, true);
  const spec = fs.readFileSync(path.join(__dirname, '../docs/media-buy/specification.mdx'), 'utf8');
  assert.ok(spec.includes('| `publisher_collection` | `description`, `ext`, `images`, `name`, `publisher_domain`, `related_collections`, `sample_content`, `season`, `talent`, `url` |'));
});

test('include_collections is part of the feed version scope', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, file), 'utf8'));
  const tuple = /deprecated property_list, catalog, include_collections\) for cache_scope: 'public'/;
  assert.match(read('media-buy/get-products-request.json').properties.if_wholesale_feed_version.description, tuple);
  assert.match(read('media-buy/get-products-response.json').properties.wholesale_feed_version.description, tuple);
  assert.match(read('media-buy/list-products-request.json').properties.if_feed_version.description, /include_collections is part of the selection/);
  assert.match(read('media-buy/list-products-response.json').properties.feed_version.description, /including include_collections/);
  const doc = fs.readFileSync(path.join(__dirname, '../docs/media-buy/task-reference/get_products.mdx'), 'utf8');
  assert.ok(doc.includes('| Public | `(agent, buying_mode, filters, targeting_overlay, media_buy_frequency_cap, required_overlay_support, required_media_buy_support, deprecated property_list, catalog, include_collections)` |'));
  assert.ok(doc.includes('deprecated property_list, catalog, include_collections, account_id)` |'));
  const guide = fs.readFileSync(path.join(__dirname, '../docs/media-buy/product-discovery/collections-and-installments.mdx'), 'utf8');
  assert.doesNotMatch(guide, /does not grow a new key/);
  assert.match(guide, /`include_collections` is part of the version scope/);
});
