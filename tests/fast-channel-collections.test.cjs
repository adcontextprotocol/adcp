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
