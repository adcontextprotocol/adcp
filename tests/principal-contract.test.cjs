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

describe('sync_principal contract', () => {
  let validateRequest;
  let validateResponse;
  let validateDestination;
  let validateCapabilities;
  let validateReadRequest;
  let validateReadResponse;
  let validateDestinationState;

  before(async () => {
    [
      validateRequest,
      validateResponse,
      validateDestination,
      validateCapabilities,
      validateReadRequest,
      validateReadResponse,
      validateDestinationState,
    ] = await Promise.all([
      compile('/schemas/protocol/sync-principal-request.json'),
      compile('/schemas/protocol/sync-principal-response.json'),
      compile('/schemas/core/agent-reporting-destination.json'),
      compile('/schemas/protocol/get-adcp-capabilities-response.json'),
      compile('/schemas/protocol/get-principal-request.json'),
      compile('/schemas/protocol/get-principal-response.json'),
      compile('/schemas/core/agent-reporting-destination-state.json'),
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

  it('defines delegated users and workloads as principals without requiring agent registration', () => {
    const request = readSchema('/schemas/protocol/sync-principal-request.json');
    const rules = request['x-adcp-validation'];

    assert.match(request.description, /does not register a buyer agent/);
    assert.match(rules.stable_principal, /delegated human user/);
    assert.match(rules.stable_principal, /autonomous workload/);
    assert.match(rules.stable_principal, /MUST NOT require registration/);
    assert.match(rules.stable_principal, /shared service identity/);
    assert.match(rules.credential_rotation, /same stable principal/);
    assert.match(rules.principal_isolation, /explicitly authorized administrative operation/);
    assert.match(rules.account_authority, /independently authorize the account-scoped feed binding/);
  });

  it('keeps every destination variant atomic and rejects secret-shaped schema fields', () => {
    for (const destination of [fileDestination, warehouseDestination, shareDestination]) {
      assert.equal(validateDestination(destination), true, JSON.stringify(validateDestination.errors));
    }

    assert.equal(validateDestination({
      ...warehouseDestination,
      credentials: {},
    }), false);

    // Structural guard: query strings, fragments, percent-encoding, and
    // whitespace cannot appear in a locator.
    for (const location of [
      'https://object-store.example/archive?X-Amz-Signature=secret',
      's3://pinnacle-reporting/adcp/#token=secret',
      's3://access-key:secret%40pinnacle-reporting/adcp/',
      's3://pinnacle-reporting/ad cp/',
    ]) {
      assert.equal(validateDestination({ ...fileDestination, location }), false, location);
    }

    // Legitimate authority-embedded '@' locators (Azure ABFSS) validate; the
    // userinfo credential shape is screened at runtime, not by the pattern.
    assert.equal(validateDestination({
      ...fileDestination,
      transport: 'azure_blob',
      location: 'abfss://container@account.dfs.core.windows.net/adcp',
    }), true, JSON.stringify(validateDestination.errors));

    const destination = readSchema('/schemas/core/agent-reporting-destination.json');
    assert.match(destination['x-adcp-validation'].secret_rejection, /key:secret@host/);
    assert.match(destination['x-adcp-validation'].normalization, /canonicalize/);
    for (const pattern of destination.oneOf.map(branch => branch.properties.location?.pattern).filter(Boolean)) {
      assert.doesNotMatch(pattern, /\(\?/, 'location patterns must stay RE2-compatible (no lookaheads)');
    }

    assert.equal(validateDestination({
      ...warehouseDestination,
      provider: { domain: 'localhost' },
    }), false);

    assert.equal(validateDestination({
      ...shareDestination,
      recipient: { identity: 'recipient', cloud: 'aws' },
    }), false);
  });

  it('defines per-pattern proof, suspension, and revocation as normative rules', () => {
    const destination = readSchema('/schemas/core/agent-reporting-destination.json');
    const rules = destination['x-adcp-validation'];

    assert.match(rules.proof_file_transfer, /write-probe|written and read back/);
    assert.match(rules.proof_warehouse_materialization, /create and commit/);
    assert.match(rules.proof_dataset_share, /recipient-side acceptance/);
    assert.match(rules.proof_dataset_share, /grant creation alone MUST NOT produce ready/i);
    assert.match(rules.suspension_and_revocation, /stop initiating new deliveries/);
    assert.match(rules.suspension_and_revocation, /revokes/);

    const state = readSchema('/schemas/core/agent-reporting-destination-state.json');
    assert.match(state.properties.state.description, /recipient readability/);
  });

  it('uses caller destination_id as a semantic uniqueness key', () => {
    const destinations = [fileDestination, { ...warehouseDestination, destination_id: fileDestination.destination_id }];
    const duplicateIds = destinations.length !== new Set(destinations.map(item => item.destination_id)).size;
    assert.equal(duplicateIds, true);

    const request = readSchema('/schemas/protocol/sync-principal-request.json');
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
        principal_id: 'prin_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        principal_kind: 'buyer_agent',
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
        principal_id: 'prin_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        principal_kind: 'buyer_agent',
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
        principal_id: 'prin_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        principal_kind: 'buyer_agent',
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

  it('makes failed result arms incapable of leaking principal state', () => {
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
        principal_id: 'leaked_principal',
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
        principal: {
          supported: true,
          sync_task: 'sync_principal',
          read_task: 'get_principal',
          supported_sections: ['notification_configs', 'reporting_destinations'],
          max_reporting_destinations: 16,
          reporting_destination_offerings: [
            {
              pattern: 'file_transfer',
              transports: ['s3'],
              formats: ['parquet'],
              verification_profiles: ['manifest_checksums', 'canonical_digest'],
            },
            {
              pattern: 'warehouse_materialization',
              transports: ['bigquery'],
              verification_profiles: ['native_commit', 'canonical_digest'],
            },
            {
              pattern: 'dataset_share',
              transports: ['delta_sharing'],
              access_modes: ['open_sharing'],
              verification_profiles: ['native_commit'],
            },
          ],
          suspension_interval_seconds: 900,
          optimistic_concurrency: true,
        },
        capability_changes: {
          capabilities_version: 'rev_20260828_1',
          cache_ttl_seconds: 3600,
          notifications: {
            supported: true,
            registration_task: 'sync_principal',
            event_types: ['capabilities.changed'],
          },
        },
      },
      supported_protocols: ['media_buy'],
      experimental_features: ['protocol.principal'],
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

  it('provides a side-effect-free read task that rejects body identity', () => {
    assert.equal(validateReadRequest({}), true, JSON.stringify(validateReadRequest.errors));

    for (const assertedIdentity of [
      { connection_id: 'conn_someone_else' },
      { principal_id: 'someone-else' },
    ]) {
      assert.equal(validateReadRequest(assertedIdentity), false);
    }

    const request = readSchema('/schemas/protocol/get-principal-request.json');
    assert.match(request['x-adcp-validation'].read_only, /MUST NOT mutate/);
    assert.match(request['x-adcp-validation'].read_only, /do not advance the version/);
    assert.match(request['x-adcp-validation'].principal_isolation, /unconfigured/);
  });

  it('reads back current state, retained generations, and an unconfigured arm without leaks', () => {
    assert.equal(validateReadResponse({
      status: 'completed',
      result: {
        kind: 'current',
        principal_id: 'prin_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        principal_kind: 'buyer_agent',
        configuration_version: 'cfg_01K4C6V2N5PC1TQAH9WTT8D2HP',
        configuration: {
          notification_configs: [],
          reporting_destinations: [{
            destination_id: warehouseDestination.destination_id,
            destination_ref: 'dest_01K4C6T6Q0A9E6Y3N1FQ1T8YKV',
            prior_destination_refs: ['dest_01K4C5A2M9XPZ0T4B7QCW3JHRD'],
            state: 'ready',
            configuration: warehouseDestination,
          }],
          retired_destinations: [{
            destination_id: 'old-archive',
            destination_refs: ['dest_01K4C4XYZ0A9E6Y3N1FQ1T8YKA'],
            revoked_at: '2026-08-29T00:00:00Z',
          }],
        },
      },
    }), true, JSON.stringify(validateReadResponse.errors));

    assert.equal(validateReadResponse({
      status: 'completed',
      result: { kind: 'unconfigured' },
    }), true, JSON.stringify(validateReadResponse.errors));

    assert.equal(validateReadResponse({
      status: 'failed',
      result: {
        kind: 'failed',
        errors: [{ code: 'AUTH_INVALID', message: 'Authentication failed' }],
        principal_id: 'leaked_principal',
      },
    }), false);
  });

  it('accepts caller-eligible event types and rejects media-buy-anchored ones', async () => {
    const validateNotificationConfig = await compile('/schemas/core/agent-notification-config.json');
    const base = {
      subscriber_id: 'buyer-events',
      url: 'https://buyer.example/webhooks/adcp',
    };

    for (const eventTypes of [
      ['capabilities.changed'],
      ['principal.changed'],
    ]) {
      assert.equal(validateNotificationConfig({ ...base, event_types: eventTypes }), true,
        JSON.stringify(validateNotificationConfig.errors));
    }

    // Account-anchored types require the explicit all-accounts scope
    // acknowledgment — never implicit.
    const accountScoped = ['capabilities.changed', 'principal.changed', 'creative.status_changed', 'account.change_recorded'];
    assert.equal(validateNotificationConfig({ ...base, event_types: accountScoped }), false,
      'account-anchored types without all_authorized_accounts must be rejected');
    assert.equal(validateNotificationConfig({ ...base, event_types: accountScoped, all_authorized_accounts: false }), false);
    assert.equal(validateNotificationConfig({
      ...base,
      event_types: accountScoped,
      all_authorized_accounts: true,
    }), true, JSON.stringify(validateNotificationConfig.errors));

    for (const mediaBuyType of ['scheduled', 'final', 'delayed', 'adjusted', 'window_update', 'impairment']) {
      assert.equal(validateNotificationConfig({ ...base, event_types: [mediaBuyType] }), false, mediaBuyType);
    }

    assert.equal(validateNotificationConfig({
      ...base,
      event_types: ['capabilities.changed'],
      include_future_event_types: true,
    }), true, JSON.stringify(validateNotificationConfig.errors));

    const config = readSchema('/schemas/core/agent-notification-config.json');
    assert.match(config.properties.include_future_event_types.description, /invalidation-only/);
    assert.match(config.properties.all_authorized_accounts.description, /never implicit/);
    assert.match(config.properties.all_authorized_accounts.description, /queued retries/);
  });

  it('round-trips declarations with a seller-computed accepted intersection', async () => {
    const validateWebhook = await compile('/schemas/core/principal-changed-webhook.json');

    const declarations = {
      async_adcp_versions: ['3.2'],
      webhook_signing_algorithms: ['ed25519', 'ecdsa-p256-sha256'],
      experimental_features: ['protocol.principal'],
    };

    assert.equal(validateRequest({
      idempotency_key: '528f1f06-e2a7-49b9-bd13-c953f35a1c49',
      configuration: { declarations },
    }), true, JSON.stringify(validateRequest.errors));

    // {} is the documented clear form for the declarations section.
    assert.equal(validateRequest({
      idempotency_key: '528f1f06-e2a7-49b9-bd13-c953f35a1c49',
      configuration: { declarations: {} },
    }), true, JSON.stringify(validateRequest.errors));

    assert.equal(validateReadResponse({
      status: 'completed',
      result: {
        kind: 'current',
        principal_id: 'prin_01K4C6RGT5Q18VCPGXE7DDWQ5F',
        principal_kind: 'buyer_agent',
        configuration_version: 'cfg_01K4C6V2N5PC1TQAH9WTT8D2HP',
        configuration: {
          declarations: {
            declared: declarations,
            accepted: {
              async_adcp_versions: ['3.2'],
              webhook_signing_algorithms: ['ed25519'],
            },
            selected_async_adcp_version: '3.2',
            exclusions: [
              {
                axis: 'webhook_signing_algorithms',
                value: 'ecdsa-p256-sha256',
                reason: 'This seller signs webhooks with ed25519 only.',
              },
              {
                axis: 'experimental_features',
                value: 'protocol.principal',
                reason: 'Declared feature is not an async payload opt-in on this seller.',
              },
            ],
          },
        },
      },
    }), true, JSON.stringify(validateReadResponse.errors));

    assert.equal(validateWebhook({
      idempotency_key: '9f2c1e57-3f6a-4f4e-9f0d-2a45b7c6e881',
      notification_id: 'conn_txn_01K4D0Z3M8Q0V5T2C9XWJ7R4BA',
      notification_type: 'principal.changed',
      fired_at: '2026-08-29T12:00:05Z',
      subscriber_id: 'buyer-events',
      agent_url: 'https://sales.streamhaus.example/adcp',
      changed_at: '2026-08-29T12:00:03Z',
      reason: 'declarations_intersection_changed',
    }), true, JSON.stringify(validateWebhook.errors));

    const request = readSchema('/schemas/protocol/sync-principal-request.json');
    assert.match(request['x-adcp-validation'].declarations_intersection, /UNSUPPORTED_FEATURE/);
    assert.match(request['x-adcp-validation'].caller_level_account_events, /each delivery attempt/);
    assert.match(request['x-adcp-validation'].caller_level_account_events, /all_authorized_accounts/);
  });

  it('couples suspension state to inactive configuration in both directions', () => {
    const validateState = validateDestinationState;

    assert.equal(validateState({
      destination_id: warehouseDestination.destination_id,
      destination_ref: 'dest_01K4C6T6Q0A9E6Y3N1FQ1T8YKV',
      state: 'ready',
      configuration: { ...warehouseDestination, active: false },
    }), false, 'active:false must not read back as ready');

    assert.equal(validateState({
      destination_id: warehouseDestination.destination_id,
      destination_ref: 'dest_01K4C6T6Q0A9E6Y3N1FQ1T8YKV',
      state: 'inactive',
      configuration: { ...warehouseDestination, active: false },
    }), true, JSON.stringify(validateState.errors));
  });
});
