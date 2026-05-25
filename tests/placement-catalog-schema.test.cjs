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
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot load external schema: ${uri}`);
  }
  return JSON.parse(fs.readFileSync(schemaPathFromId(uri), 'utf8'));
}

async function compile(schemaId) {
  const ajv = new Ajv({
    allErrors: true,
    verbose: true,
    strict: false,
    discriminator: true,
    loadSchema: loadExternalSchema
  });
  addFormats(ajv);
  return ajv.compileAsync(JSON.parse(fs.readFileSync(schemaPathFromId(schemaId), 'utf8')));
}

function validProduct(overrides = {}) {
  return {
    product_id: 'homepage_sponsorship',
    name: 'Homepage sponsorship',
    description: 'Homepage sponsorship across public and seller-managed positions.',
    publisher_properties: [
      {
        publisher_domain: 'daily-pulse.example',
        selection_type: 'by_id',
        property_ids: ['daily_pulse']
      }
    ],
    format_ids: [
      {
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_728x90'
      }
    ],
    placements: [
      {
        kind: 'seller_inline',
        placement_id: 'homepage_leaderboard',
        name: 'Homepage leaderboard',
        mode: 'targetable'
      },
      {
        kind: 'seller_inline',
        placement_id: 'sponsorship_lockup',
        name: 'Sponsorship lockup',
        mode: 'included'
      }
    ],
    delivery_type: 'guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'cpm_fixed',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 18
      }
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range'
    },
    ...overrides
  };
}

test('placement catalog definitions support public formats without private mapping details', async () => {
  const validate = await compile('/schemas/core/placement-definition.json');

  const placement = {
    placement_id: 'homepage_takeover',
    name: 'Homepage takeover',
    description: 'High-impact homepage sponsorship across display and video positions.',
    property_ids: ['daily_pulse'],
    channels: ['display', 'olv'],
    format_options: [
      { format_option_id: 'display_html5' },
      { format_option_id: 'video_preroll_15s' },
      {
        format_kind: 'image',
        params: {
          width: 300,
          height: 250,
          image_formats: ['jpg', 'png']
        }
      }
    ]
  };

  assert.equal(validate(placement), true, JSON.stringify(validate.errors, null, 2));
});

test('placement catalog definitions reject private operational and v1 format fields', async () => {
  const validate = await compile('/schemas/core/placement-definition.json');
  const basePlacement = {
    placement_id: 'homepage_takeover',
    name: 'Homepage takeover',
    property_ids: ['daily_pulse']
  };

  for (const forbidden of [
    { visibility: 'private' },
    { source: 'synthetic' },
    { origin: 'synced' },
    { delivery_mappings: [{ system: 'primary_ad_server', type: 'ad_unit', id: '12345' }] },
    { format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250_image' }] }
  ]) {
    assert.equal(validate({ ...basePlacement, ...forbidden }), false);
  }
});

test('product placements support targetable and included modes', async () => {
  const validate = await compile('/schemas/core/placement.json');

  assert.equal(
    validate({
      kind: 'seller_inline',
      placement_id: 'homepage_leaderboard',
      name: 'Homepage leaderboard',
      mode: 'targetable'
    }),
    true,
    JSON.stringify(validate.errors, null, 2)
  );

  assert.equal(
    validate({
      kind: 'seller_inline',
      placement_id: 'sponsorship_lockup',
      name: 'Sponsorship lockup',
      mode: 'included'
    }),
    true,
    JSON.stringify(validate.errors, null, 2)
  );
});

test('publisher-referenced product placements can use publisher-scoped placement IDs', async () => {
  const validate = await compile('/schemas/core/placement.json');

  assert.equal(
    validate({
      kind: 'publisher_ref',
      placement_id: 'homepage_banner',
      publisher_domain: 'daily-pulse.example',
      mode: 'targetable'
    }),
    true,
    JSON.stringify(validate.errors, null, 2)
  );
});

test('product placements require explicit mode and kind for new senders', async () => {
  const validate = await compile('/schemas/core/placement.json');

  assert.equal(
    validate({
      kind: 'seller_inline',
      placement_id: 'homepage_leaderboard',
      name: 'Homepage leaderboard'
    }),
    false
  );

  assert.equal(
    validate({
      placement_id: 'homepage_leaderboard',
      name: 'Homepage leaderboard',
      mode: 'targetable'
    }),
    false
  );
});

test('placement kind constrains required publisher reference and inline fields', async () => {
  const validate = await compile('/schemas/core/placement.json');

  assert.equal(
    validate({
      kind: 'publisher_ref',
      placement_id: 'homepage_banner',
      mode: 'targetable'
    }),
    false
  );

  assert.equal(
    validate({
      kind: 'seller_inline',
      publisher_domain: 'daily-pulse.example',
      placement_id: 'sponsor_rotation',
      mode: 'included'
    }),
    false
  );

  assert.equal(
    validate({
      kind: 'publisher_ref',
      publisher_domain: 'daily-pulse.example',
      placement_id: 'short_video_feed',
      mode: 'targetable'
    }),
    true,
    JSON.stringify(validate.errors, null, 2)
  );
});

test('product placements reject private operational fields', async () => {
  const validate = await compile('/schemas/core/placement.json');
  const basePlacement = {
    kind: 'seller_inline',
    placement_id: 'homepage_leaderboard',
    name: 'Homepage leaderboard',
    mode: 'targetable'
  };

  for (const forbidden of [
    { visibility: 'private' },
    { source: 'synthetic' },
    { origin: 'synced' },
    { delivery_mappings: [{ system: 'primary_ad_server', type: 'ad_unit', id: '12345' }] }
  ]) {
    assert.equal(validate({ ...basePlacement, ...forbidden }), false);
  }
});

test('products can mix targetable and included placements', async () => {
  const validate = await compile('/schemas/core/product.json');
  const product = validProduct();

  assert.equal(validate(product), true, JSON.stringify(validate.errors, null, 2));
});

test('product placements can narrow product format options', async () => {
  const validate = await compile('/schemas/core/product.json');
  const imageFormat = {
    format_kind: 'image',
    format_option_id: 'display_300x250_image',
    params: {
      width: 300,
      height: 250,
      image_formats: ['jpg', 'png']
    }
  };
  const product = validProduct({
    format_options: [imageFormat],
    placements: [
      {
        kind: 'seller_inline',
        placement_id: 'homepage_mrec',
        name: 'Homepage MREC',
        mode: 'targetable',
        format_options: [imageFormat]
      }
    ]
  });

  assert.equal(validate(product), true, JSON.stringify(validate.errors, null, 2));
});

test('products can include publisher-scoped referenced placements', async () => {
  const validate = await compile('/schemas/core/product.json');
  const product = validProduct({
    placements: [
      {
        kind: 'publisher_ref',
        placement_id: 'homepage_banner',
        publisher_domain: 'daily-pulse.example',
        mode: 'targetable'
      }
    ]
  });

  assert.equal(validate(product), true, JSON.stringify(validate.errors, null, 2));
});

test('adagents.json supports catalog_etag for cache/version validation', async () => {
  const validate = await compile('/schemas/adagents.json');
  const adagents = {
    catalog_etag: '2026-05-25T18:30:00Z',
    properties: [
      {
        property_id: 'daily_pulse',
        property_type: 'website',
        name: 'Daily Pulse',
        identifiers: [{ type: 'domain', value: 'daily-pulse.example' }]
      }
    ],
    placements: [
      {
        placement_id: 'homepage_banner',
        name: 'Homepage banner',
        property_ids: ['daily_pulse']
      }
    ],
    authorized_agents: [
      {
        url: 'https://seller.example/adcp',
        authorized_for: 'all_inventory',
        authorization_type: 'property_ids',
        property_ids: ['daily_pulse']
      }
    ]
  };

  assert.equal(validate(adagents), true, JSON.stringify(validate.errors, null, 2));
});

test('creative assignments support structured placement refs', async () => {
  const validate = await compile('/schemas/core/creative-assignment.json');

  assert.equal(
    validate({
      creative_id: 'creative_daily_pulse',
      placement_refs: [
        {
          publisher_domain: 'daily-pulse.example',
          placement_id: 'homepage_banner'
        }
      ]
    }),
    true,
    JSON.stringify(validate.errors, null, 2)
  );
});

test('format options can be referenced by publisher domain or product-local ID', async () => {
  const validateFormatOptionRef = await compile('/schemas/core/format-option-ref.json');
  const validateDeclaration = await compile('/schemas/core/product-format-declaration.json');
  const validatePackage = await compile('/schemas/media-buy/package-request.json');
  const validateManifest = await compile('/schemas/core/creative-manifest.json');
  const validateAsset = await compile('/schemas/core/creative-asset.json');

  assert.equal(
    validateFormatOptionRef({
      scope: 'publisher',
      publisher_domain: 'daily-pulse.example',
      format_option_id: 'homepage_image'
    }),
    true,
    JSON.stringify(validateFormatOptionRef.errors, null, 2)
  );

  assert.equal(
    validateFormatOptionRef({
      scope: 'product',
      format_option_id: 'homepage_image'
    }),
    true,
    JSON.stringify(validateFormatOptionRef.errors, null, 2)
  );

  assert.equal(
    validateFormatOptionRef({
      format_option_id: 'homepage_image'
    }),
    false
  );

  assert.equal(
    validateFormatOptionRef({
      scope: 'product',
      publisher_domain: 'daily-pulse.example',
      format_option_id: 'homepage_image'
    }),
    false
  );

  assert.equal(
    validateDeclaration({
      publisher_domain: 'daily-pulse.example',
      format_option_id: 'homepage_image',
      format_kind: 'image',
      params: {
        width: 300,
        height: 250
      }
    }),
    true,
    JSON.stringify(validateDeclaration.errors, null, 2)
  );

  assert.equal(
    validateDeclaration({
      format_option_id: 'seller_takeover_image',
      format_kind: 'image',
      params: {
        width: 970,
        height: 250
      }
    }),
    true,
    JSON.stringify(validateDeclaration.errors, null, 2)
  );

  assert.equal(
    validateDeclaration({
      capability_id: 'seller_takeover_image',
      format_kind: 'image',
      params: {
        width: 970,
        height: 250
      }
    }),
    false
  );

  assert.equal(
    validatePackage({
      product_id: 'homepage_sponsorship',
      pricing_option_id: 'cpm_fixed',
      budget: 1000,
      format_option_refs: [
        {
          scope: 'publisher',
          publisher_domain: 'daily-pulse.example',
          format_option_id: 'homepage_image'
        }
      ]
    }),
    true,
    JSON.stringify(validatePackage.errors, null, 2)
  );

  assert.equal(
    validatePackage({
      product_id: 'homepage_sponsorship',
      pricing_option_id: 'cpm_fixed',
      budget: 1000,
      format_option_refs: [
        {
          scope: 'product',
          format_option_id: 'seller_takeover_image'
        }
      ]
    }),
    true,
    JSON.stringify(validatePackage.errors, null, 2)
  );

  assert.equal(
    validatePackage({
      product_id: 'homepage_sponsorship',
      pricing_option_id: 'cpm_fixed',
      budget: 1000,
      capability_ids: ['homepage_image']
    }),
    false
  );

  assert.equal(
    validateManifest({
      format_kind: 'image',
      capability_id: 'homepage_image',
      assets: {}
    }),
    false
  );

  assert.equal(
    validateAsset({
      creative_id: 'creative_homepage',
      name: 'Homepage creative',
      format_kind: 'image',
      capability_id: 'homepage_image',
      assets: {}
    }),
    false
  );
});
