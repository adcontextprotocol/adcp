const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const SCHEMA_BASE_DIR = path.join(__dirname, '..', 'static', 'schemas', 'source');

async function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) {
    throw new Error('Cannot load external schema: ' + uri);
  }
  const schemaPath = path.resolve(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
  if (schemaPath !== SCHEMA_BASE_DIR && !schemaPath.startsWith(SCHEMA_BASE_DIR + path.sep)) {
    throw new Error('Schema ref escapes base directory: ' + uri);
  }
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

async function compile(relativePath) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: loadExternalSchema
  });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_BASE_DIR, relativePath), 'utf8'));
  return ajv.compileAsync(schema);
}

function assertValid(validate, payload) {
  const valid = validate(payload);
  assert.equal(valid, true, ajvErrors(validate));
}

function ajvErrors(validate) {
  return (validate.errors || [])
    .map((error) => (error.instancePath || 'root') + ': ' + error.message)
    .join('; ');
}

describe('relationship-scoped indicators', () => {
  let validateIndicator;
  let validateIndicatorBearing;
  let validateListCreatives;
  let validateGetMediaBuys;
  let validateCapabilities;
  let validateListRequest;
  let validateGetRequest;
  let validateCreateResponse;
  let validateUpdateResponse;
  let validateSyncResponse;
  let validateIndicatorsWebhook;
  let validateAssignmentWebhook;
  let validateNotificationConfig;

  before(async () => {
    [
      validateIndicator,
      validateIndicatorBearing,
      validateListCreatives,
      validateGetMediaBuys,
      validateCapabilities,
      validateListRequest,
      validateGetRequest,
      validateCreateResponse,
      validateUpdateResponse,
      validateSyncResponse,
      validateIndicatorsWebhook,
      validateAssignmentWebhook,
      validateNotificationConfig
    ] = await Promise.all([
      compile('core/indicator.json'),
      compile('core/indicator-bearing.json'),
      compile('creative/list-creatives-response.json'),
      compile('media-buy/get-media-buys-response.json'),
      compile('protocol/get-adcp-capabilities-response.json'),
      compile('creative/list-creatives-request.json'),
      compile('media-buy/get-media-buys-request.json'),
      compile('media-buy/create-media-buy-response.json'),
      compile('media-buy/update-media-buy-response.json'),
      compile('creative/sync-creatives-response.json'),
      compile('core/indicators-changed-webhook.json'),
      compile('creative/creative-assignment-changed-webhook.json'),
      compile('core/notification-config.json')
    ]);
  });

  it('keeps the core indicator compact and tied to the AdCP release', () => {
    assertValid(validateIndicator, {
      type: 'creative_fatigue',
      detected_at: '2026-08-03T09:00:00Z',
      scope: [{
        publisher_domain: 'publisher-a.example',
        placement_id: 'feed'
      }],
      ext: {
        seller_example: {
          fatigue_rate: 0.47,
          window_days: 7
        }
      }
    });

    assert.equal(validateIndicator({ type: 'seller_specific_fatigue_v2' }), false);
  });

  it('places fatigue on a list_creatives package assignment', () => {
    assertValid(validateListCreatives, {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [{
        creative_id: 'creative_1',
        name: 'Acme summer video',
        format_kind: 'image',
        status: 'approved',
        created_date: '2026-08-01T00:00:00Z',
        updated_date: '2026-08-03T09:00:00Z',
        assignments: {
          assignment_count: 2,
          returned_assignment_count: 2,
          assignments_truncated: false,
          assigned_packages: [
            {
              package_id: 'pkg_publisher_a',
              media_buy_id: 'mb_1',
              assigned_date: '2026-08-01T00:00:00Z',
              approval_status: 'approved',
              indicator_types_evaluated: ['creative_fatigue'],
              indicators_as_of: '2026-08-04T12:00:00Z',
              indicators: [{
                type: 'creative_fatigue',
                detected_at: '2026-08-03T09:00:00Z'
              }]
            },
            {
              package_id: 'pkg_publisher_b',
              media_buy_id: 'mb_2',
              assigned_date: '2026-08-01T00:00:00Z',
              approval_status: 'pending_review'
            }
          ]
        }
      }]
    });
  });

  it('places the same fatigue assertion on the get_media_buys relationship', () => {
    assertValid(validateGetMediaBuys, {
      status: 'completed',
      media_buys: [{
        media_buy_id: 'mb_1',
        status: 'active',
        currency: 'USD',
        total_budget: 1000,
        confirmed_at: '2026-08-01T00:00:00Z',
        revision: 1,
        packages: [{
          package_id: 'pkg_publisher_a',
          creative_approvals: [{
            creative_id: 'creative_1',
            approval_status: 'approved',
            indicator_types_evaluated: ['creative_fatigue'],
            indicators_as_of: '2026-08-04T12:00:00Z',
            indicators: [{
              type: 'creative_fatigue',
              detected_at: '2026-08-03T09:00:00Z'
            }]
          }]
        }]
      }],
      pagination: { has_more: false }
    });
  });

  it('advertises supported types without a separate feature or type version', () => {
    const fullCapabilities = {
      status: 'completed',
      supported_protocols: ['media_buy', 'creative'],
      adcp: {
        major_versions: [3],
        idempotency: { supported: false }
      },
      account: {
        supported_billing: ['operator']
      },
      media_buy: {
        supported_indicator_types: [
          'creative_fatigue',
          'creative_quality_opportunity',
          'creative_diversity_low',
          'audience_saturation',
          'inventory_shortfall_forecast',
          'pacing_risk',
          'budget_constrained'
        ],
        relationship_notifications: {
          supported: true,
          registration_task: 'sync_accounts',
          event_types: ['indicators.changed', 'creative.assignment_changed'],
          repair_tasks: ['get_media_buys'],
          projection_tasks: ['list_creatives'],
          supports_webhook_activity: true
        }
      },
      webhook_signing: {
        supported: true,
        profile: 'adcp/webhook-signing/v1',
        algorithms: ['ed25519'],
        legacy_hmac_fallback: false
      }
    };
    assertValid(validateCapabilities, fullCapabilities);

    const unsigned = {
      status: 'completed',
      supported_protocols: ['media_buy', 'creative'],
      adcp: {
        major_versions: [3],
        idempotency: { supported: false }
      },
      account: { supported_billing: ['operator'] },
      media_buy: {
        supported_indicator_types: ['creative_fatigue'],
        relationship_notifications: {
          supported: true,
          registration_task: 'sync_accounts',
          event_types: ['indicators.changed', 'creative.assignment_changed'],
          repair_tasks: ['get_media_buys'],
          projection_tasks: ['list_creatives']
        }
      }
    };
    assert.equal(validateCapabilities(unsigned), false);
    assert.equal(validateCapabilities({
      ...unsigned,
      webhook_signing: { supported: true }
    }), false);
    assertValid(validateCapabilities, {
      ...unsigned,
      webhook_signing: {
        supported: true,
        profile: 'adcp/webhook-signing/v1',
        algorithms: ['ed25519'],
        legacy_hmac_fallback: false
      }
    });

    const inlineOnlyCapabilities = {
      status: 'completed',
      supported_protocols: ['media_buy'],
      adcp: { major_versions: [3], idempotency: { supported: false } },
      account: { supported_billing: ['operator'] },
      media_buy: {
        supported_indicator_types: ['budget_constrained'],
        relationship_notifications: {
          supported: true,
          registration_task: 'sync_accounts',
          event_types: ['indicators.changed'],
          repair_tasks: ['get_media_buys']
        }
      },
      webhook_signing: {
        supported: true,
        profile: 'adcp/webhook-signing/v1',
        algorithms: ['ed25519'],
        legacy_hmac_fallback: false
      }
    };
    assertValid(validateCapabilities, inlineOnlyCapabilities);
    assert.equal(validateCapabilities({
      ...inlineOnlyCapabilities,
      media_buy: {
        ...inlineOnlyCapabilities.media_buy,
        relationship_notifications: {
          ...inlineOnlyCapabilities.media_buy.relationship_notifications,
          event_types: ['creative.assignment_changed']
        }
      }
    }), false);
    assertValid(validateCapabilities, {
      ...inlineOnlyCapabilities,
      media_buy: {
        ...inlineOnlyCapabilities.media_buy,
        relationship_notifications: {
          ...inlineOnlyCapabilities.media_buy.relationship_notifications,
          event_types: ['indicators.changed', 'creative.assignment_changed']
        }
      }
    });
    assert.equal(validateCapabilities({
      ...inlineOnlyCapabilities,
      media_buy: {
        ...inlineOnlyCapabilities.media_buy,
        relationship_notifications: {
          ...inlineOnlyCapabilities.media_buy.relationship_notifications,
          projection_tasks: ['list_creatives']
        }
      }
    }), false);
    assertValid(validateCapabilities, {
      ...inlineOnlyCapabilities,
      supported_protocols: ['media_buy', 'creative'],
      media_buy: {
        ...inlineOnlyCapabilities.media_buy,
        relationship_notifications: {
          ...inlineOnlyCapabilities.media_buy.relationship_notifications,
          repair_tasks: ['get_media_buys'],
          projection_tasks: ['list_creatives']
        }
      }
    });

    const assignmentOnlyCapabilities = {
      ...inlineOnlyCapabilities,
      media_buy: {
        relationship_notifications: {
          supported: true,
          registration_task: 'sync_accounts',
          event_types: ['creative.assignment_changed'],
          repair_tasks: ['get_media_buys']
        }
      }
    };
    assertValid(validateCapabilities, assignmentOnlyCapabilities);
    assert.equal(validateCapabilities({
      ...assignmentOnlyCapabilities,
      media_buy: {
        relationship_notifications: {
          ...assignmentOnlyCapabilities.media_buy.relationship_notifications,
          event_types: ['indicators.changed']
        }
      }
    }), false);
  });

  it('supports indicator filters on both existing resource reads', () => {
    assertValid(validateListRequest, {
      filters: { indicator_types: ['creative_fatigue'] },
      fields: ['creative_id', 'assignments'],
      assignment_projection: 'matching',
      assignment_limit: 50,
      pagination: { max_results: 100 }
    });
    assertValid(validateGetRequest, {
      indicator_types: ['creative_fatigue'],
      pagination: { max_results: 100 }
    });
  });

  it('supports a bounded creative assignment projection with the released item envelope', () => {
    assertValid(validateListCreatives, {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [{
        creative_id: 'creative_1',
        name: 'Creative one',
        format_kind: 'image',
        status: 'approved',
        created_date: '2026-08-01T00:00:00Z',
        updated_date: '2026-08-04T12:00:00Z',
        assignments: {
          assignment_count: 300,
          returned_assignment_count: 1,
          matching_assignment_count: 1,
          assignments_truncated: false,
          assigned_packages: [{
            package_id: 'pkg_1',
            media_buy_id: 'mb_1',
            assigned_date: '2026-08-01T00:00:00Z',
            approval_status: 'approved',
            indicator_types_evaluated: ['creative_fatigue'],
            indicators_as_of: '2026-08-04T12:00:00Z',
            indicators: [{ type: 'creative_fatigue' }]
          }]
        }
      }]
    });
  });

  it('represents mixed publisher approval without flattening it', () => {
    assertValid(validateGetMediaBuys, {
      status: 'completed',
      media_buys: [{
        media_buy_id: 'mb_1',
        status: 'active',
        currency: 'USD',
        total_budget: 1000,
        confirmed_at: '2026-08-01T00:00:00Z',
        revision: 1,
        packages: [{
          package_id: 'pkg_1',
          creative_approvals: [{
            creative_id: 'creative_1',
            approval_status: 'partially_approved',
            approval_scopes: [
              {
                scope: { publisher_domain: 'publisher-a.example' },
                approval_status: 'approved'
              },
              {
                scope: { publisher_domain: 'publisher-b.example' },
                approval_status: 'rejected',
                rejection_reason: 'Local policy restriction.'
              }
            ]
          }]
        }]
      }],
      pagination: { has_more: false }
    });
  });

  it('enforces snapshot schema rules and behavioral conformance vectors', () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(
      __dirname,
      '..',
      'static',
      'compliance',
      'source',
      'test-vectors',
      'relationship-scoped-indicators.json'
    ), 'utf8'));

    function normalizedScope(scope = []) {
      return scope
        .map((item) => item.publisher_domain + '|' + (item.placement_id || ''))
        .sort()
        .join(',');
    }

    function semanticsValid(snapshot) {
      const evaluatedScopes = snapshot.indicators_evaluated_scope || [];
      const keys = new Set();
      for (const indicator of snapshot.indicators || []) {
        const key = indicator.type + '::' + normalizedScope(indicator.scope);
        if (keys.has(key)) return false;
        keys.add(key);
        if (evaluatedScopes.length) {
          for (const asserted of indicator.scope || []) {
            const contained = evaluatedScopes.some((covered) =>
              covered.publisher_domain === asserted.publisher_domain &&
              (!covered.placement_id || covered.placement_id === asserted.placement_id));
            if (!contained) return false;
          }
        }
      }
      return true;
    }

    for (const vector of vectors.indicator_snapshot_cases) {
      const actual = validateIndicatorBearing(vector.snapshot) && semanticsValid(vector.snapshot);
      assert.equal(actual, vector.valid, vector.name + ': ' + ajvErrors(validateIndicatorBearing));
    }

    function firesForVector(vector) {
      const firesByEvent = {
        subscriber_activated: [],
        assertion_set_changed: ['indicators.changed'],
        indicators_as_of_only_changed: [],
        creative_content_materially_changed: ['indicators.changed']
      };
      if (vector.event !== 'assignment_removed') {
        return [...firesByEvent[vector.event]];
      }
      const fires = [];
      if (vector.retires_stored_indicator_keys &&
          vector.advertised_event_types.includes('indicators.changed')) {
        fires.push('indicators.changed');
      }
      if (vector.advertised_event_types.includes('creative.assignment_changed')) {
        fires.push('creative.assignment_changed');
      }
      return fires;
    }
    for (const vector of vectors.webhook_lifecycle_cases) {
      assert.deepEqual(firesForVector(vector), vector.expected_fires, vector.name);
      if (vector.baseline_request) {
        assertValid(validateGetRequest, vector.baseline_request);
        assert.deepEqual(vector.baseline_request.status_filter, [
          'pending_creatives',
          'pending_start',
          'active',
          'paused',
          'completed',
          'rejected',
          'canceled'
        ], vector.name + ': baseline covers every status');
        assert.equal(vector.must_exhaust_pagination, true, vector.name + ': baseline exhausts pagination');
      }
    }

    const requiredIndicatorByWarning = {
      inventory_shortfall_forecast: 'inventory_shortfall_forecast',
      flight_change_creates_pacing_risk: 'pacing_risk'
    };
    for (const vector of vectors.warning_capability_cases) {
      const requiredType = requiredIndicatorByWarning[vector.warning_code];
      const actual = !requiredType || vector.supported_indicator_types.includes(requiredType);
      assert.equal(actual, vector.valid, vector.name);
    }

    function projectionCountsValid(vector) {
      const assignment = vector.assignments;
      const returned = assignment.returned_assignment_count;
      if (returned !== assignment.assigned_packages.length) return false;
      if (returned > assignment.assignment_count) return false;
      const isMatching = vector.projection === 'matching';
      const hasMatchingCount = Object.hasOwn(assignment, 'matching_assignment_count');
      if (isMatching !== hasMatchingCount) return false;
      const qualifying = isMatching
        ? assignment.matching_assignment_count
        : assignment.assignment_count;
      if (qualifying < returned || qualifying > assignment.assignment_count) return false;
      return assignment.assignments_truncated === (qualifying > returned);
    }

    for (const vector of vectors.assignment_projection_count_cases) {
      assertValid(validateListCreatives, {
        status: 'completed',
        query_summary: { total_matching: 1, returned: 1 },
        pagination: { has_more: false },
        creatives: [{
          creative_id: 'cv_test',
          name: 'test creative',
          format_kind: 'image',
          status: 'approved',
          created_date: '2026-08-01T00:00:00Z',
          updated_date: '2026-08-01T00:00:00Z',
          assignments: vector.assignments
        }]
      });
      assert.equal(projectionCountsValid(vector), vector.valid, vector.name);
    }

    for (const vector of vectors.delivery_identity_cases) {
      const sameNotification = vector.prior.notification_id === vector.next.notification_id;
      const validIdentity = vector.mode === 'retry'
        ? sameNotification && vector.prior.idempotency_key === vector.next.idempotency_key
        : sameNotification && vector.prior.idempotency_key !== vector.next.idempotency_key;
      assert.equal(validIdentity, vector.valid, vector.name);
    }

    for (const vector of vectors.approval_scope_cases) {
      const exactScopes = new Set();
      const publisherModes = new Map();
      let validPartition = true;
      for (const outcome of vector.approval_scopes) {
        const scope = outcome.scope;
        const key = scope.publisher_domain + '|' + (scope.placement_id || '');
        if (exactScopes.has(key)) validPartition = false;
        exactScopes.add(key);
        const mode = scope.placement_id ? 'placement' : 'publisher';
        const priorMode = publisherModes.get(scope.publisher_domain);
        if (priorMode && priorMode !== mode) validPartition = false;
        publisherModes.set(scope.publisher_domain, mode);
      }
      assert.equal(validPartition, vector.valid, vector.name);
    }
  });

  it('uses omission for unknown and an empty array for evaluated-no-indicator', () => {
    assertValid(validateListCreatives, {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [{
        creative_id: 'creative_1',
        name: 'Acme summer image',
        format_kind: 'image',
        status: 'approved',
        created_date: '2026-08-01T00:00:00Z',
        updated_date: '2026-08-04T12:00:00Z',
        assignments: {
          assignment_count: 2,
          returned_assignment_count: 2,
          assignments_truncated: false,
          assigned_packages: [
            {
              package_id: 'pkg_unknown',
              media_buy_id: 'mb_unknown',
              assigned_date: '2026-08-01T00:00:00Z',
              approval_status: 'pending_review'
            },
            {
              package_id: 'pkg_evaluated',
              media_buy_id: 'mb_1',
              assigned_date: '2026-08-01T00:00:00Z',
              approval_status: 'approved',
              indicators: [],
              indicator_types_evaluated: ['creative_fatigue'],
              indicators_as_of: '2026-08-04T12:00:00Z'
            }
          ]
        }
      }]
    });
  });

  it('represents partial publisher evaluation without treating unlisted publishers as healthy', () => {
    assertValid(validateListCreatives, {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [{
        creative_id: 'creative_1',
        name: 'Acme summer video',
        format_kind: 'image',
        status: 'approved',
        created_date: '2026-08-01T00:00:00Z',
        updated_date: '2026-08-04T12:00:00Z',
        assignments: {
          assignment_count: 1,
          returned_assignment_count: 1,
          assignments_truncated: false,
          assigned_packages: [{
            package_id: 'pkg_social',
            media_buy_id: 'mb_1',
            assigned_date: '2026-08-01T00:00:00Z',
            approval_status: 'approved',
            indicator_types_evaluated: ['creative_fatigue'],
            indicators_as_of: '2026-08-04T12:00:00Z',
            indicators_evaluated_scope: [{ publisher_domain: 'publisher-a.example' }],
            indicators: [{
              type: 'creative_fatigue',
              scope: [{
                publisher_domain: 'publisher-a.example',
                placement_id: 'feed'
              }]
            }]
          }]
        }
      }]
    });
  });

  it('rejects an unscoped assertion when evaluation covers only part of the assignment', () => {
    const payload = {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [{
        creative_id: 'creative_1',
        name: 'Acme summer image',
        format_kind: 'image',
        status: 'approved',
        created_date: '2026-08-01T00:00:00Z',
        updated_date: '2026-08-04T12:00:00Z',
        assignments: {
          assignment_count: 1,
          returned_assignment_count: 1,
          assignments_truncated: false,
          assigned_packages: [{
            package_id: 'pkg_social',
            media_buy_id: 'mb_1',
            assigned_date: '2026-08-01T00:00:00Z',
            approval_status: 'approved',
            indicator_types_evaluated: ['creative_fatigue'],
            indicators_as_of: '2026-08-04T12:00:00Z',
            indicators_evaluated_scope: [{ publisher_domain: 'publisher-a.example' }],
            indicators: [{ type: 'creative_fatigue' }]
          }]
        }
      }]
    };
    assert.equal(validateListCreatives(payload), false);
  });

  it('places portfolio and package indicators on get_media_buys', () => {
    assertValid(validateGetMediaBuys, {
      status: 'completed',
      media_buys: [{
        media_buy_id: 'mb_1',
        status: 'active',
        currency: 'USD',
        total_budget: 1000,
        confirmed_at: '2026-08-01T00:00:00Z',
        revision: 1,
        indicator_types_evaluated: ['budget_constrained'],
        indicators_as_of: '2026-08-04T12:00:00Z',
        indicators: [{ type: 'budget_constrained' }],
        packages: [{
          package_id: 'pkg_1',
          indicator_types_evaluated: [
            'creative_diversity_low',
            'inventory_shortfall_forecast',
            'pacing_risk'
          ],
          indicators_as_of: '2026-08-04T12:00:00Z',
          indicators: [
            { type: 'creative_diversity_low' },
            { type: 'inventory_shortfall_forecast' },
            { type: 'pacing_risk' }
          ]
        }]
      }],
      pagination: { has_more: false }
    });
  });

  it('rejects indicator types placed at the wrong resource level', () => {
    const payload = {
      status: 'completed',
      media_buys: [{
        media_buy_id: 'mb_1',
        status: 'active',
        currency: 'USD',
        total_budget: 1000,
        confirmed_at: '2026-08-01T00:00:00Z',
        revision: 1,
        indicator_types_evaluated: ['creative_fatigue'],
        indicators_as_of: '2026-08-04T12:00:00Z',
        indicators: [{ type: 'creative_fatigue' }],
        packages: []
      }]
    };
    assert.equal(validateGetMediaBuys(payload), false);
  });

  it('returns structured warnings only on synchronous media-buy success arms', () => {
    const warning = {
      code: 'inventory_shortfall_forecast',
      message: 'Forecast delivery is below the requested goal.',
      affected_resource: {
        resource_type: 'package',
        media_buy_id: 'mb_1',
        package_id: 'pkg_1'
      },
      details: { requested_impressions: 80000, forecast_impressions: 11428 }
    };

    assertValid(validateCreateResponse, {
      status: 'completed',
      media_buy_id: 'mb_1',
      media_buy_status: 'pending_start',
      confirmed_at: '2026-08-04T12:00:00Z',
      revision: 1,
      packages: [{ package_id: 'pkg_1' }],
      warnings: [warning]
    });
    assertValid(validateUpdateResponse, {
      status: 'completed',
      media_buy_id: 'mb_1',
      revision: 2,
      warnings: [{
        code: 'flight_change_creates_pacing_risk',
        message: 'The shortened flight creates under-delivery risk.',
        affected_resource: {
          resource_type: 'package',
          media_buy_id: 'mb_1',
          package_id: 'pkg_1'
        }
      }]
    });
    const syncSuccess = {
      status: 'completed',
      creatives: [{ creative_id: 'creative_1', action: 'created' }]
    };
    assertValid(validateSyncResponse, syncSuccess);
    assert.equal(validateSyncResponse({ ...syncSuccess, warnings: [warning] }), false);

    const terminalError = {
      status: 'failed',
      errors: [{ code: 'INVALID_REQUEST', message: 'failed' }]
    };
    assertValid(validateCreateResponse, terminalError);
    assertValid(validateUpdateResponse, terminalError);
    assertValid(validateSyncResponse, terminalError);
    assert.equal(validateCreateResponse({ ...terminalError, warnings: [warning] }), false);
    assert.equal(validateUpdateResponse({ ...terminalError, warnings: [warning] }), false);
    assert.equal(validateSyncResponse({ ...terminalError, warnings: [warning] }), false);

    const submitted = { status: 'submitted', task_id: 'task_123' };
    assertValid(validateCreateResponse, submitted);
    assertValid(validateUpdateResponse, submitted);
    assertValid(validateSyncResponse, submitted);
    assert.equal(validateCreateResponse({ ...submitted, warnings: [warning] }), false);
    assert.equal(validateUpdateResponse({ ...submitted, warnings: [warning] }), false);
    assert.equal(validateSyncResponse({ ...submitted, warnings: [warning] }), false);
  });

  it('defines account-level invalidation webhooks for indicators and assignments', () => {
    assertValid(validateNotificationConfig, {
      subscriber_id: 'optimization-worker',
      url: 'https://buyer.example/webhooks/adcp',
      event_types: ['indicators.changed', 'creative.assignment_changed'],
      active: true
    });
    assertValid(validateIndicatorsWebhook, {
      idempotency_key: 'whk_01K2INDICATOR4EXAMPLE8Q7M5',
      notification_id: 'indchg_1',
      notification_type: 'indicators.changed',
      fired_at: '2026-08-04T12:01:00Z',
      subscriber_id: 'buyer-primary',
      account_id: 'acc_1',
      relationship_kind: 'creative_assignment',
      media_buy_id: 'mb_1',
      package_id: 'pkg_1',
      creative_id: 'creative_1',
      change_kind: 'asserted',
      changed_indicator_types: ['creative_fatigue'],
      observed_at: '2026-08-04T12:00:00Z'
    });
    assertValid(validateAssignmentWebhook, {
      idempotency_key: 'whk_01K2ASSIGNMENT4EXAMPLE9R6',
      notification_id: 'assignchg_1',
      notification_type: 'creative.assignment_changed',
      fired_at: '2026-08-04T12:01:00Z',
      subscriber_id: 'buyer-primary',
      account_id: 'acc_1',
      media_buy_id: 'mb_1',
      package_id: 'pkg_1',
      creative_id: 'creative_1',
      change_kind: 'approval_changed',
      observed_at: '2026-08-04T12:00:00Z'
    });
  });

  it('requires relationship identity and evaluation freshness with indicators', () => {
    const payload = {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [{
        creative_id: 'creative_1',
        name: 'Acme summer image',
        format_kind: 'image',
        status: 'approved',
        created_date: '2026-08-01T00:00:00Z',
        updated_date: '2026-08-04T12:00:00Z',
        assignments: {
          assignment_count: 1,
          returned_assignment_count: 1,
          assignments_truncated: false,
          assigned_packages: [{
            package_id: 'pkg_1',
            assigned_date: '2026-08-01T00:00:00Z',
            indicators: [{ type: 'creative_fatigue' }]
          }]
        }
      }]
    };
    assert.equal(validateListCreatives(payload), false);
  });
});
