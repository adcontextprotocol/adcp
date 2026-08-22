const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const ROOT = path.resolve(__dirname, '..');
const SCHEMAS = path.join(ROOT, 'static/schemas/source');
const VECTORS = path.join(ROOT, 'static/compliance/source/test-vectors/creative-delivery-resolution.json');
const VECTOR_SCHEMA = path.join(ROOT, 'static/compliance/source/test-vectors/creative-delivery-resolution.schema.json');
const MACRO_VECTORS = path.join(ROOT, 'static/compliance/source/test-vectors/macro-processing.json');
const MACRO_VECTOR_SCHEMA = path.join(ROOT, 'static/compliance/source/test-vectors/macro-processing.schema.json');

function loadAllSchemas(ajv) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (schema.$id && !ajv.getSchema(schema.$id)) ajv.addSchema(schema, schema.$id);
      }
    }
  }
  walk(SCHEMAS);
}

function makeAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
  addFormats(ajv);
  ajv.addFormat('uri-template', true);
  loadAllSchemas(ajv);
  return ajv;
}

const ajv = makeAjv();

test('display tag delivery variants are discriminated and paired redirects are atomic', () => {
  const validate = ajv.getSchema('/schemas/core/assets/display-tag-asset.json');
  assert.ok(validate);

  assert.equal(validate({
    asset_type: 'display_tag',
    delivery_type: 'tag_url',
    url: 'https://ads.acme-example.com/render?cb={CACHEBUSTER}'
  }), true);
  assert.equal(validate({
    asset_type: 'display_tag',
    delivery_type: 'inline_markup',
    markup_type: 'iframe_javascript',
    markup: '<iframe src="https://ads.acme-example.com/render"></iframe>'
  }), true);
  assert.equal(validate({
    asset_type: 'display_tag',
    delivery_type: 'paired_redirect',
    ad_request_url: 'https://ads.acme-example.com/ad',
    clickthrough_url: 'https://click.acme-example.com/redirect'
  }), true);

  assert.equal(validate({
    asset_type: 'display_tag',
    delivery_type: 'paired_redirect',
    ad_request_url: 'https://ads.acme-example.com/ad'
  }), false, 'half-present paired redirects must fail');
  assert.equal(validate({
    asset_type: 'html',
    delivery_type: 'inline_markup',
    markup_type: 'standard',
    markup: '<a>not an HTML5 bundle</a>'
  }), false, 'third-party markup cannot be classified as html/html5');
});

test('VAST assets stay singular while format and seller acceptance are plural enums', () => {
  const format = ajv.getSchema('/schemas/formats/canonical/video_vast.json');
  assert.equal(format({ vast_versions: ['3.0', '4.0', '4.3'] }), true);
  assert.equal(format({ vast_version: '4.0' }), true, 'deprecated one-element alias remains valid');
  assert.equal(format({ vast_version: '4.0', vast_versions: ['4.0'] }), false,
    'singular and plural aliases are mutually exclusive so they cannot diverge');
  assert.equal(format({ vast_version: '4.0', vast_versions: ['3.0'] }), false);
  assert.equal(format({ vast_versions: ['4.4'] }), false);

  const capabilities = JSON.parse(fs.readFileSync(
    path.join(SCHEMAS, 'protocol/get-adcp-capabilities-response.json'),
    'utf8'
  ));
  const vastSchema = capabilities.properties.media_buy.properties.execution.properties.creative_specs.properties.vast_versions;
  assert.equal(vastSchema.items.$ref, '/schemas/enums/vast-version.json');
  assert.deepEqual(ajv.getSchema('/schemas/enums/vast-version.json').schema.enum.slice(-2), ['4.2', '4.3']);

  const resolution = capabilities.properties.creative.properties.delivery_variant_resolution;
  assert.equal(resolution.properties.supported.const, true);
  assert.deepEqual(resolution.properties.strategies.items.enum, ['source_order', 'highest_compatible_vast']);
  assert.match(resolution.description, /MUST NOT guess silently/);
});

