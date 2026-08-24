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
    verbose: true,
    strict: false,
    discriminator: true,
    loadSchema: loadExternalSchema
  });
  addFormats(ajv);
  return ajv.compileAsync(JSON.parse(fs.readFileSync(schemaPathFromId(schemaId), 'utf8')));
}

test('creative preview capabilities declare per-route implementation origin without self-granting authority', async () => {
  const validate = await compile('/schemas/protocol/get-adcp-capabilities-response.json');
  const base = {
    status: 'completed',
    adcp: { major_versions: [3], idempotency: { supported: false } },
    supported_protocols: ['creative'],
    creative: {
      supported_formats: [{
        capability_id: 'streamhaus_homepage_preview',
        operations: ['preview'],
        format: { format_kind: 'image', params: { width: 300, height: 250 } }
      }]
    }
  };

  assert.equal(validate({
    ...base,
    creative: base.creative
  }), false, 'an explicit routable preview operation must declare route metadata');

  assert.equal(validate({
    ...base,
    creative: {
      supported_formats: [{
        operations: ['preview'],
        format: { format_kind: 'image', params: { width: 300, height: 250 } }
      }]
    }
  }), true, 'legacy unrouteable preview entries remain accepted during the 3.x window');

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: { routes: [{
        capability_id: 'streamhaus_homepage_preview',
        rendering_origin: 'platform_native'
      }] }
    }
  }), true, JSON.stringify(validate.errors, null, 2));

  assert.equal(validate({
    ...base,
    creative: {
      supported_formats: [
        ...base.creative.supported_formats,
        {
          capability_id: 'community_fallback',
          operations: ['preview'],
          format: { format_kind: 'image', params: { width: 300, height: 250 } }
        }
      ],
      preview: { routes: [
        {
          capability_id: 'streamhaus_homepage_preview',
          rendering_origin: 'platform_native'
        },
        {
          capability_id: 'community_fallback',
          rendering_origin: 'agent_approximation'
        }
      ] }
    }
  }), true, 'mixed agents declare implementation origin independently for each route');

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: { routes: [{
        capability_id: 'streamhaus_homepage_preview',
        rendering_origin: 'agent_approximation'
      }] }
    }
  }), true, JSON.stringify(validate.errors, null, 2));

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: {
        supported_format_ids: ['legacy_display_300x250'],
        rendering_origin: 'platform_native'
      }
    }
  }), false, 'legacy named-format identity must not return on the 3.2 preview declaration');

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: { routes: [{
        capability_id: 'streamhaus_homepage_preview',
        rendering_origin: 'authoritative'
      }] }
    }
  }), false, 'preview routes require a defined informational implementation origin');
});

test('community format entries accept only pinned reference renderers', async () => {
  const validate = await compile('/schemas/adagents.json');
  const adagents = {
    catalog_etag: 'renderer-catalog-v1',
    catalog_role: 'community_format_registry',
    properties: [{
      property_id: 'streamhaus_homepage',
      property_type: 'website',
      name: 'StreamHaus homepage',
      identifiers: [{ type: 'domain', value: 'streamhaus.example' }]
    }],
    formats: [{
      format_option_id: 'streamhaus_homepage_image',
      format_kind: 'image',
      params: { width: 300, height: 250 },
      format_revision: '1.0.0',
      reference_renderer: {
        runtime: 'browser-esm',
        package: '@example/reference-renderer',
        version: '1.2.3',
        export: 'renderImage',
        format_revision: '1.0.0',
        integrity: 'sha512-x1jq2OSx+17LLvQQFzHTyXFF9fUxy148EqEo0OWav+ffvL338FffUqPBbrB62kkPRcwFxvVuzy1eEvG4uLUMkA==',
        provenance: {
          source_repository: 'https://github.com/example/reference-renderer',
          workflow_path: '.github/workflows/release.yml'
        }
      }
    }],
    authorized_agents: []
  };

  assert.equal(validate(adagents), true, JSON.stringify(validate.errors, null, 2));
  const rendererSchema = JSON.parse(fs.readFileSync(schemaPathFromId('/schemas/core/reference-renderer.json'), 'utf8'));
  assert.equal(
    rendererSchema['x-adcp-validation'].verifier_constraints.format_revision,
    'equals_enclosing_community_format_entry.format_revision'
  );

  adagents.formats[0].reference_renderer.version = '^1.2.3';
  assert.equal(validate(adagents), false, 'renderer version ranges are not reproducible');

  adagents.formats[0].reference_renderer.version = '1.2.3';
  adagents.formats[0].reference_renderer.integrity = 'sha512-YWJjZA==';
  assert.equal(validate(adagents), false, 'renderer package integrity must use SRI syntax');

  adagents.formats[0].reference_renderer.integrity = 'sha512-x1jq2OSx+17LLvQQFzHTyXFF9fUxy148EqEo0OWav+ffvL338FffUqPBbrB62kkPRcwFxvVuzy1eEvG4uLUMkA==';
  adagents.formats[0].reference_renderer.runtime = 'node';
  assert.equal(validate(adagents), false, 'the first reference renderer contract is explicitly browser ESM');

  adagents.formats[0].reference_renderer.runtime = 'browser-esm';
  delete adagents.catalog_etag;
  assert.equal(validate(adagents), false, 'renderer pin rotation requires a catalog cache validator');
});

