const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_DIR = path.join(__dirname, '../static/schemas/source');

function schema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, relativePath), 'utf8'));
}

async function compile(relativePath) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async uri => schema(uri.replace(/^\/schemas\//, '').split('#', 1)[0])
  });
  addFormats(ajv);
  return ajv.compileAsync(schema(relativePath));
}

const revisionId = 'rev_2026_08_23_01';

test('sync request accepts scoped revision identity and publishes fail-closed content rules', async () => {
  const validate = await compile('creative/sync-creatives-request.json');
  const request = {
    idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
    account: { account_id: 'acct_acme' },
    creatives: [{
      creative_id: 'hero',
      revision_id: revisionId,
      name: 'Hero',
      format_kind: 'image',
      assets: {
        image: {
          asset_type: 'image',
          url: 'https://cdn.example/hero.png',
          width: 300,
          height: 250
        }
      }
    }]
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));

  const rules = schema('creative/sync-creatives-request.json')
    .properties.creatives.items.allOf[1]['x-adcp-validation'].verifier_constraints.revision_identity;
  assert.deepEqual(rules.scope, ['creative_id', 'revision_id']);
  assert.equal(rules.reliance_gate, 'creative.supports_revisions');
  assert.deepEqual(rules.check_order, ['idempotency_key', 'revision_content']);
  assert.equal(rules.canonical_content.included, 'all effective buyer-authored creative fields, including unknown future content fields');
  assert.equal(
    rules.canonical_content.canonicalization,
    'RFC_8785_JCS_of_effective_buyer_state_after_removing_exact_top_level_excluded_fields'
  );
  assert.equal(rules.canonical_content.exclusion_scope, 'top_level_creative_item_only');
  assert.equal(rules.canonical_content.duplicate_json_members, 'reject_request_before_comparison');
  assert.equal(
    rules.canonical_content.localization_null,
    'remove_localization_property_from_effective_state_before_comparison'
  );
  assert.equal(rules.same_revision_different_content, 'CREATIVE_REVISION_CONTENT_MISMATCH');
  assert.equal(
    rules.first_revision_on_unversioned_creative.same_effective_content,
    'accept_as_updated_bind_revision_and_preserve_review_state'
  );
  assert.equal(
    rules.first_revision_on_unversioned_creative.different_effective_content,
    'bind_only_on_accepted_update_and_require_review'
  );
  assert.equal(
    rules.different_revision_same_current_content,
    'accept_as_updated_make_current_preserve_review_state_and_rebind_inflight_review'
  );
  assert.equal(
    rules.revision_omitted_with_current_revision.different_effective_content,
    'accept_under_legacy_update_rules_and_clear_current_revision_identity'
  );
  assert.equal(rules.revision_omitted_with_current_revision.must_not_mint_seller_revision, true);
  assert.equal(
    rules.revision_omitted_with_current_revision.different_effective_content_review,
    'prior_approval_must_not_transfer_and_update_enters_ordinary_review'
  );
  assert.equal(
    rules.stale_review_result.different_fingerprint_or_not_rebound,
    'must_not_mutate_current_revision_or_current_status'
  );
  assert.equal(
    rules.stale_review_result.identical_content_rebound,
    'apply_to_current_revision_and_attribute_result_and_webhook_to_current_revision_id'
  );
  assert.match(rules.dry_run, /do_not_create_or_update_bindings/);
  assert.equal(rules.content_change_review, 'prior_approval_must_not_transfer');
  assert.deepEqual(
    schema('creative/sync-creatives-request.json').properties.creatives['x-adcp-validation'].unique_item_properties,
    ['creative_id']
  );
});