test('VAST technical acceptance is explicit, rendition-scoped, and byte-exact', () => {
  const requirements = {
    delivery_methods: ['progressive'],
    mime_types: ['video/mp4'],
    containers: ['mp4'],
    codecs: ['avc1.4d401f'],
    min_width: 1280,
    max_width: 1920,
    min_height: 720,
    max_height: 1080,
    min_bitrate_kbps: 1500,
    max_bitrate_kbps: 8000,
    max_file_size_bytes: 50000000
  };
  const validateRequirements = ajv.getSchema('/schemas/core/vast-media-file-requirements.json');
  assert.equal(validateRequirements(requirements), true, JSON.stringify(validateRequirements.errors));
  assert.equal(validateRequirements({ ...requirements, vendor_extension: 'future-value' }), true,
    'technical requirement objects remain extension-carrying under DR-0009');
  assert.equal(validateRequirements({ ...requirements, mime_types: ['video/mp4; codecs=avc1'] }), false,
    'MediaFile MIME requirements are media types, not parameterized Content-Type values');
  assert.equal(validateRequirements({ ...requirements, max_file_size_bytes: 0 }), false,
    'the byte limit is a positive exact count');
  assert.equal(validateRequirements({ ...requirements, containers: ['MP4'] }), false,
    'container identifiers use normalized lower-case tokens');
  assert.equal(validateRequirements({ ...requirements, delivery_methods: ['download'] }), false,
    'delivery methods use the governed VAST progressive/streaming vocabulary');
  assert.match(validateRequirements.schema['x-adcp-validation'].verifier_constraints.range_order,
    /min_bitrate_kbps MUST be <= max_bitrate_kbps/);
  assert.match(validateRequirements.schema['x-adcp-validation'].verifier_constraints.adaptive_bitrate_containment,
    /entire interval/);

  const validateFormat = ajv.getSchema('/schemas/formats/canonical/video_vast.json');
  assert.equal(validateFormat({ vast_versions: ['4.2'], media_file_requirements: requirements }), true,
    JSON.stringify(validateFormat.errors));
  const validateLegacyRequirements = ajv.getSchema('/schemas/core/requirements/vast-asset-requirements.json');
  assert.equal(validateLegacyRequirements({ vast_versions: ['4.2'], media_file_requirements: requirements }), true,
    JSON.stringify(validateLegacyRequirements.errors));

  const validateDeclaration = ajv.getSchema('/schemas/core/product-format-declaration.json');
  const declaration = {
    format_option_id: 'vast-preroll-complete',
    technical_requirements_complete: true,
    format_kind: 'video_vast',
    params: { vast_versions: ['4.2'], media_file_requirements: requirements }
  };
  assert.equal(validateDeclaration(declaration), true, JSON.stringify(validateDeclaration.errors));
  const validateCompact = ajv.getSchema('/schemas/core/canonical-format-option.json');
  assert.equal(validateCompact(declaration), true, JSON.stringify(validateCompact.errors));
  assert.match(validateDeclaration.schema.properties.technical_requirements_complete.description,
    /MUST NOT later be rejected for an undisclosed technical constraint/);
  assert.match(ajv.getSchema('/schemas/formats/canonical/_base.json').schema['x-adcp-file-size-units'],
    /1,000 bytes per KB/);

  const mediaFileSatisfies = mediaFile =>
    requirements.delivery_methods.includes(mediaFile.delivery_method) &&
    requirements.mime_types.some(value => value.toLowerCase() === mediaFile.mime_type.toLowerCase()) &&
    requirements.containers.includes(mediaFile.container) &&
    requirements.codecs.includes(mediaFile.codec) &&
    mediaFile.width >= requirements.min_width && mediaFile.width <= requirements.max_width &&
    mediaFile.height >= requirements.min_height && mediaFile.height <= requirements.max_height &&
    mediaFile.bitrate_kbps >= requirements.min_bitrate_kbps &&
    mediaFile.bitrate_kbps <= requirements.max_bitrate_kbps &&
    mediaFile.file_size_bytes <= requirements.max_file_size_bytes;
  const alternatives = [
    {
      delivery_method: 'progressive', mime_type: 'video/mp4', container: 'mp4', codec: 'avc1.4d401f',
      width: 640, height: 360, bitrate_kbps: 900, file_size_bytes: 10000000
    },
    {
      delivery_method: 'progressive', mime_type: 'video/mp4', container: 'mp4', codec: 'avc1.4d401f',
      width: 1920, height: 1080, bitrate_kbps: 6000, file_size_bytes: 49000000
    }
  ];
  assert.equal(alternatives.some(mediaFileSatisfies), true,
    'one fully compatible rendition is sufficient despite incompatible siblings');
  assert.equal([
    { ...alternatives[0], width: 1920, height: 1080 },
    { ...alternatives[1], codec: 'vp09.00.10.08' }
  ].some(mediaFileSatisfies), false,
    'requirements cannot be combined across different MediaFile elements');
  assert.equal(mediaFileSatisfies({ ...alternatives[1], delivery_method: 'streaming' }), false,
    'the same rendition must satisfy the declared delivery method');
  assert.equal(mediaFileSatisfies({ ...alternatives[1], codec: undefined }), false,
    'missing metadata cannot silently satisfy a declared technical constraint');

  const validateManifest = ajv.getSchema('/schemas/core/creative-manifest.json');
  const canonicalVastManifest = {
    format_kind: 'video_vast',
    assets: {
      vast_tag: {
        asset_type: 'vast',
        delivery_type: 'url',
        url: 'https://ads.acme-example.com/vast',
        vast_version: '4.2'
      }
    }
  };
  assert.equal(validateManifest(canonicalVastManifest), true, JSON.stringify(validateManifest.errors));
  const customSlotVastManifest = structuredClone(canonicalVastManifest);
  customSlotVastManifest.assets.vast_xml = customSlotVastManifest.assets.vast_tag;
  delete customSlotVastManifest.assets.vast_tag;
  assert.equal(validateManifest(customSlotVastManifest), true,
    'canonical VAST exact-version validation follows the asset type, not a default slot name');
  const arraySlotVastManifest = structuredClone(canonicalVastManifest);
  arraySlotVastManifest.assets.vast_pool = [arraySlotVastManifest.assets.vast_tag];
  delete arraySlotVastManifest.assets.vast_tag;
  assert.equal(validateManifest(arraySlotVastManifest), true,
    'canonical VAST exact-version validation supports multi-asset slots');
  const missingExactVersion = structuredClone(canonicalVastManifest);
  delete missingExactVersion.assets.vast_tag.vast_version;
  assert.equal(validateManifest(missingExactVersion), false,
    'the canonical video_vast path requires the asset exact version');
  const customSlotWithoutVersion = structuredClone(customSlotVastManifest);
  delete customSlotWithoutVersion.assets.vast_xml.vast_version;
  assert.equal(validateManifest(customSlotWithoutVersion), false,
    'a renamed canonical VAST slot cannot bypass exact-version validation');
  const arraySlotWithoutVersion = structuredClone(arraySlotVastManifest);
  delete arraySlotWithoutVersion.assets.vast_pool[0].vast_version;
  assert.equal(validateManifest(arraySlotWithoutVersion), false,
    'each VAST asset in a multi-asset slot requires an exact version');
  const extensionSlotWithoutVersion = structuredClone(canonicalVastManifest);
  extensionSlotWithoutVersion.assets['VAST-TAG'] = extensionSlotWithoutVersion.assets.vast_tag;
  delete extensionSlotWithoutVersion.assets.vast_tag;
  delete extensionSlotWithoutVersion.assets['VAST-TAG'].vast_version;
  assert.equal(validateManifest(extensionSlotWithoutVersion), false,
    'extension-style slot names remain subject to canonical VAST exact-version validation');
  assert.equal(validateManifest({
    format_id: { agent_url: 'https://creative.acme.test', id: 'legacy-vast' },
    assets: missingExactVersion.assets
  }), true, 'the deprecated named-format path retains 3.x compatibility');

  const validateCreativeAsset = ajv.getSchema('/schemas/core/creative-asset.json');
  const canonicalVastCreative = {
    creative_id: 'vast-creative-1',
    name: 'Acme preroll',
    ...canonicalVastManifest
  };
  assert.equal(validateCreativeAsset(canonicalVastCreative), true, JSON.stringify(validateCreativeAsset.errors));
  const syncCreativeWithoutVersion = structuredClone(canonicalVastCreative);
  delete syncCreativeWithoutVersion.assets.vast_tag.vast_version;
  assert.equal(validateCreativeAsset(syncCreativeWithoutVersion), false,
    'the canonical sync_creatives path requires the asset exact version');
  assert.equal(validateCreativeAsset({
    ...canonicalVastCreative,
    assets: extensionSlotWithoutVersion.assets
  }), false, 'sync_creatives cannot bypass exact-version validation through an extension slot name');
});