test('publisher placements accept immutable presentation metadata references', async () => {
  const validate = await compile('/schemas/core/placement-definition.json');
  const placement = {
    placement_id: 'homepage_feature',
    name: 'Homepage feature',
    property_ids: ['daily_pulse'],
    presentation_ref: {
      uri: 'https://daily-pulse.example/adcp/presentations/homepage-feature.json',
      digest: `sha256:${'a'.repeat(64)}`,
      media_type: 'application/vnd.adcp.placement-presentation+json',
      schema_version: '1.0'
    }
  };

  assert.equal(validate(placement), true, JSON.stringify(validate.errors, null, 2));

  placement.presentation_ref.uri = 'http://daily-pulse.example/presentation.json';
  assert.equal(validate(placement), false, 'presentation metadata must use HTTPS');

  placement.presentation_ref.uri = 'https://daily-pulse.example/presentation.json';
  placement.presentation_ref.digest = 'sha256:abc';
  assert.equal(validate(placement), false, 'presentation metadata must be content pinned');
});

test('placement presentation documents have a deterministic declarative composition contract', async () => {
  const validate = await compile('/schemas/core/placement-presentation.json');
  const document = {
    schema_version: '1.0',
    canvas: { width: 1024, height: 768, background_color: '#ffffff' },
    creative_slot: { x: 362, y: 259, width: 300, height: 250, fit: 'contain', clip: true },
    decorations: [{
      kind: 'text',
      layer: 'in_front_of_creative',
      bounds: { x: 362, y: 240, width: 200, height: 16 },
      text: 'Advertisement',
      text_color: '#333333',
      font_size: 12
    }]
  };

  assert.equal(validate(document), true, JSON.stringify(validate.errors, null, 2));
  const rectangles = [document.creative_slot, ...document.decorations.map(item => item.bounds)];
  const fitsCanvas = rectangles.every(rectangle =>
    rectangle.x + rectangle.width <= document.canvas.width
      && rectangle.y + rectangle.height <= document.canvas.height
  );
  assert.equal(fitsCanvas, true, 'all composition rectangles fit within the canvas');

  document.decorations[0].html = '<script>alert(1)</script>';
  assert.equal(validate(document), false, 'presentation metadata is data, not executable markup');

  delete document.decorations[0].html;
  document.decorations[0] = {
    kind: 'image',
    layer: 'behind_creative',
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    image_ref: {
      uri: 'https://daily-pulse.example/chrome.png',
      digest: `sha256:${'b'.repeat(64)}`
    },
    fit: 'cover'
  };
  assert.equal(validate(document), true, JSON.stringify(validate.errors, null, 2));

  document.decorations[0].image_ref.digest = 'sha256:mutable';
  assert.equal(validate(document), false, 'presentation image assets must be content pinned');
});

test('publisher placements can delegate preview authority by format route', async () => {
  const validate = await compile('/schemas/core/placement-definition.json');
  const placement = {
    placement_id: 'homepage_image',
    name: 'Homepage image',
    property_ids: ['daily_pulse'],
    format_options: [{
      format_option_id: 'canonical_image_300x250',
      format_kind: 'image',
      params: { width: 300, height: 250 }
    }],
    preview_provider: {
      agent_url: 'https://creative.adcontextprotocol.org/mcp',
      authority: 'publisher_designated',
      routes: [{
        format_option_id: 'canonical_image_300x250',
        capability_id: 'preview_display_300x250_image'
      }]
    }
  };

  assert.equal(validate(placement), true, JSON.stringify(validate.errors, null, 2));

  const providerSchema = JSON.parse(fs.readFileSync(schemaPathFromId('/schemas/core/preview-provider.json'), 'utf8'));
  assert.deepEqual(providerSchema.properties.routes['x-adcp-validation'].unique_item_properties, ['format_option_id']);

  placement.preview_provider.routes.push({
    format_option_id: 'canonical_image_300x250',
    capability_id: 'another_preview_route'
  });
  assert.equal(validate(placement), true, 'draft-07 relies on verifier annotation for keyed route uniqueness');
  placement.preview_provider.routes.pop();

  placement.preview_provider.authority = 'authoritative';
  assert.equal(validate(placement), false, 'authority must identify publisher delegation rather than a provider self-claim');

  placement.preview_provider.authority = 'publisher_designated';
  placement.preview_provider.agent_url = 'http://creative.adcontextprotocol.org/mcp';
  assert.equal(validate(placement), false, 'delegated preview providers must use HTTPS');
});

test('preview renders can carry reproducible renderer audit metadata', async () => {
  const validate = await compile('/schemas/creative/preview-render.json');
  const render = {
    render_id: 'render_1',
    output_format: 'url',
    preview_url: 'https://creative.adcontextprotocol.org/preview/render_1',
    role: 'primary',
    renderer: {
      renderer_id: 'adcp-reference-vast',
      version: '1.0.0',
      export: 'renderVast',
      rendering_origin: 'agent_approximation',
      tracking_suppressed: true
    }
  };

  assert.equal(validate(render), true, JSON.stringify(validate.errors, null, 2));

  render.renderer.version = 'latest';
  assert.equal(validate(render), false, 'renderer audit metadata requires an exact implementation version');
});
