const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

const fileDestination = {
  pattern: 'file_transfer',
  destination_id: 'reporting-archive',
  active: true,
  provider: { domain: 'object-store.example' },
  transport: 's3',
  location: 's3://pinnacle-reporting/adcp/',
  accepted_formats: ['parquet'],
  accepted_verification_profiles: ['manifest_checksums', 'canonical_digest'],
};

const warehouseDestination = {
  pattern: 'warehouse_materialization',
  destination_id: 'analytics-warehouse',
  active: true,
  provider: { domain: 'data-warehouse.example' },
  transport: 'bigquery',
  location: 'pinnacle-analytics.adcp_reporting',
  accepted_verification_profiles: ['native_commit', 'canonical_digest'],
};

const shareDestination = {
  pattern: 'dataset_share',
  destination_id: 'daily-share',
  active: true,
  provider: { domain: 'data-platform.example' },
  transport: 'delta_sharing',
  access_mode: 'open_sharing',
  recipient: { identity: 'reporting@example.com' },
  accepted_verification_profiles: ['native_commit'],
};

describe('sync_agent_configuration contract', () => {
  let validateRequest;
  let validateResponse;
  let validateDestination;
  let validateCapabilities;

  before(async () => {
    [validateRequest, validateResponse, validateDestination, validateCapabilities] = await Promise.all([
      compile('/schemas/protocol/sync-agent-configuration-request.json'),
      compile('/schemas/protocol/sync-agent-configuration-response.json'),
      compile('/schemas/core/agent-reporting-destination.json'),
      compile('/schemas/protocol/get-adcp-capabilities-response.json'),
    ]);
  });

  it('accepts one atomic replacement containing webhooks and reusable destinations', () => {
    const valid = validateRequest({
      idempotency_key: '528f1f06-e2a7-49b9-bd13-c953f35a1c49',
      expected_configuration_version: 'cfg_previous',
      configuration: {
        notification_configs: [{
          subscriber_id: 'buyer-events',
          url: 'https://buyer.example/webhooks/adcp',
          event_types: ['capabilities.changed'],
          active: true,
        }],
        reporting_destinations: [fileDestination, warehouseDestination, shareDestination],
      },
    });

    assert.equal(valid, true, JSON.stringify(validateRequest.errors));
  });

  it('requires at least one section while allowing empty arrays to clear a section', () => {
    assert.equal(validateRequest({
      idempotency_key: '528f1f06-e2a7-49b9-bd13-c953f35a1c49',
      configuration: {},
    }), false);

    assert.equal(validateRequest({
      idempotency_key: '528f1f06-e2a7-49b9-bd13-c953f35a1c49',
      configuration: { reporting_destinations: [] },
    }), true, JSON.stringify(validateRequest.errors));
  });

  it('rejects request-body attempts to assert caller identity', () => {
    for (const assertedIdentity of [
      { buyer_agent_url: 'https://attacker.example/adcp' },
      { agent_url: 'https://attacker.example/adcp' },
      { principal_id: 'someone-else' },
      { connection_id: 'conn_someone_else' },
    ]) {
      assert.equal(validateRequest({
        idempotency_key: '528f1f06-e2a7-49b9-bd13-c953f35a1c49',
        configuration: { reporting_destinations: [] },
        ...assertedIdentity,
      }), false);
    }
  });

  it('keeps every destination variant atomic and rejects secret-shaped schema fields', () => {
    for (const destination of [fileDestination, warehouseDestination, shareDestination]) {
      assert.equal(validateDestination(destination), true, JSON.stringify(validateDestination.errors));
    }

    assert.equal(validateDestination({
      ...warehouseDestination,
      credentials: {},
    }), false);

    assert.equal(validateDestination({
      ...fileDestination,
      location: 's3://access-key:secret@pinnacle-reporting/adcp/',
    }), false);

    assert.equal(validateDestination({
      ...fileDestination,
      location: 'https://object-store.example/archive?X-Amz-Signature=secret',
    }), false);

    assert.equal(validateDestination({
      ...warehouseDestination,
      provider: { domain: 'localhost' },
    }), false);

    assert.equal(validateDestination({
      ...shareDestination,
      recipient: { identity: 'recipient', cloud: 'aws' },
    }), false);
  });

  it('uses caller destination_id as a semantic uniqueness key', () => {
    const destinations = [fileDestination, { ...warehouseDestination, destination_id: fileDestination.destination_id }];
    const duplicateIds = destinations.length !== new Set(destinations.map(item => item.destination_id)).size;
    assert.equal(duplicateIds, true);

    const request = readSchema('/schemas/protocol/sync-agent-configuration-request.json');
    assert.match(request['x-adcp-validation'].atomic_sections, /uniqueness/);

    const destination = readSchema('/schemas/core/agent-reporting-destination.json');
    assert.match(destination['x-adcp-validation'].replacement, /new destination_ref/);
    assert.match(destination['x-adcp-validation'].replacement, /old references remain immutable/);
  });

  it('returns full credential-free state on success', () => {
    const valid = validateResponse({
      status: 'completed',
      result: {
        kind: 'applied',
        action: 'updated',
        dry_run: false,
        connection_id: 'conn_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        configuration_version: 'cfg_01K4C6V2N5PC1TQAH9WTT8D2HP',
        configuration: {
          notification_configs: [],
          reporting_destinations: [{
            destination_id: warehouseDestination.destination_id,
            destination_ref: 'dest_01K4C6T6Q0A9E6Y3N1FQ1T8YKV',
            state: 'ready',
            configuration: warehouseDestination,
          }],
        },
      },
    });

    assert.equal(valid, true, JSON.stringify(validateResponse.errors));

    assert.equal(validateResponse({
      status: 'completed',
      result: {
        kind: 'applied',
        action: 'updated',
        dry_run: false,
        connection_id: 'conn_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        configuration_version: 'cfg_01K4C6V2N5PC1TQAH9WTT8D2HP',
        configuration: {
          notification_configs: [{
            subscriber_id: 'buyer-events',
            url: 'https://buyer.example/webhooks/adcp',
            event_types: ['capabilities.changed'],
            authentication: {
              schemes: ['HMAC-SHA256'],
              credentials: 'this-write-only-secret-must-never-be-returned',
            },
          }],
          reporting_destinations: [],
        },
      },
    }), false);

    assert.equal(validateResponse({
      status: 'completed',
      result: {
        kind: 'applied',
        action: 'updated',
        dry_run: false,
        connection_id: 'conn_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        configuration_version: 'cfg_01K4C6V2N5PC1TQAH9WTT8D2HP',
        configuration: {
          notification_configs: [],
          reporting_destinations: [{
            destination_id: warehouseDestination.destination_id,
            destination_ref: 'dest_01K4C6T6Q0A9E6Y3N1FQ1T8YKV',
            state: 'action_required',
            configuration: warehouseDestination,
            setup: {
              action: 'grant_access',
              setup_url: 'https://data-warehouse.example/setup?token=must-not-be-embedded',
            },
          }],
        },
      },
    }), false);
  });

  it('makes failed result arms incapable of leaking connection state', () => {
    assert.equal(validateResponse({
      status: 'failed',
      result: {
        kind: 'failed',
        errors: [{ code: 'AUTH_INVALID', message: 'Authentication failed' }],
      },
    }), true, JSON.stringify(validateResponse.errors));

    assert.equal(validateResponse({
      status: 'failed',
      result: {
        kind: 'failed',
        errors: [{ code: 'AUTH_INVALID', message: 'Authentication failed' }],
        connection_id: 'leaked_connection',
        configuration_version: 'leaked_version',
      },
    }), false);
  });

  it('returns no durable identifiers from dry-run validation', () => {
    assert.equal(validateResponse({
      status: 'completed',
      result: {
        kind: 'validated',
        action: 'would_update',
        dry_run: true,
      },
    }), true, JSON.stringify(validateResponse.errors));

    assert.equal(validateResponse({
      status: 'completed',
      result: {
        kind: 'validated',
        action: 'would_update',
        dry_run: true,
        destination_ref: 'must_not_be_issued',
      },
    }), false);
  });

  it('requires the experimental feature declaration for agent configuration capabilities', () => {
    const capabilities = {
      status: 'completed',
      adcp: {
        major_versions: [3],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        agent_configuration: {
          supported: true,
          sync_task: 'sync_agent_configuration',
          supported_sections: ['notification_configs', 'reporting_destinations'],
          max_reporting_destinations: 16,
          optimistic_concurrency: true,
        },
        capability_changes: {
          capabilities_version: 'rev_20260828_1',
          cache_ttl_seconds: 3600,
          notifications: {
            supported: true,
            registration_task: 'sync_agent_configuration',
            event_types: ['capabilities.changed'],
          },
        },
      },
      supported_protocols: ['media_buy'],
      experimental_features: ['protocol.agent_configuration'],
      webhook_signing: { supported: true },
    };

    assert.equal(validateCapabilities(capabilities), true, JSON.stringify(validateCapabilities.errors));
    const { experimental_features, ...withoutFeature } = capabilities;
    assert.equal(validateCapabilities(withoutFeature), false);

    const withoutAgentConfiguration = {
      ...capabilities,
      adcp: {
        major_versions: [3],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: capabilities.adcp.capability_changes,
      },
    };
    assert.equal(validateCapabilities(withoutAgentConfiguration), false);
  });
});
