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

async function compile(schemaId) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => {
      if (!uri.startsWith('/schemas/')) {
        throw new Error(`Cannot load external schema: ${uri}`);
      }
      return JSON.parse(fs.readFileSync(schemaPathFromId(uri), 'utf8'));
    }
  });
  addFormats(ajv);
  return ajv.compileAsync(JSON.parse(fs.readFileSync(schemaPathFromId(schemaId), 'utf8')));
}

const selected = {
  mode: 'selected',
  placement_refs: [
    {
      publisher_domain: 'publisher.example',
      placement_id: 'home_feed'
    },
    {
      publisher_domain: 'publisher.example',
      placement_id: 'short_video'
    }
  ]
};

const propertyScope = {
  publisher_domain: 'publisher.example',
  selection_type: 'all'
};

const placementOverlay = {
  placement_selection: selected
};

const placementResolution = {
  applied: placementOverlay,
  equivalent: true,
  resolved_at: '2026-08-01T12:00:00Z',
  inventory: {
    properties: [propertyScope],
    placements: selected.placement_refs.map(placementRef => ({
      placement_ref: placementRef,
      selection_source: 'selected',
      property_scope: [propertyScope]
    }))
  }
};

test('placement selection discriminates selected and default modes', async () => {
  const validate = await compile('/schemas/core/placement-selection.json');

  assert.equal(validate(selected), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate({ mode: 'default' }), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate({ mode: 'selected', placement_refs: [] }), false);
  assert.equal(validate({ mode: 'selected', placement_refs: [{ placement_id: 'home_feed' }] }), false);
  assert.equal(validate({ mode: 'default', placement_refs: selected.placement_refs }), false);
  assert.equal(validate({ mode: 'automatic' }), false);
});

test('selected placement references reject exact duplicates', async () => {
  const validate = await compile('/schemas/core/placement-selection.json');
  const placementRef = selected.placement_refs[0];

  assert.equal(validate({
    mode: 'selected',
    placement_refs: [placementRef, { ...placementRef }]
  }), false);
});

test('package create, update, and state schemas carry placement selection inside targeting', async () => {
  const validateRequest = await compile('/schemas/media-buy/package-request.json');
  const validateUpdate = await compile('/schemas/media-buy/package-update.json');
  const validatePackage = await compile('/schemas/core/package.json');

  assert.equal(validateRequest({
    product_id: 'social_inventory',
    pricing_option_id: 'cpm_fixed',
    budget: 1000,
    targeting_overlay: placementOverlay
  }), true, JSON.stringify(validateRequest.errors, null, 2));

  assert.equal(validateUpdate({
    package_id: 'pkg_123',
    targeting_overlay: { placement_selection: { mode: 'default' } }
  }), true, JSON.stringify(validateUpdate.errors, null, 2));

  assert.equal(validatePackage({
    package_id: 'pkg_123',
    targeting_overlay: placementOverlay,
    targeting_resolution: placementResolution
  }), true, JSON.stringify(validatePackage.errors, null, 2));

  assert.equal(validatePackage({
    package_id: 'pkg_123',
    targeting_overlay: placementOverlay
  }), false, 'stored requested targeting requires applied resolution');
});

test('get_media_buys carries requested placement targeting and joint inventory resolution', async () => {
  const validate = await compile('/schemas/media-buy/get-media-buys-response.json');
  const response = {
    status: 'completed',
    media_buys: [
      {
        media_buy_id: 'mb_123',
        status: 'active',
        currency: 'USD',
        total_budget: 1000,
        confirmed_at: '2026-08-01T12:00:00Z',
        revision: 2,
        packages: [
          {
            package_id: 'pkg_123',
            targeting_overlay: placementOverlay,
            targeting_resolution: placementResolution
          }
        ]
      }
    ]
  };

  assert.equal(validate(response), true, JSON.stringify(validate.errors, null, 2));
});

test('create and update responses distinguish requested and applied placement targeting', async () => {
  const validateCreate = await compile('/schemas/media-buy/create-media-buy-response.json');
  const validateUpdate = await compile('/schemas/media-buy/update-media-buy-response.json');
  const packageState = {
    package_id: 'pkg_123',
    targeting_overlay: placementOverlay,
    targeting_resolution: placementResolution
  };

  assert.equal(validateCreate({
    status: 'completed',
    media_buy_id: 'mb_123',
    confirmed_at: '2026-08-01T12:00:00Z',
    revision: 1,
    packages: [packageState]
  }), true, JSON.stringify(validateCreate.errors, null, 2));

  assert.equal(validateUpdate({
    status: 'completed',
    media_buy_id: 'mb_123',
    revision: 2,
    affected_packages: [packageState]
  }), true, JSON.stringify(validateUpdate.errors, null, 2));
});

test('placement updates have action metadata and a dedicated error code', async () => {
  const validateAction = await compile('/schemas/enums/media-buy-valid-action.json');
  const validateError = await compile('/schemas/enums/error-code.json');
  const actionSchema = JSON.parse(
    fs.readFileSync(schemaPathFromId('/schemas/enums/media-buy-valid-action.json'), 'utf8')
  );

  assert.equal(validateAction('update_placements'), true, JSON.stringify(validateAction.errors, null, 2));
  assert.deepEqual(
    actionSchema.enumMetadata.update_placements.update_fields,
    ['packages[].targeting_overlay.placement_selection']
  );
  assert.equal(
    actionSchema.enumMetadata.update_packages.rollup.includes('update_placements'),
    true
  );
  assert.equal(validateError('PLACEMENT_SELECTION_INVALID'), true, JSON.stringify(validateError.errors, null, 2));
});

test('inventory resolution requires a property scope for each effective placement', async () => {
  const validate = await compile('/schemas/core/targeting-resolution.json');
  const missingScope = structuredClone(placementResolution);
  delete missingScope.inventory.placements[0].property_scope;
  const missingPlacements = structuredClone(placementResolution);
  delete missingPlacements.inventory.placements;

  assert.equal(validate(placementResolution), true, JSON.stringify(validate.errors, null, 2));
  assert.equal(validate(missingScope), false);
  assert.equal(validate(missingPlacements), false);
});