test('sync response echoes accepted revisions and forbids them on failed or deleted items', async () => {
  const validate = await compile('creative/sync-creatives-response.json');
  const accepted = {
    status: 'completed',
    creatives: [{ creative_id: 'hero', revision_id: revisionId, action: 'created' }]
  };
  assert.equal(validate(accepted), true, JSON.stringify(validate.errors));

  for (const action of ['failed', 'deleted']) {
    const invalid = {
      status: 'completed',
      creatives: [{ creative_id: 'hero', revision_id: revisionId, action }]
    };
    assert.equal(validate(invalid), false, `${action} unexpectedly retained revision_id`);
  }

  const item = schema('creative/sync-creatives-response.json').oneOf[0].properties.creatives.items;
  const echo = item.allOf.at(-1)['x-adcp-validation'].verifier_constraints.revision_echo;
  assert.equal(echo.must_equal_request, true);
  assert.deepEqual(echo.accepted_actions, ['created', 'updated', 'unchanged']);
});

test('revision capability requires a creative library', async () => {
  const validate = await compile('protocol/get-adcp-capabilities-response.json');
  const base = {
    status: 'completed',
    adcp: {
      major_versions: [3],
      idempotency: { supported: true, replay_ttl_seconds: 86400 }
    },
    supported_protocols: ['creative'],
    creative: { has_creative_library: true, supports_revisions: true }
  };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));

  for (const library of [false, undefined]) {
    const invalid = structuredClone(base);
    if (library === undefined) delete invalid.creative.has_creative_library;
    else invalid.creative.has_creative_library = library;
    assert.equal(validate(invalid), false, `supports_revisions accepted has_creative_library=${library}`);
  }
});

test('revision identity reads back through library, webhook, and delivery schemas', async () => {
  const registry = schema('core/x-entity-types.json');
  assert.ok(registry.enum.includes('creative_revision'));
  assert.ok(registry.enum.includes('served_variant'));

  const listSchema = schema('creative/list-creatives-response.json');
  assert.equal(
    listSchema.properties.creatives.items.properties.revision_id.$ref,
    '/schemas/core/creative-revision-id.json'
  );
  assert.equal(
    listSchema.properties.creatives.items.properties.revision_id['x-adcp-validation']
      .verifier_constraints.revision_readback.must_equal,
    'last_accepted_current_buyer_revision'
  );
  const webhookRevision = schema('creative/creative-status-changed-webhook.json').properties.revision_id;
  assert.equal(
    webhookRevision.$ref,
    '/schemas/core/creative-revision-id.json'
  );
  assert.equal(
    webhookRevision['x-adcp-validation'].verifier_constraints.revision_transition_attribution.must_equal,
    'revision_to_which_transition_applies'
  );

  const validateVariant = await compile('core/creative-variant.json');
  assert.equal(validateVariant({ variant_id: 'served_1', revision_id: revisionId }), true, JSON.stringify(validateVariant.errors));
  assert.equal(schema('core/creative-variant.json').allOf[1].properties.variant_id['x-entity'], 'served_variant');
  assert.equal(schema('creative/preview-creative-request.json').properties.variant_id['x-entity'], 'served_variant');
  const attribution = schema('core/creative-variant.json').allOf[1].properties.revision_id['x-adcp-validation']
    .verifier_constraints.revision_attribution;
  assert.equal(attribution.row_metrics_revision_homogeneous, true);
  assert.equal(attribution.current_list_revision_not_required, true);
  const rows = schema('creative/get-creative-delivery-response.json').properties.creatives.items
    .properties.variants['x-adcp-validation'].verifier_constraints.revision_homogeneous_rows;
  assert.deepEqual(rows.row_key, ['variant_id']);
  assert.equal(rows.row_key_unique, true);
  assert.equal(rows.variant_id_scope, 'agent_unique_and_unambiguous_for_variant_preview_when_supported');
  assert.equal(rows.metrics_must_not_cross_revision_boundary, true);
  assert.equal(rows.metrics_must_not_cross_locale_boundary, true);
});

test('revision mismatch has a typed correctable error contract', async () => {
  const validate = await compile('error-details/creative-revision-content-mismatch.json');
  assert.equal(validate({ creative_id: 'hero', revision_id: revisionId }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ creative_id: 'hero' }), false);

  const errors = schema('enums/error-code.json');
  assert.ok(errors.enum.includes('CREATIVE_REVISION_CONTENT_MISMATCH'));
  assert.equal(errors.enumMetadata.CREATIVE_REVISION_CONTENT_MISMATCH.recovery, 'correctable');
});
