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

test('creative preview capabilities declare canonical routes and fidelity', async () => {
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
  }), false, 'an explicit preview operation must declare its fidelity');

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: {
        supported_capability_ids: ['streamhaus_homepage_preview'],
        fidelity: 'authoritative'
      }
    }
  }), true, JSON.stringify(validate.errors, null, 2));

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: {
        supported_capability_ids: ['streamhaus_homepage_preview'],
        fidelity: 'representative'
      }
    }
  }), true, JSON.stringify(validate.errors, null, 2));

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: {
        supported_format_ids: ['legacy_display_300x250'],
        fidelity: 'authoritative'
      }
    }
  }), false, 'legacy named-format identity must not return on the 3.2 preview declaration');

  assert.equal(validate({
    ...base,
    creative: {
      ...base.creative,
      preview: {
        supported_capability_ids: [],
        fidelity: 'exact'
      }
    }
  }), false, 'preview requires at least one route and a defined fidelity value');
});

test('community format entries accept only pinned reference renderers', async () => {
  const validate = await compile('/schemas/adagents.json');
  const adagents = {
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
      reference_renderer: {
        runtime: 'browser-esm',
        package: '@adcp/reference-renderers',
        version: '1.0.0-beta.0',
        export: 'renderImage',
        integrity: 'sha512-x1jq2OSx+17LLvQQFzHTyXFF9fUxy148EqEo0OWav+ffvL338FffUqPBbrB62kkPRcwFxvVuzy1eEvG4uLUMkA=='
      }
    }],
    authorized_agents: []
  };

  assert.equal(validate(adagents), true, JSON.stringify(validate.errors, null, 2));

  adagents.formats[0].reference_renderer.version = '^1.0.0-beta.0';
  assert.equal(validate(adagents), false, 'renderer version ranges are not reproducible');

  adagents.formats[0].reference_renderer.version = '1.0.0-beta.0';
  adagents.formats[0].reference_renderer.integrity = 'sha512-YWJjZA==';
  assert.equal(validate(adagents), false, 'renderer package integrity must use SRI syntax');

  adagents.formats[0].reference_renderer.integrity = 'sha512-x1jq2OSx+17LLvQQFzHTyXFF9fUxy148EqEo0OWav+ffvL338FffUqPBbrB62kkPRcwFxvVuzy1eEvG4uLUMkA==';
  adagents.formats[0].reference_renderer.runtime = 'node';
  assert.equal(validate(adagents), false, 'the first reference renderer contract is explicitly browser ESM');
});

test('publisher placements accept immutable presentation metadata references', async () => {
  const validate = await compile('/schemas/core/placement-definition.json');
  const placement = {
    placement_id: 'homepage_feature',
    name: 'Homepage feature',
    property_ids: ['daily_pulse'],
    presentation_ref: {
      uri: 'https://daily-pulse.example/adcp/presentations/homepage-feature.json',
      digest: `sha256:${'a'.repeat(64)}`
    }
  };

  assert.equal(validate(placement), true, JSON.stringify(validate.errors, null, 2));

  placement.presentation_ref.uri = 'http://daily-pulse.example/presentation.json';
  assert.equal(validate(placement), false, 'presentation metadata must use HTTPS');

  placement.presentation_ref.uri = 'https://daily-pulse.example/presentation.json';
  placement.presentation_ref.digest = 'sha256:abc';
  assert.equal(validate(placement), false, 'presentation metadata must be content pinned');
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
      fidelity: 'representative',
      tracking_suppressed: true
    }
  };

  assert.equal(validate(render), true, JSON.stringify(validate.errors, null, 2));

  render.renderer.version = 'latest';
  assert.equal(validate(render), false, 'renderer audit metadata requires an exact implementation version');
});