test('macro declarations enforce resolver ownership and exact URL encoding depth', () => {
  const validate = ajv.getSchema('/schemas/core/macro-declaration.json');
  const valid = {
    declaration_id: 'nested-click',
    token: '%%ACME_CLICK_ESC2%%',
    dialect: 'vendor',
    dialect_namespace: 'https://macros.acme-example.com/registry',
    dialect_revision: 'mapping-v1',
    dialect_semantic: 'CLICK_ESC2',
    mapping_status: 'verified_universal',
    universal_semantic: 'CLICK_URL',
    operation: 'resolve_value',
    performed_by: 'seller',
    location: { field: 'url', occurrence: 0, context: 'url_query_value' },
    encoding: { kind: 'rfc3986', depth: 2 },
    required: true,
    unavailable_behavior: 'reject'
  };
  assert.equal(validate(valid), true);
  assert.equal(validate({ ...valid, encoding: { kind: 'rfc3986', depth: 0 } }), false);
  assert.equal(validate({ ...valid, encoding: { kind: 'none', depth: 1 } }), false);
  assert.equal(validate({ ...valid, performed_by: 'whoever_guesses' }), false);
  assert.equal(validate({ ...valid, dialect: 'ttd' }), false, 'dialect aliases must not bypass the governed enum');
  assert.equal(validate({ ...valid, required: true, unavailable_behavior: 'omit_parameter' }), false);
  assert.equal(validate({ ...valid, mapping_status: 'dialect_defined' }), false, 'universal mappings cannot survive without verified status');

  const adcp = {
    ...valid,
    token: '{CACHEBUSTER}',
    dialect: 'adcp',
    dialect_semantic: 'CACHEBUSTER',
    universal_semantic: 'CACHEBUSTER'
  };
  delete adcp.dialect_namespace;
  delete adcp.dialect_revision;
  assert.equal(validate(adcp), true);
  assert.equal(validate({ ...adcp, performed_by: 'creative_agent' }), true,
    'standalone build/preview execution has an actor distinct from seller trafficking');
  assert.equal(validate({ ...adcp, dialect_semantic: 'PRIVATE' }), false);
  const semanticIdentityIsValid = declaration => declaration.dialect !== 'adcp' ||
    declaration.dialect_semantic === declaration.universal_semantic;
  assert.equal(semanticIdentityIsValid(adcp), true);
  assert.equal(semanticIdentityIsValid({ ...adcp, dialect_semantic: 'TIMESTAMP' }), false,
    'the published AdCP semantic-identity verifier rejects unequal universal names');
  assert.equal(validate.schema['x-adcp-validation'].verifier_constraints.adcp_semantic_identity.includes('must equal'), true);
  assert.equal(validate({ ...adcp, mapping_status: 'dialect_defined', universal_semantic: undefined }), false);
  assert.equal(validate({ ...adcp, location: { field: 'url', occurrence: 0, context: 'opaque' } }), false,
    'opaque locations are preserve-only');
  assert.equal(validate({ ...adcp, dialect_semantic: 'SKU', universal_semantic: 'SKU', encoding: { kind: 'rfc3986', depth: 2 } }), false,
    'catalog values have exactly one RFC3986 pass');

  const unknown = {
    declaration_id: 'unknown-token',
    token: '%%UNIDENTIFIED%%',
    dialect: 'unknown',
    dialect_semantic: 'unresolved',
    mapping_status: 'unresolved',
    operation: 'preserve',
    location: { field: 'url', occurrence: 0, context: 'opaque' },
    encoding: { kind: 'none', depth: 0 },
    required: false,
    unavailable_behavior: 'preserve'
  };
  assert.equal(validate(unknown), true);
  assert.equal(validate({ ...unknown, performed_by: 'seller' }), false);
  assert.equal(validate({ ...unknown, universal_semantic: 'CACHEBUSTER' }), false);

  const daastResolution = {
    declaration_id: 'daast-error',
    token: '[ERRORCODE]',
    dialect: 'iab_daast',
    dialect_namespace: 'https://iabtechlab.com/standards/daast',
    dialect_revision: 'DAAST-1.1',
    dialect_semantic: 'ERRORCODE',
    mapping_status: 'dialect_defined',
    operation: 'resolve_value',
    performed_by: 'request_executor',
    location: { field: 'url', occurrence: 0, context: 'url_query_value' },
    encoding: { kind: 'rfc3986', depth: 1 },
    required: true,
    unavailable_behavior: 'reject'
  };
  assert.equal(validate(daastResolution), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...daastResolution, performed_by: 'seller' }), false,
    'IAB DAAST values are supplied by the component executing the request');

  const validateUrlAsset = ajv.getSchema('/schemas/core/assets/url-asset.json');
  const declaredAsset = {
    asset_type: 'url',
    url_type: 'tracker_pixel',
    url: 'https://track.acme-example.com/pixel?x=%%UNIDENTIFIED%%',
    macro_declarations: [unknown]
  };
  assert.equal(validateUrlAsset(declaredAsset), true, JSON.stringify(validateUrlAsset.errors));
  assert.equal(validateUrlAsset({
    ...declaredAsset,
    macro_declarations: [{ ...unknown, location: { ...unknown.location, field: 'markup' } }]
  }), false, 'asset schemas constrain declaration fields to fields that the asset actually carries');

  const occurrencesAreValid = asset => {
    const seenIds = new Set();
    const seenOccurrences = new Set();
    return asset.macro_declarations.every(declaration => {
      if (seenIds.has(declaration.declaration_id)) return false;
      seenIds.add(declaration.declaration_id);
      const value = asset[declaration.location.field];
      if (typeof value !== 'string') return false;
      let offset = 0;
      let index = -1;
      for (let occurrence = 0; occurrence <= declaration.location.occurrence; occurrence++) {
        index = value.indexOf(declaration.token, offset);
        if (index < 0) return false;
        offset = index + declaration.token.length;
      }
      const occurrenceKey = `${declaration.location.field}:${index}:${declaration.token.length}`;
      if (seenOccurrences.has(occurrenceKey)) return false;
      seenOccurrences.add(occurrenceKey);
      return true;
    });
  };
  assert.equal(occurrencesAreValid(declaredAsset), true);
  assert.equal(occurrencesAreValid({
    ...declaredAsset,
    macro_declarations: [{ ...unknown, location: { ...unknown.location, occurrence: 999 } }]
  }), false);
  assert.equal(occurrencesAreValid({ ...declaredAsset, macro_declarations: [unknown, structuredClone(unknown)] }), false);

  const validateCapability = ajv.getSchema('/schemas/core/macro-resolution-capability.json');
  assert.equal(validateCapability({
    dialect: 'iab_vast',
    dialect_namespace: 'https://interactiveadvertisingbureau.github.io/vast/vast4macros/vast4-macros-latest.html',
    dialect_revision: 'git:e0858cd714474bf17ef61065097456d7643ff838',
    dialect_semantic: 'PLAYERSTATE',
    mapping_status: 'dialect_defined',
    operation: 'resolve_value',
    performed_by: 'request_executor',
    supported_contexts: ['url_query_value'],
    supported_encodings: [{ kind: 'iab_vast_uri', depth: 1 }]
  }), true);
  assert.equal(validateCapability({
    dialect: 'unknown',
    dialect_semantic: 'unresolved',
    mapping_status: 'dialect_defined',
    operation: 'resolve_value',
    performed_by: 'seller',
    supported_contexts: ['opaque'],
    supported_encodings: [{ kind: 'none', depth: 0 }]
  }), false, 'unknown dialects can be preserved but never advertised as resolvable');
  assert.equal(validateCapability({
    dialect: 'adcp',
    dialect_semantic: 'CACHEBUSTER',
    mapping_status: 'verified_universal',
    universal_semantic: 'CACHEBUSTER',
    operation: 'resolve_value',
    performed_by: 'seller',
    supported_contexts: ['opaque'],
    supported_encodings: [{ kind: 'rfc3986', depth: 1 }]
  }), false, 'capabilities cannot advertise mutation in opaque contexts');
  const daastCapability = {
    dialect: 'iab_daast',
    dialect_namespace: 'https://iabtechlab.com/standards/daast',
    dialect_revision: 'DAAST-1.1',
    dialect_semantic: 'ERRORCODE',
    mapping_status: 'dialect_defined',
    operation: 'resolve_value',
    performed_by: 'request_executor',
    supported_contexts: ['url_query_value'],
    supported_encodings: [{ kind: 'rfc3986', depth: 1 }]
  };
  assert.equal(validateCapability(daastCapability), true, JSON.stringify(validateCapability.errors));
  assert.equal(validateCapability({ ...daastCapability, performed_by: 'seller' }), false);

  const validateTarget = ajv.getSchema('/schemas/core/macro-translation-target.json');
  const { declaration_id, location, required, unavailable_behavior, operation, ...targetFields } = daastResolution;
  const daastTarget = { ...targetFields, next_operation: 'resolve_value' };
  assert.equal(validateTarget(daastTarget), true, JSON.stringify(validateTarget.errors));
  assert.equal(validateTarget({ ...daastTarget, performed_by: 'seller' }), false);
});

