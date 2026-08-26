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
      identifiers: [{ type: 'publisher_channel_id', value: 'channel_942' }],
    }],
  };

  assert.equal(validate(collection), true, JSON.stringify(validate.errors, null, 2));
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