test('all URL-delivered creative assets preserve registered percent-token dialects', () => {
  const macroUrl = 'https://track.acme-example.com/pixel?cb=%%CACHEBUSTER%%&click=%%ACME_CLICK_ESC2%%';
  const maskOpaqueTokenForms = value => value.replace(
    /%%[A-Za-z0-9_.:-]+%%|\$\{[A-Za-z][A-Za-z0-9_]*\}|\{[A-Za-z][A-Za-z0-9_]*\}|\[[A-Za-z][A-Za-z0-9_]*\]/g,
    'ADCPMACRO'
  );
  const structurallyValidHttpUrl = value => {
    const masked = maskOpaqueTokenForms(value);
    if (!/^https?:\/\/[^/?#\s]+(?:[/?#]|$)/.test(masked)) return false;
    if (/%(?![0-9A-Fa-f]{2})/.test(masked)) return false;
    try {
      const parsed = new URL(masked);
      return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
        && parsed.hostname !== '.';
    } catch {
      return false;
    }
  };
  assert.equal(structurallyValidHttpUrl(macroUrl), true,
    'undeclared legacy token spellings are masked for structure without assigning semantics');
  assert.match(ajv.getSchema('/schemas/core/macro-bearing-url.json').schema['x-adcp-validation']
    .verifier_constraints.macro_aware_uri, /undeclared 3\.x compatibility path/);
  const cases = [
    ['/schemas/core/assets/url-asset.json', { asset_type: 'url', url: macroUrl, url_type: 'tracker_pixel' }],
    ['/schemas/core/assets/pixel-tracker-asset.json', { asset_type: 'pixel_tracker', event: 'impression', url: macroUrl }],
    ['/schemas/core/assets/vast-tracker-asset.json', { asset_type: 'vast_tracker', vast_event: 'start', url: macroUrl }],
    ['/schemas/core/assets/daast-tracker-asset.json', { asset_type: 'daast_tracker', daast_event: 'start', url: macroUrl }],
    ['/schemas/core/assets/vast-asset.json', { asset_type: 'vast', delivery_type: 'url', url: macroUrl }],
    ['/schemas/core/assets/daast-asset.json', { asset_type: 'daast', delivery_type: 'url', url: macroUrl }]
  ];

  for (const [schemaId, asset] of cases) {
    const validate = ajv.getSchema(schemaId);
    assert.equal(validate(asset), true, `${schemaId}: ${JSON.stringify(validate.errors)}`);
    for (const malformed of ['https:///path', 'https://?x=1', 'https://%zz', 'http://.']) {
      assert.equal(structurallyValidHttpUrl(malformed), false, `macro-aware verifier: ${malformed}`);
    }
  }

  const validateUrl = ajv.getSchema('/schemas/core/assets/url-asset.json');
  assert.equal(validateUrl({ asset_type: 'url', url: "https://track.acme-example.com/o'clock", url_type: 'clickthrough' }), true,
    'valid plain HTTP URLs retain ordinary URI behavior');
  for (const legacyUrl of [
    'myapp://creative/launch',
    '//cdn.example.test/creative.js',
    'https://{PUB}.track.example/pixel'
  ]) {
    assert.equal(validateUrl({ asset_type: 'url', url: legacyUrl, url_type: 'clickthrough' }), true,
      `the published uri-template branch remains backward compatible: ${legacyUrl}`);
  }
});

test('creative delivery resolution vectors retain every source and select only compatible candidates', () => {
  const fixture = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
  const validateFixture = ajv.compile(JSON.parse(fs.readFileSync(VECTOR_SCHEMA, 'utf8')));
  const validateSource = ajv.getSchema('/schemas/core/creative-source.json');
  assert.equal(validateFixture(fixture), true, JSON.stringify(validateFixture.errors));

  for (const vector of fixture.vectors) {
    assert.equal(validateSource(vector.source), true, `${vector.name}: ${JSON.stringify(validateSource.errors)}`);
    const compatible = [];
    const rejections = [];

    for (const variant of vector.source.delivery_variants) {
      if (variant.format_kind !== vector.target.format_kind) {
        rejections.push({ variant_id: variant.variant_id, code: 'incompatible_format_kind' });
        continue;
      }
      const firstAsset = Object.values(variant.assets)[0];
      if (variant.format_kind === 'display_tag' &&
          !vector.target.supported_delivery_variants.includes(firstAsset.delivery_type)) {
        rejections.push({ variant_id: variant.variant_id, code: 'unsupported_delivery_variant' });
        continue;
      }
      if (variant.format_kind === 'video_vast') {
        const version = firstAsset.vast_version;
        if (!vector.target.vast_versions.includes(version) || !vector.seller.vast_versions.includes(version)) {
          rejections.push({ variant_id: variant.variant_id, code: 'vast_version_mismatch' });
          continue;
        }
      }
      compatible.push(variant);
    }

    const selected = vector.strategy === 'highest_compatible_vast'
      ? compatible.toSorted((a, b) => Number(Object.values(b.assets)[0].vast_version) - Number(Object.values(a.assets)[0].vast_version))[0]
      : compatible[0];

    assert.deepEqual(compatible.map(v => v.variant_id), vector.expected.compatible_variant_ids, vector.name);
    assert.equal(selected?.variant_id ?? null, vector.expected.selected_variant_id, vector.name);
    assert.deepEqual(vector.source.delivery_variants.map(v => v.variant_id), vector.expected.retained_variant_ids, vector.name);
    assert.deepEqual(rejections, vector.expected.rejections.map(({ variant_id, code }) => ({ variant_id, code })), vector.name);
  }

  const uniqueVariantIds = source => new Set(source.delivery_variants.map(variant => variant.variant_id)).size ===
    source.delivery_variants.length;
  assert.deepEqual(
    validateSource.schema.properties.delivery_variants['x-adcp-validation'].unique_item_properties,
    ['variant_id'],
    'the published verifier contract declares variant identity uniqueness'
  );
  const duplicate = structuredClone(fixture.vectors[0].source);
  duplicate.delivery_variants[1].variant_id = duplicate.delivery_variants[0].variant_id;
  assert.equal(uniqueVariantIds(duplicate), false, 'duplicate source representation IDs fail operational validation');

  const exactRejectionCoverage = (source, rejections) => {
    const candidateIds = source.delivery_variants.map(variant => variant.variant_id).toSorted();
    const rejectionIds = rejections.map(rejection => rejection.variant_id).toSorted();
    return new Set(rejectionIds).size === rejectionIds.length && isDeepStrictEqual(candidateIds, rejectionIds);
  };
  const allRejected = fixture.vectors[0].source.delivery_variants.map(variant => ({
    variant_id: variant.variant_id,
    code: 'other',
    message: 'incompatible'
  }));
  assert.equal(exactRejectionCoverage(fixture.vectors[0].source, allRejected), true);
  assert.equal(exactRejectionCoverage(fixture.vectors[0].source, allRejected.slice(1)), false,
    'unresolved details cannot omit a candidate');
  assert.equal(exactRejectionCoverage(fixture.vectors[0].source, [...allRejected, allRejected[0]]), false,
    'unresolved details cannot duplicate a candidate');
  const deliveryDetailsSchema = ajv.getSchema('/schemas/error-details/creative-delivery-variant-unresolved.json').schema;
  assert.match(deliveryDetailsSchema['x-adcp-validation'].verifier_constraints.exact_candidate_coverage,
    /no missing, duplicate, or unknown/);

  const validateVariant = ajv.getSchema('/schemas/core/creative-delivery-variant.json');
  const vastWithoutVersion = structuredClone(fixture.vectors[1].source.delivery_variants[0]);
  delete vastWithoutVersion.assets.vast_tag.vast_version;
  assert.equal(validateVariant(vastWithoutVersion), false, 'late-bound VAST variants require exact asset versions');

  const validateBuild = ajv.getSchema('/schemas/media-buy/build-creative-request.json');
  const resolutionRequest = {
    idempotency_key: 'resolve-source-0001',
    creative_source: fixture.vectors[0].source,
    target_capability_id: 'paired_redirect_300x250'
  };
  assert.equal(validateBuild(resolutionRequest), true, JSON.stringify(validateBuild.errors));
  assert.equal(validateBuild({ ...resolutionRequest, macro_values: { CACHEBUSTER: '123' } }), true,
    'selection precedes binding and retained source declarations remain unchanged');
});

test('macro processing vectors preserve bytes and match exact owner/context/encoding contracts', () => {
  const fixture = JSON.parse(fs.readFileSync(MACRO_VECTORS, 'utf8'));
  const validateFixture = ajv.compile(JSON.parse(fs.readFileSync(MACRO_VECTOR_SCHEMA, 'utf8')));
  assert.equal(validateFixture(fixture), true, JSON.stringify(validateFixture.errors));

  const encodingEqual = (left, right) => left.kind === right.kind && left.depth === right.depth;
  const evaluateLayer = (declaration, capabilities) => {
    let candidates = capabilities.filter(capability => capability.dialect === declaration.dialect);
    if (!candidates.length) return 'dialect_unsupported';
    candidates = candidates.filter(capability => capability.dialect_namespace === declaration.dialect_namespace);
    if (!candidates.length) return 'namespace_mismatch';
    candidates = candidates.filter(capability => capability.dialect_revision === declaration.dialect_revision);
    if (!candidates.length) return 'revision_mismatch';
    candidates = candidates.filter(capability =>
      capability.dialect_semantic === declaration.dialect_semantic &&
      capability.universal_semantic === declaration.universal_semantic
    );
    if (!candidates.length) return 'semantic_unsupported';
    candidates = candidates.filter(capability => capability.operation === declaration.operation);
    if (!candidates.length) return 'operation_unsupported';
    candidates = candidates.filter(capability => capability.performed_by === declaration.performed_by);
    if (!candidates.length) return 'resolver_mismatch';
    candidates = candidates.filter(capability => capability.supported_contexts.includes(declaration.location.context));
    if (!candidates.length) return 'context_unsupported';
    if (declaration.operation === 'translate_to_native') {
      candidates = candidates.filter(capability =>
        isDeepStrictEqual(capability.translation_target, declaration.translation_target)
      );
      return candidates.length ? null : 'semantic_unsupported';
    }
    candidates = candidates.filter(capability =>
      capability.supported_encodings?.some(encoding => encodingEqual(encoding, declaration.encoding))
    );
    return candidates.length ? null : 'encoding_unsupported';
  };
  const strictRfc3986 = value => encodeURIComponent(value).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

  for (const vector of fixture.vectors) {
    const declaration = vector.declaration;
    let status;
    let reason;
    let output = vector.source;

    if (declaration.operation === 'preserve') {
      status = 'preserved_for_downstream';
      reason = declaration.dialect === 'unknown' ? 'preserved_unknown' : 'preserved_for_downstream';
    } else {
      reason = evaluateLayer(declaration, vector.seller_capabilities) ||
        evaluateLayer(declaration, vector.product_capabilities);
      if (reason) {
        status = 'unsupported';
      } else {
        status = 'resolvable';
        reason = 'capability_match';
        if (declaration.operation === 'translate_to_native') {
          const target = declaration.translation_target;
          const emittedDeclaration = {
            declaration_id: declaration.declaration_id,
            token: target.token,
            dialect: target.dialect,
            ...(target.dialect_namespace && { dialect_namespace: target.dialect_namespace }),
            ...(target.dialect_revision && { dialect_revision: target.dialect_revision }),
            dialect_semantic: target.dialect_semantic,
            mapping_status: target.mapping_status,
            ...(target.universal_semantic && { universal_semantic: target.universal_semantic }),
            operation: target.next_operation,
            performed_by: target.performed_by,
            location: structuredClone(declaration.location),
            encoding: structuredClone(target.encoding),
            required: declaration.required,
            unavailable_behavior: declaration.unavailable_behavior
          };
          const chainReason = evaluateLayer(emittedDeclaration, vector.seller_capabilities) ||
            evaluateLayer(emittedDeclaration, vector.product_capabilities);
          if (chainReason) {
            status = 'unsupported';
            reason = chainReason;
          } else {
            output = output.replace(declaration.token, target.token);
            if (vector.expected.emitted_declaration) {
              assert.deepEqual(emittedDeclaration, vector.expected.emitted_declaration, vector.name);
            }
            if (vector.value !== undefined && vector.expected.final_output) {
              const encoded = strictRfc3986(vector.value);
              const finalOutput = output.replace(target.token, encoded);
              assert.equal(finalOutput, vector.expected.final_output, vector.name);
            }
          }
        } else if (vector.value !== undefined && declaration.operation === 'resolve_value') {
          let encoded = vector.value;
          if (declaration.encoding.kind === 'rfc3986') {
            for (let pass = 0; pass < declaration.encoding.depth; pass++) encoded = strictRfc3986(encoded);
          }
          output = output.replace(declaration.token, encoded);
        }
      }
    }

    assert.equal(status, vector.expected.status, vector.name);
    assert.equal(reason, vector.expected.reason, vector.name);
    assert.equal(output, vector.expected.output, vector.name);
  }

  const declarationIdsAreUnique = declarations =>
    new Set(declarations.map(declaration => declaration.declaration_id)).size === declarations.length;
  const firstDeclaration = fixture.vectors[0].declaration;
  const declarations = [
    firstDeclaration,
    { ...structuredClone(firstDeclaration), declaration_id: 'second-occurrence' }
  ];
  assert.equal(declarationIdsAreUnique(declarations), true);
  assert.equal(declarationIdsAreUnique([...declarations, structuredClone(firstDeclaration)]), false,
    'duplicate declaration IDs fail occurrence-level operational validation');

  const translationVector = fixture.vectors.find(vector => vector.declaration.operation === 'translate_to_native');
  assert.ok(translationVector);
  assert.equal(translationVector.seller_capabilities.length, 2, 'translation requires source and target capability tuples');
  assert.equal(translationVector.product_capabilities.length, 2, 'the selected product also closes the target chain');
});

test('validation and sync response schemas expose per-token macro results', () => {
  const validateInputResultSchema = ajv.getSchema('/schemas/creative/validate-input-result.json').schema;
  const syncResponse = ajv.getSchema('/schemas/creative/sync-creatives-response.json').schema;
  assert.equal(validateInputResultSchema.properties.macro_resolution_results.items.$ref, '/schemas/core/macro-resolution-result.json');
  const syncItem = syncResponse.oneOf[0].properties.creatives.items;
  assert.equal(syncItem.properties.macro_resolution_results.items.$ref, '/schemas/core/macro-resolution-result.json');

  const validateResult = ajv.getSchema('/schemas/core/macro-resolution-result.json');
  const unknownResult = {
    declaration_id: 'unknown-token',
    asset_path: '/assets/impression_tracker',
    token: '%%UNIDENTIFIED%%',
    dialect: 'unknown',
    dialect_semantic: 'unresolved',
    mapping_status: 'unresolved',
    operation: 'preserve',
    requested_encoding: { kind: 'none', depth: 0 },
    required: false,
    unavailable_behavior: 'preserve',
    status: 'preserved_for_downstream',
    reason: 'preserved_unknown'
  };
  assert.equal(validateResult(unknownResult), true, JSON.stringify(validateResult.errors));
  assert.equal(validateResult({ ...unknownResult, status: 'resolvable', reason: 'capability_match' }), false);
  assert.equal(validateResult({ ...unknownResult, status: 'unsupported', reason: 'capability_match' }), false);
  assert.equal(validateResult({
    ...unknownResult,
    dialect: 'adcp',
    dialect_semantic: 'CACHEBUSTER',
    mapping_status: 'verified_universal',
    universal_semantic: 'CACHEBUSTER',
    operation: 'resolve_value',
    performed_by: 'seller',
    requested_encoding: { kind: 'rfc3986', depth: 1 },
    status: 'preserved_for_downstream',
    reason: 'preserved_for_downstream'
  }), false, 'an advertised resolver is resolvable or unsupported, never a preservation result');
  const daastResult = {
    declaration_id: 'daast-error',
    asset_path: '/assets/error_tracker',
    token: '[ERRORCODE]',
    dialect: 'iab_daast',
    dialect_namespace: 'https://iabtechlab.com/standards/daast',
    dialect_revision: 'DAAST-1.1',
    dialect_semantic: 'ERRORCODE',
    mapping_status: 'dialect_defined',
    operation: 'resolve_value',
    performed_by: 'request_executor',
    requested_encoding: { kind: 'rfc3986', depth: 1 },
    required: true,
    unavailable_behavior: 'reject',
    status: 'resolvable',
    reason: 'capability_match'
  };
  assert.equal(validateResult(daastResult), true, JSON.stringify(validateResult.errors));
  assert.equal(validateResult({ ...daastResult, performed_by: 'seller' }), false);
});

test('creative delivery errors use typed detail schemas without closing the generic extension point', () => {
  const genericDetails = ajv.getSchema('/schemas/core/error.json').schema.properties.details;
  assert.equal(genericDetails.additionalProperties, true);
  assert.equal(genericDetails.properties, undefined,
    'error.details stays a pure extension point selected by error code');

  const validateDeliveryDetails = ajv.getSchema(
    '/schemas/error-details/creative-delivery-variant-unresolved.json'
  );
  const deliveryDetails = {
    delivery_variant_rejections: [{
      variant_id: 'source-vast-2',
      code: 'vast_version_mismatch',
      message: 'VAST 2.0 is outside the compatibility intersection'
    }]
  };
  assert.equal(validateDeliveryDetails(deliveryDetails), true,
    JSON.stringify(validateDeliveryDetails.errors));
  assert.equal(validateDeliveryDetails({}), false);

  const validateMacroDetails = ajv.getSchema('/schemas/error-details/macro-resolution-failed.json');
  assert.equal(ajv.getSchema('/schemas/core/macro-declaration.json').schema.properties.declaration_id['x-entity'],
    'macro_declaration');
  assert.equal(ajv.getSchema('/schemas/core/macro-resolution-result.json').schema.properties.declaration_id['x-entity'],
    'macro_declaration');
  assert.ok(ajv.getSchema('/schemas/core/x-entity-types.json').schema.enum.includes('macro_declaration'));
  const macroDetails = {
    macro_resolution_results: [{
      declaration_id: 'unknown-token',
      asset_path: '/assets/impression_tracker',
      token: '%%UNIDENTIFIED%%',
      dialect: 'unknown',
      dialect_semantic: 'unresolved',
      mapping_status: 'unresolved',
      operation: 'preserve',
      requested_encoding: { kind: 'none', depth: 0 },
      required: false,
      unavailable_behavior: 'preserve',
      status: 'preserved_for_downstream',
      reason: 'preserved_unknown'
    }]
  };
  assert.equal(validateMacroDetails(macroDetails), true, JSON.stringify(validateMacroDetails.errors));
  assert.equal(validateMacroDetails({}), false);

  const validateVastDetails = ajv.getSchema('/schemas/error-details/vast-version-mismatch.json');
  const vastDetails = {
    mismatch_reason: 'asset_outside_acceptance',
    asset_vast_version: '4.0',
    product_vast_versions: ['4.1', '4.2'],
    seller_vast_versions: ['4.0', '4.1'],
    format_option_ref: { scope: 'product', format_option_id: 'video-preroll' }
  };
  assert.equal(validateVastDetails(vastDetails), true, JSON.stringify(validateVastDetails.errors));
  assert.equal(validateVastDetails({ ...vastDetails, format_option_ref: undefined }), true,
    'a unique id-less product option has no format option reference to invent');
  assert.equal(validateVastDetails({ ...vastDetails, product_vast_versions: [] }), false,
    'advertised product acceptance sets cannot be empty');
  assert.equal(validateVastDetails({ ...vastDetails, seller_vast_versions: [] }), false,
    'advertised seller acceptance sets cannot be empty');
  assert.equal(validateVastDetails({
    mismatch_reason: 'document_version_mismatch',
    asset_vast_version: '4.0',
    observed_document_vast_version: '5.0',
    document_role: 'submitted'
  }), true, JSON.stringify(validateVastDetails.errors));
  assert.equal(validateVastDetails({
    mismatch_reason: 'document_version_mismatch',
    asset_vast_version: '4.0',
    observed_document_vast_version: null,
    document_role: 'submitted'
  }), true, 'a missing VAST version attribute remains representable');
  const wrapperMismatch = {
    mismatch_reason: 'document_version_mismatch',
    asset_vast_version: '4.0',
    observed_document_vast_version: '3.0',
    document_role: 'wrapper',
    product_vast_versions: ['4.0', '4.1'],
    seller_vast_versions: ['4.0', '4.2']
  };
  assert.equal(validateVastDetails(wrapperMismatch), true, JSON.stringify(validateVastDetails.errors));
  assert.equal(validateVastDetails({ ...wrapperMismatch, product_vast_versions: undefined }), false,
    'wrapper mismatch details must disclose both acceptance sets used as the comparator');
  assert.equal(validateVastDetails({ ...wrapperMismatch, seller_vast_versions: undefined }), false,
    'terminal and wrapper mismatch details cannot omit the seller acceptance set');
  assert.equal(validateVastDetails({ supported_versions: ['3.0', '4.0'] }), true,
    'deprecated 3.x details remain accepted');
  assert.equal(validateVastDetails({ mismatch_reason: 'asset_outside_acceptance', asset_vast_version: '4.0' }), false);
});
