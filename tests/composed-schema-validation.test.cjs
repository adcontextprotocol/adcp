#!/usr/bin/env node
/**
 * Composed Schema Validation Test Suite
 *
 * Tests that schemas using allOf composition can validate realistic data.
 * This catches the common JSON Schema gotcha where allOf + additionalProperties: false
 * causes each sub-schema to reject the other's properties.
 *
 * Related: https://github.com/adcontextprotocol/adcp/issues/275
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

async function loadExternalSchema(uri) {
  if (uri.startsWith('/schemas/')) {
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
    const content = fs.readFileSync(schemaPath, 'utf8');
    return JSON.parse(content);
  }
  throw new Error(`Cannot load external schema: ${uri}`);
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function log(message, type = 'info') {
  const colors = {
    info: '\x1b[0m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m'
  };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

async function testSchemaValidation(schemaId, testData, description) {
  totalTests++;
  try {
    const ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(ajv);

    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const validate = await ajv.compileAsync(schema);
    const valid = validate(testData);

    if (valid) {
      log(`  \u2713 ${description}`, 'success');
      passedTests++;
      return true;
    } else {
      log(`  \u2717 ${description}`, 'error');
      log(`    Errors:`, 'error');
      for (const err of validate.errors) {
        log(`      ${err.instancePath || 'root'}: ${err.message} (${err.schemaPath})`, 'error');
      }
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function testSchemaRejection(schemaId, testData, description) {
  totalTests++;
  try {
    const ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(ajv);

    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const validate = await ajv.compileAsync(schema);
    const valid = validate(testData);

    if (!valid) {
      log(`  \u2713 ${description}`, 'success');
      passedTests++;
      return true;
    } else {
      log(`  \u2717 ${description} — expected rejection, got pass`, 'error');
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

function duplicateValues(items, property) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    const value = item[property];
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateLocalizationRequestSemantics(localization, sourceAssets) {
  const errors = [];
  const targets = localization.target_variants || [];
  for (const property of ['locale_variant_id', 'locale']) {
    if (duplicateValues(targets, property).length > 0) {
      errors.push(`target ${property} values must be unique`);
    }
    if (targets.some((target) => target[property] === localization.source?.[property])) {
      errors.push(`target ${property} must differ from source ${property}`);
    }
  }
  const variants = [localization.source, ...targets].filter(Boolean);
  const variantIds = new Set(variants.map((variant) => variant.locale_variant_id));
  if (!variants.some((variant) => variant.locale_variant_id === localization.default_locale_variant_id)) {
    errors.push('default_locale_variant_id must reference a source or target variant');
  }
  for (const variant of variants) {
    if (!isCanonicalLocaleTag(variant.locale)) {
      errors.push(`locale ${variant.locale} must be canonical BCP 47`);
    }
  }
  const fallbacks = localization.locale_fallbacks || [];
  if (duplicateValues(fallbacks, 'language_range').length > 0) {
    errors.push('locale fallback language_range values must be unique');
  }
  for (const fallback of fallbacks) {
    if (!isCanonicalLocaleTag(fallback.language_range)) {
      errors.push(`fallback range ${fallback.language_range} must be canonical BCP 47`);
    }
    if (!variantIds.has(fallback.locale_variant_id)) {
      errors.push('locale fallback must reference a source or target variant');
    }
  }
  if (localization.source && sourceAssets) {
    errors.push(...validateLocalizedAssetLanguages(localization.source, sourceAssets));
  }
  for (const target of targets) {
    const resolvedAssets = sourceAssets
      ? { ...sourceAssets, ...(target.assets || {}) }
      : target.assets;
    errors.push(...validateLocalizedAssetLanguages(target, resolvedAssets));
  }
  return errors;
}

function isCanonicalLocaleTag(locale) {
  if (typeof locale !== 'string') return false;
  if (/^x(?:-[a-z0-9]{1,8})+$/.test(locale)) return true;
  try {
    return Intl.getCanonicalLocales(locale)[0] === locale;
  } catch {
    return false;
  }
}

function validateLocalizedAssetLanguages(variant, assets) {
  const errors = [];
  for (const [slot, value] of Object.entries(assets || {})) {
    const items = Array.isArray(value) ? value : [value];
    for (const [index, asset] of items.entries()) {
      if (!['text', 'markdown'].includes(asset?.asset_type) || asset.language === undefined) {
        continue;
      }
      const assetLabel = Array.isArray(value) ? `${slot}[${index}]` : slot;
      if (!isCanonicalLocaleTag(asset.language)) {
        errors.push(
          `${variant.locale_variant_id} asset ${assetLabel} language must use the AdCP canonical wire profile`
        );
      } else if (asset.language !== variant.locale) {
        errors.push(
          `${variant.locale_variant_id} asset ${assetLabel} language must equal enclosing variant locale`
        );
      }
    }
  }
  return errors;
}

function rfc4647Candidates(preference) {
  const candidates = [];
  let candidate = preference.toLowerCase();
  while (candidate) {
    candidates.push(candidate);
    const parts = candidate.split('-');
    parts.pop();
    if (parts.at(-1)?.length === 1) parts.pop();
    candidate = parts.join('-');
  }
  return candidates;
}

function rfc4647Lookup(preferences, variants) {
  const byLocale = new Map(variants.map((variant) => [variant.locale.toLowerCase(), variant]));
  for (const preference of preferences) {
    for (const candidate of rfc4647Candidates(preference)) {
      if (byLocale.has(candidate)) return byLocale.get(candidate);
    }
  }
  return undefined;
}

function rfc4647BasicFilter(languageRange, locale) {
  const range = languageRange.toLowerCase();
  const tag = locale.toLowerCase();
  return tag === range || tag.startsWith(`${range}-`);
}

function localePolicyEligibleVariants(localization, localePolicy) {
  const variants = localization?.variants || [];
  if (!localePolicy) return variants;
  const ranges = localePolicy.accepted_language_ranges || [];
  return variants.filter((variant) =>
    ranges.some((range) => rfc4647BasicFilter(range, variant.locale))
  );
}

function validateLocalePolicyAssignment(localization, localePolicy) {
  const errors = [];
  const eligible = localePolicyEligibleVariants(localization, localePolicy);
  if (eligible.length === 0) {
    errors.push('at least one materialized variant must match accepted language ranges');
    return errors;
  }
  if (
    localization.unmatched_locale_action === 'serve_default' &&
    !eligible.some(
      (variant) => variant.locale_variant_id === localization.default_locale_variant_id
    )
  ) {
    errors.push('serve_default must reference a seller-eligible locale variant');
  }
  return errors;
}

function localePolicyNarrows(productPolicy, placementPolicy) {
  if (!productPolicy) return true;
  return placementPolicy.accepted_language_ranges.every((placementRange) =>
    productPolicy.accepted_language_ranges.some((productRange) =>
      rfc4647BasicFilter(productRange, placementRange)
    )
  );
}

function selectLocalizedVariant(localization, preferences, localePolicy) {
  const variants = localePolicyEligibleVariants(localization, localePolicy);
  const eligibleIds = new Set(variants.map((variant) => variant.locale_variant_id));
  const fallbackByRange = new Map(
    (localization.locale_fallbacks || [])
      .filter((fallback) => eligibleIds.has(fallback.locale_variant_id))
      .map((fallback) => [
        fallback.language_range.toLowerCase(),
        fallback.locale_variant_id
      ])
  );
  for (const preference of preferences) {
    const matched = rfc4647Lookup([preference], variants);
    if (matched) return matched.locale_variant_id;
    for (const candidate of rfc4647Candidates(preference)) {
      if (fallbackByRange.has(candidate)) return fallbackByRange.get(candidate);
    }
  }
  return localization.unmatched_locale_action === 'serve_default' &&
    eligibleIds.has(localization.default_locale_variant_id)
    ? localization.default_locale_variant_id
    : undefined;
}

function validateLocalizationReadbackSemantics(localization, enclosingAssets) {
  const errors = [];
  const variants = localization.variants || [];
  for (const property of ['locale_variant_id', 'locale']) {
    if (duplicateValues(variants, property).length > 0) {
      errors.push(`variant ${property} values must be unique`);
    }
  }
  const sourceCount = variants.filter((variant) => variant.role === 'source').length;
  if (sourceCount !== 1) errors.push('localization must contain exactly one source variant');
  if (!variants.some((variant) => variant.locale_variant_id === localization.default_locale_variant_id)) {
    errors.push('default_locale_variant_id must reference exactly one variant');
  }
  if (localization.locale_matching !== 'rfc4647_lookup') {
    errors.push('locale_matching must be rfc4647_lookup');
  }
  const variantIds = new Set(variants.map((variant) => variant.locale_variant_id));
  const fallbacks = localization.locale_fallbacks || [];
  if (duplicateValues(fallbacks, 'language_range').length > 0) {
    errors.push('locale fallback language_range values must be unique');
  }
  if (fallbacks.some((fallback) => !isCanonicalLocaleTag(fallback.language_range))) {
    errors.push('locale fallback language_range must be canonical BCP 47');
  }
  if (fallbacks.some((fallback) => !variantIds.has(fallback.locale_variant_id))) {
    errors.push('locale fallback must reference exactly one variant');
  }
  const source = variants.find((variant) => variant.role === 'source');
  if (source && enclosingAssets && JSON.stringify(source.assets) !== JSON.stringify(enclosingAssets)) {
    errors.push('source localization assets must equal enclosing creative assets');
  }
  for (const variant of variants) {
    errors.push(...validateLocalizedAssetLanguages(variant, variant.assets));
  }
  return errors;
}

function validateLocalizationAgainstRequest(requestLocalization, readback, label) {
  const errors = [];
  if (!readback) return [`${label} localization readback is required`];
  const source = readback.variants?.find((variant) => variant.role === 'source');
  if (!source) return [`${label} source localization readback is required`];
  for (const property of ['locale_variant_id', 'locale']) {
    if (source[property] !== requestLocalization.source[property]) {
      errors.push(`${label} source ${property} must equal request`);
    }
  }
  const requestTargets = new Map(
    requestLocalization.target_variants.map((variant) => [variant.locale_variant_id, variant])
  );
  const responseTargets = (readback.variants || []).filter((variant) => variant.role === 'target');
  if (responseTargets.length !== requestTargets.size) {
    errors.push(`${label} target locale_variant_id set must exactly equal request`);
  }
  for (const target of responseTargets) {
    const requested = requestTargets.get(target.locale_variant_id);
    if (!requested) {
      errors.push(`${label} target locale_variant_id set must exactly equal request`);
      continue;
    }
    for (const property of ['locale']) {
      if (target[property] !== requested[property]) {
        errors.push(`${label} target ${property} must equal request`);
      }
    }
  }
  for (const property of ['default_locale_variant_id', 'unmatched_locale_action']) {
    if (readback[property] !== requestLocalization[property]) {
      errors.push(`${label} ${property} must equal request`);
    }
  }
  const requestedFallbacks = new Map(
    (requestLocalization.locale_fallbacks || []).map((fallback) => [
      fallback.language_range,
      fallback.locale_variant_id
    ])
  );
  const responseFallbacks = new Map(
    (readback.locale_fallbacks || []).map((fallback) => [
      fallback.language_range,
      fallback.locale_variant_id
    ])
  );
  if (
    requestedFallbacks.size !== responseFallbacks.size ||
    [...requestedFallbacks].some(([range, id]) => responseFallbacks.get(range) !== id)
  ) {
    errors.push(`${label} locale_fallbacks must exactly equal request`);
  }
  return errors;
}

function validateLocalizationRoundTrip(requestLocalization, syncItem, listItem) {
  const errors = [];
  if (['failed', 'deleted'].includes(syncItem.action)) {
    if (syncItem.localization !== undefined) {
      errors.push('failed or deleted sync result must omit localization');
    }
    return errors;
  }
  if (!requestLocalization) return errors;
  for (const [label, item] of [
    ['sync', syncItem],
    ['list', listItem]
  ]) {
    if (!item?.status) errors.push(`${label} creative status is required`);
    errors.push(...validateLocalizationAgainstRequest(requestLocalization, item?.localization, label));
    if (item?.localization) {
      errors.push(...validateLocalizationReadbackSemantics(item.localization, item.assets));
    }
  }
  return errors;
}

function validateLocalizedSourceUpsert(previousLocalization, nextCreative) {
  if (!previousLocalization || Object.hasOwn(nextCreative, 'localization')) return [];
  const priorSource = previousLocalization.variants?.find((variant) => variant.role === 'source');
  if (!priorSource || JSON.stringify(priorSource.assets) !== JSON.stringify(nextCreative.assets)) {
    return [
      'localization omission requires top-level assets to equal prior localized source assets'
    ];
  }
  return [];
}

function testSemanticValidation(errors, expectedError, description) {
  totalTests++;
  const passed = expectedError
    ? errors.some((error) => error.includes(expectedError))
    : errors.length === 0;
  if (passed) {
    log(`  \u2713 ${description}`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${description}`, 'error');
    log(`    Semantic errors: ${JSON.stringify(errors)}`, 'error');
    failedTests++;
  }
}

function testValidationConstraints(constraints, expectedConstraints, description) {
  totalTests++;
  const passed =
    constraints &&
    Object.entries(expectedConstraints).every(
      ([key, value]) => JSON.stringify(constraints[key]) === JSON.stringify(value)
    );
  if (passed) {
    log(`  \u2713 ${description}`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${description}`, 'error');
    log(`    Constraints: ${JSON.stringify(constraints)}`, 'error');
    failedTests++;
  }
}

function testValidationAnnotation(schemaId, expectedConstraints, description) {
  const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  testValidationConstraints(
    schema['x-adcp-validation']?.verifier_constraints,
    expectedConstraints,
    description
  );
}

function testNestedValidationAnnotation(schemaId, propertyPath, expectedConstraints, description) {
  const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const node = propertyPath.reduce((value, key) => value?.[key], schema);
  testValidationConstraints(
    node?.['x-adcp-validation']?.verifier_constraints,
    expectedConstraints,
    description
  );
}

function testTypedDiscriminatedUnion(
  schemaId,
  propertyPath,
  discriminator,
  expectedVariants,
  description
) {
  totalTests++;
  const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const node = propertyPath.reduce((value, key) => value?.[key], schema);
  const variants = node?.oneOf || [];
  const passed =
    node?.discriminator?.propertyName === discriminator &&
    variants.length === expectedVariants.length &&
    expectedVariants.every((expected) =>
      variants.some((variant) =>
        Object.entries(expected).every(
          ([property, value]) =>
            variant.properties?.[property]?.type === 'string' &&
            variant.properties?.[property]?.const === value &&
            variant.required?.includes(property)
        )
      )
    );
  if (passed) {
    log(`  \u2713 ${description}`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${description}`, 'error');
    log(`    Union: ${JSON.stringify(node)}`, 'error');
    failedTests++;
  }
}

async function runTests() {
  log('Testing Composed Schema Validation (allOf patterns)', 'info');
  log('====================================================');
  log('');

  // Test 1: Video Asset (was: allOf with dimensions.json)
  log('Video Asset Schema:', 'info');
  await testSchemaValidation(
    '/schemas/core/assets/video-asset.json',
    {
      asset_type: 'video',
      url: 'https://example.com/video.mp4',
      width: 1920,
      height: 1080,
      duration_ms: 30000
    },
    'Video with all common fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/video-asset.json',
    {
      asset_type: 'video',
      url: 'https://example.com/video.mp4',
      width: 1920,
      height: 1080,
      duration_ms: 30000,
      format: 'mp4',
      bitrate_kbps: 5000
    },
    'Video with all optional fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/video-asset.json',
    {
      asset_type: 'video',
      url: 'https://example.com/video.mp4',
      width: 1920,
      height: 1080
    },
    'Video with minimum required fields'
  );

  log('');

  // Test 2: Image Asset (was: allOf with dimensions.json)
  log('Image Asset Schema:', 'info');
  await testSchemaValidation(
    '/schemas/core/assets/image-asset.json',
    {
      asset_type: 'image',
      url: 'https://example.com/image.png',
      width: 300,
      height: 250,
      format: 'png'
    },
    'Image with common fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/image-asset.json',
    {
      asset_type: 'image',
      url: 'https://example.com/image.jpg',
      width: 728,
      height: 90,
      format: 'jpg',
      alt_text: 'Banner advertisement'
    },
    'Image with all optional fields'
  );

  await testSchemaValidation(
    '/schemas/core/assets/image-asset.json',
    {
      asset_type: 'image',
      url: 'https://example.com/image.webp',
      width: 300,
      height: 250
    },
    'Image with minimum required fields'
  );

  log('');

  // Test 3: Open-bound hosted durations through product format options
  log('Hosted Duration Schemas:', 'info');
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      product_id: 'shopgrid_hosted_duration_video',
      name: 'ShopGrid Hosted Duration Video',
      description: 'Retail media video inventory with open-bound hosted duration constraints.',
      publisher_properties: [
        {
          publisher_domain: 'shopgrid.example',
          selection_type: 'by_id',
          property_ids: ['shopgrid_owned_site']
        }
      ],
      channels: ['retail_media'],
      format_options: [
        {
          format_kind: 'video_hosted',
          params: {
            orientation: 'vertical',
            duration_ms_range: [null, 30000],
            video_codecs: ['h264'],
            audio_codecs: ['aac'],
            containers: ['mp4']
          }
        },
        {
          format_kind: 'audio_hosted',
          params: {
            duration_ms_range: [15000, null],
            audio_codecs: ['mp3']
          }
        }
      ],
      delivery_type: 'non_guaranteed',
      pricing_options: [
        {
          pricing_option_id: 'network_cpm',
          pricing_model: 'cpm',
          currency: 'USD'
        }
      ],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend'],
        date_range_support: 'date_range'
      }
    },
    'Product accepts hosted open-bound duration ranges'
  );

  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      product_id: 'shopgrid_duration_precedence_video',
      name: 'ShopGrid Duration Precedence Video',
      description: 'Retail media video inventory declaring exact duration precedence over a broader range.',
      publisher_properties: [
        {
          publisher_domain: 'shopgrid.example',
          selection_type: 'by_id',
          property_ids: ['shopgrid_owned_site']
        }
      ],
      channels: ['retail_media'],
      format_options: [
        {
          format_kind: 'video_hosted',
          params: {
            duration_ms_exact: 30000,
            duration_ms_range: [null, 60000]
          }
        }
      ],
      delivery_type: 'non_guaranteed',
      pricing_options: [
        {
          pricing_option_id: 'network_cpm',
          pricing_model: 'cpm',
          currency: 'USD'
        }
      ],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions', 'spend'],
        date_range_support: 'date_range'
      }
    },
    'Product accepts exact duration plus range for precedence handling'
  );

  const unboundedBothSidesProduct = {
    product_id: 'shopgrid_invalid_duration',
    name: 'ShopGrid Invalid Duration',
    description: 'Invalid retail media video inventory.',
    publisher_properties: [
      {
        publisher_domain: 'shopgrid.example',
        selection_type: 'by_id',
        property_ids: ['shopgrid_owned_site']
      }
    ],
    channels: ['retail_media'],
    format_options: [
      {
        format_kind: 'video_hosted',
        params: {
          duration_ms_range: [null, null]
        }
      }
    ],
    delivery_type: 'non_guaranteed',
    pricing_options: [
      {
        pricing_option_id: 'network_cpm',
        pricing_model: 'cpm',
        currency: 'USD'
      }
    ],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions', 'spend'],
      date_range_support: 'date_range'
    }
  };
  await testSchemaRejection(
    '/schemas/core/product.json',
    unboundedBothSidesProduct,
    'Product rejects hosted duration_ms_range with both endpoints null'
  );

  const frenchOnlyImageFormat = {
    format_kind: 'image',
    format_option_id: 'quebec_display_image',
    canonical_formats_only: true,
    locale_policy: {
      accepted_language_ranges: ['fr']
    },
    params: {
      width: 300,
      height: 250
    }
  };
  await testSchemaValidation(
    '/schemas/core/product-format-declaration.json',
    frenchOnlyImageFormat,
    'Product format accepts a canonical-only French creative locale policy'
  );
  await testSchemaRejection(
    '/schemas/core/product-format-declaration.json',
    { ...frenchOnlyImageFormat, canonical_formats_only: false },
    'Locale-constrained product format rejects legacy projection'
  );
  const localePolicyWithLegacyRef = structuredClone(frenchOnlyImageFormat);
  localePolicyWithLegacyRef.v1_format_ref = [
    {
      agent_url: 'https://creative.adcontextprotocol.org',
      id: 'display_300x250_image'
    }
  ];
  await testSchemaRejection(
    '/schemas/core/product-format-declaration.json',
    localePolicyWithLegacyRef,
    'Locale-constrained product format rejects v1_format_ref'
  );
  await testSchemaRejection(
    '/schemas/core/creative-locale-policy.json',
    { accepted_language_ranges: ['FR'] },
    'Creative locale policy rejects a non-canonical language range'
  );
  await testSchemaValidation(
    '/schemas/core/placement-definition.json',
    {
      placement_id: 'quebec_homepage',
      name: 'Québec homepage',
      property_ids: ['quebec_news'],
      format_options: [
        {
          format_option_id: 'quebec_display_image',
          locale_policy: { accepted_language_ranges: ['fr-CA'] }
        }
      ]
    },
    'Placement format reference accepts a narrower locale policy override'
  );
  testValidationAnnotation(
    '/schemas/core/creative-locale-policy.json',
    {
      range_matching: 'rfc4647_basic_filtering',
      wildcards: 'not_supported',
      assignment_eligibility: 'at_least_one_materialized_variant_must_match',
      selection_precedence:
        'filter_seller_eligible_variants_before_buyer_lookup_fallback_or_default',
      serve_default:
        'when_unmatched_locale_action_is_serve_default_default_locale_variant_id_must_reference_an_eligible_variant',
      placement_narrowing:
        'product_policy_absent_allows_any_placement_policy_else_every_placement_range_must_be_contained_by_a_product_range',
      legacy_projection:
        'no_product_or_placement_format_id_may_project_to_a_locale_constrained_option',
      capability_gate:
        'seller_must_advertise_creative.localization_and_creative.has_creative_library',
      assignment_policy_lifecycle:
        'snapshot_effective_policy_at_acceptance_catalog_changes_apply_only_to_new_or_changed_assignments'
    },
    'Creative locale policy exposes machine-readable eligibility semantics'
  );
  testNestedValidationAnnotation(
    '/schemas/core/product.json',
    ['properties', 'format_options'],
    {
      locale_policy_legacy_projection:
        'no_product_or_placement_format_id_may_project_to_a_locale_constrained_option',
      placement_locale_policy:
        'product_policy_absent_allows_any_narrowing_else_ranges_must_be_contained',
      assignment_locale_eligibility:
        'validate_every_effective_placement_format_option_in_delivery_scope',
      locale_policy_capability_gate:
        'creative.localization_and_creative.has_creative_library_must_be_advertised',
      locale_policy_assignment_lifecycle: 'snapshot_effective_policy_at_acceptance'
    },
    'Product format options expose locale capability and legacy projection rules'
  );
  testNestedValidationAnnotation(
    '/schemas/core/placement-definition.json',
    ['properties', 'format_options'],
    {
      locale_policy_override_resolution:
        'resolved_catalog_and_matching_product_declarations_must_be_canonical_only_without_v1_projection'
    },
    'Placement format options expose canonical-only locale override resolution'
  );
  testSemanticValidation(
    rfc4647BasicFilter('fr', 'fr-CA') && !rfc4647BasicFilter('fr-CA', 'fr-FR')
      ? []
      : ['RFC 4647 Basic Filtering was not directional'],
    undefined,
    'Creative locale policy uses directional RFC 4647 Basic Filtering'
  );
  testSemanticValidation(
    localePolicyNarrows(
      { accepted_language_ranges: ['fr'] },
      { accepted_language_ranges: ['fr-CA'] }
    )
      ? []
      : ['fr-CA did not narrow product range fr'],
    undefined,
    'Placement locale policy may narrow product range fr to fr-CA'
  );
  testSemanticValidation(
    localePolicyNarrows(undefined, { accepted_language_ranges: ['fr-CA'] })
      ? []
      : ['Placement could not narrow an unconstrained product locale policy'],
    undefined,
    'Placement may introduce a locale policy when the product has none'
  );
  testSemanticValidation(
    !localePolicyNarrows(
      { accepted_language_ranges: ['fr-CA'] },
      { accepted_language_ranges: ['fr'] }
    )
      ? []
      : ['placement range fr broadened product range fr-CA'],
    undefined,
    'Placement locale policy cannot broaden product range fr-CA to fr'
  );

  log('');

  // Test 4: Create Media Buy Request with reporting_webhook (allOf with push-notification-config.json)
  log('Create Media Buy Request Schema (reporting_webhook field):', 'info');
  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440000',
      account: { account_id: 'acc_test_001' },
      packages: [
        {
          product_id: 'ctv_premium',
          budget: 50000,
          pricing_option_id: 'cpm_standard'
        }
      ],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z',
      reporting_webhook: {
        url: 'https://webhook.example.com/reporting',
        authentication: {
          schemes: ['Bearer'],
          credentials: 'a'.repeat(32)
        },
        reporting_frequency: 'daily',
        requested_metrics: ['impressions', 'spend', 'clicks']
      }
    },
    'Create media buy with reporting_webhook (allOf composition)'
  );

  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      account: { account_id: 'acc_test_001' },
      packages: [
        {
          product_id: 'display_standard',
          budget: 10000,
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z'
    },
    'Create media buy without optional reporting_webhook'
  );

  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: '6ba7b811-9dad-41d1-80b4-00c04fd430c9',
      account: { brand: { domain: 'acmecorp.com' }, operator: 'acmecorp.com' },
      packages: [
        {
          product_id: 'display_standard',
          budget: 10000,
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand: {
        domain: 'acmecorp.com'
      },
      start_time: 'asap',
      end_time: '2024-12-31T23:59:59Z'
    },
    'Create media buy with natural key account'
  );

  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'shared-budget-create-0001',
      account: { account_id: 'acc_test_001' },
      total_budget: { amount: 100000, currency: 'USD' },
      budget_allocation: {
        mode: 'seller_optimized',
        optimization_goals: [
          { kind: 'metric', metric: 'clicks' }
        ]
      },
      pacing: 'even',
      bidding: {
        cost_per: { amount: 25, strength: 'cap' },
        max_bid: 8
      },
      packages: [
        {
          product_id: 'prospecting',
          pricing_option_id: 'cpm_auction',
          budget: 70000,
          min_spend_target: 20000
        },
        {
          product_id: 'retargeting',
          pricing_option_id: 'cpm_auction',
          pacing: 'front_loaded'
        }
      ],
      brand: { domain: 'acmecorp.com' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z'
    },
    'Create media buy accepts seller-optimized shared budget with package constraints'
  );

  await testSchemaValidation(
    '/schemas/core/bidding-policy.json',
    {
      cost_per: { amount: 25, strength: 'target' },
      max_bid: 4.5
    },
    'Bidding policy accepts average-cost target with a provider-supported auction ceiling'
  );

  await testSchemaValidation(
    '/schemas/core/bidding-policy.json',
    { automatic: true },
    'Bidding policy accepts an explicit automatic policy override'
  );

  await testSchemaRejection(
    '/schemas/core/bidding-policy.json',
    { automatic: true, max_bid: 4.5 },
    'Bidding policy rejects automatic combined with a monetary mode'
  );

  await testSchemaValidation(
    '/schemas/core/media-buy-features.json',
    {
      bidding_policy: {
        package: {
          fixed: {
            modes: ['cost_per'],
            cost_per_strengths: ['cap']
          }
        }
      }
    },
    'Bidding capability can advertise only package cost caps'
  );

  await testSchemaValidation(
    '/schemas/core/media-buy-features.json',
    {
      bidding_policy: {
        media_buy: {
          fixed: {
            modes: ['max_bid', 'roas'],
            roas_strengths: ['floor', 'target'],
            supported_combinations: [
              { kind: 'max_bid_with_roas', roas_strengths: ['floor'] }
            ]
          }
        },
        package: {
          seller_optimized: {
            modes: ['automatic', 'bid_amount']
          }
        }
      }
    },
    'Bidding capability declares independent scopes, strengths, and combinations'
  );

  await testSchemaRejection(
    '/schemas/core/media-buy-features.json',
    { bidding_policy: true },
    'Bidding capability rejects the former coarse boolean claim'
  );

  await testSchemaRejection(
    '/schemas/core/bidding-policy-capability.json',
    {
      package: { fixed: { modes: ['cost_per'] } }
    },
    'Bidding capability requires strengths for cost_per support'
  );

  await testSchemaValidation(
    '/schemas/core/bidding-policy-capability.json',
    {
      media_buy: {
        fixed: {
          supported_combinations: [
            { kind: 'max_bid_with_cost_per', cost_per_strengths: ['cap'] }
          ]
        }
      }
    },
    'Bidding capability advertises combination-only support without standalone component modes'
  );

  await testSchemaRejection(
    '/schemas/core/bidding-policy-capability.json',
    {
      package: {
        modes: ['automatic']
      }
    },
    'Bidding capability requires an explicit allocation context'
  );

  await testSchemaValidation(
    '/schemas/media-buy/sync-event-sources-request.json',
    {
      idempotency_key: 'value-currency-source-0001',
      account: { account_id: 'acc_test_001' },
      event_sources: [
        {
          event_source_id: 'commerce_events',
          event_types: ['purchase'],
          value_currencies: ['USD', 'EUR']
        }
      ]
    },
    'Event source declares the currencies available to canonical ROAS buys'
  );

  await testSchemaValidation(
    '/schemas/core/event-custom-data.json',
    { value: 25 },
    'Legacy monetary event data remains compatible without a source currency contract'
  );

  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'automatic-package-override-001',
      account: { account_id: 'acc_test_001' },
      total_budget: { amount: 20000, currency: 'USD' },
      bidding: { max_bid: 5 },
      packages: [
        {
          product_id: 'display_default',
          pricing_option_id: 'cpm_usd_auction',
          budget: 10000
        },
        {
          product_id: 'display_automatic',
          pricing_option_id: 'cpm_usd_auction',
          budget: 10000,
          bidding: { automatic: true }
        }
      ],
      brand: { domain: 'acmecorp.com' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z'
    },
    'Package automatic policy explicitly overrides a media-buy bidding default'
  );

  await testSchemaValidation(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_automatic_001',
      bidding: { automatic: true }
    },
    'Package update accepts an explicit automatic bidding override'
  );

  await testSchemaValidation(
    '/schemas/core/package.json',
    {
      package_id: 'pkg_automatic_001',
      bidding: { automatic: true }
    },
    'Package readback preserves an explicit automatic bidding override'
  );

  await testSchemaValidation(
    '/schemas/media-buy/package-request.json',
    {
      product_id: 'search_clicks',
      pricing_option_id: 'cpc_auction',
      budget: 10000,
      bidding: { bid_amount: 2.25 },
      optimization_goals: [
        { kind: 'metric', metric: 'clicks' }
      ]
    },
    'Package accepts explicit manual bidding separately from its objective'
  );

  await testSchemaValidation(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_search_001',
      bidding: null
    },
    'Package update accepts clearing an authored bidding override to restore inheritance'
  );

  await testSchemaValidation(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_shared_001',
      budget: null,
      min_spend_target: null
    },
    'Package update accepts clearing seller-optimized package spend constraints'
  );

  await testSchemaValidation(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_search_001',
      bidding: null,
      bid_price: 2.25
    },
    'Package update accepts atomically clearing canonical bidding and setting legacy bid_price'
  );

  await testSchemaValidation(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_conversion_001',
      bidding: null,
      optimization_goals: [
        {
          kind: 'event',
          event_sources: [{ event_source_id: 'purchases', event_type: 'purchase' }],
          target: { kind: 'cost_per', value: 25 }
        }
      ]
    },
    'Package update accepts clearing canonical bidding with a legacy monetary goal target'
  );

  await testSchemaRejection(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_search_001',
      bidding: { max_bid: 3 },
      bid_price: 2.25
    },
    'Package update rejects non-null canonical bidding combined with legacy bid_price'
  );

  await testSchemaRejection(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_conversion_001',
      bidding: { cost_per: { amount: 25, strength: 'target' } },
      optimization_goals: [
        {
          kind: 'event',
          event_sources: [{ event_source_id: 'purchases', event_type: 'purchase' }],
          target: { kind: 'cost_per', value: 25 }
        }
      ]
    },
    'Package update rejects non-null canonical bidding with a legacy monetary goal target'
  );

  await testSchemaRejection(
    '/schemas/core/bidding-policy.json',
    {
      bid_amount: 2.25,
      max_bid: 3
    },
    'Bidding policy rejects simultaneous manual bid and hard auction ceiling'
  );

  await testSchemaRejection(
    '/schemas/core/bidding-policy.json',
    {
      cost_per: { amount: 25, strength: 'cap' },
      roas: { value: 4, strength: 'floor' }
    },
    'Bidding policy rejects multiple primary policy modes'
  );

  await testSchemaRejection(
    '/schemas/media-buy/package-request.json',
    {
      product_id: 'search_clicks',
      pricing_option_id: 'cpc_auction',
      budget: 10000,
      bid_price: 2.25,
      bidding: { max_bid: 3 }
    },
    'Package rejects canonical bidding combined with legacy bid_price'
  );

  await testSchemaRejection(
    '/schemas/media-buy/package-request.json',
    {
      product_id: 'conversion_search',
      pricing_option_id: 'cpc_auction',
      budget: 10000,
      bidding: { cost_per: { amount: 25, strength: 'target' } },
      optimization_goals: [
        {
          kind: 'event',
          event_sources: [{ event_source_id: 'purchases', event_type: 'purchase' }],
          target: { kind: 'cost_per', value: 25 }
        }
      ]
    },
    'Package rejects canonical bidding combined with a legacy monetary goal target'
  );

  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'ambiguous-media-bidding-001',
      account: { account_id: 'acc_test_001' },
      bidding: { max_bid: 5 },
      packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_auction',
          budget: 10000,
          bid_price: 4
        }
      ],
      brand: { domain: 'acmecorp.com' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z'
    },
    'Media-buy bidding rejects an inheriting package with legacy bid_price'
  );

  await testSchemaRejection(
    '/schemas/media-buy/update-media-buy-request.json',
    {
      idempotency_key: 'ambiguous-new-package-bid-001',
      account: { account_id: 'acc_test_001' },
      media_buy_id: 'mb_bidding_001',
      bidding: { max_bid: 5 },
      new_packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_auction',
          budget: 10000,
          bid_price: 4
        }
      ]
    },
    'Media-buy bidding rejects an inheriting new package with legacy bid_price'
  );

  await testSchemaRejection(
    '/schemas/media-buy/update-media-buy-request.json',
    {
      idempotency_key: 'ambiguous-new-package-goal-01',
      account: { account_id: 'acc_test_001' },
      media_buy_id: 'mb_bidding_002',
      bidding: { max_bid: 5 },
      new_packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_auction',
          budget: 10000,
          optimization_goals: [
            {
              kind: 'event',
              event_sources: [{ event_source_id: 'purchases', event_type: 'purchase' }],
              target: { kind: 'cost_per', value: 25 }
            }
          ]
        }
      ]
    },
    'Media-buy bidding rejects an inheriting new package with a legacy monetary goal target'
  );

  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'fixed-missing-budget-001',
      account: { account_id: 'acc_test_001' },
      packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand: { domain: 'acmecorp.com' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z'
    },
    'Create media buy keeps package budget required in fixed mode'
  );

  await testSchemaRejection(
    '/schemas/media-buy/update-media-buy-request.json',
    {
      idempotency_key: 'fixed-add-missing-budget-001',
      account: { account_id: 'acc_test_001' },
      media_buy_id: 'mb_fixed_001',
      new_packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_fixed'
        }
      ]
    },
    'Update media buy keeps new-package budget required when allocation is fixed or omitted'
  );

  await testSchemaRejection(
    '/schemas/media-buy/update-media-buy-request.json',
    {
      idempotency_key: 'explicit-fixed-add-missing-001',
      account: { account_id: 'acc_test_001' },
      media_buy_id: 'mb_fixed_002',
      budget_allocation: { mode: 'fixed' },
      new_packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_fixed'
        }
      ]
    },
    'Update media buy requires new-package budget when fixed allocation is explicit'
  );

  await testSchemaValidation(
    '/schemas/media-buy/update-media-buy-request.json',
    {
      idempotency_key: 'shared-add-uncapped-001',
      account: { account_id: 'acc_test_001' },
      media_buy_id: 'mb_shared_001',
      budget_allocation: {
        mode: 'seller_optimized',
        optimization_goals: [
          { kind: 'metric', metric: 'clicks' }
        ]
      },
      new_packages: [
        {
          product_id: 'retargeting',
          pricing_option_id: 'cpm_auction',
          min_spend_target: 5000
        }
      ]
    },
    'Update media buy accepts an uncapped new package with explicit seller-optimized allocation context'
  );

  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'shared-missing-total-001',
      account: { account_id: 'acc_test_001' },
      budget_allocation: {
        mode: 'seller_optimized',
        optimization_goals: [
          { kind: 'metric', metric: 'clicks' }
        ]
      },
      packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand: { domain: 'acmecorp.com' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z'
    },
    'Create media buy rejects seller-optimized allocation without total_budget'
  );

  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'lowercase-currency-0001',
      account: { account_id: 'acc_test_001' },
      total_budget: { amount: 10000, currency: 'usd' },
      packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_fixed',
          budget: 10000
        }
      ],
      brand: { domain: 'acmecorp.com' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z'
    },
    'Create media buy rejects a malformed media-buy currency'
  );

  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'allocation-legacy-target-0001',
      account: { account_id: 'acc_test_001' },
      total_budget: { amount: 10000, currency: 'USD' },
      budget_allocation: {
        mode: 'seller_optimized',
        optimization_goals: [
          {
            kind: 'metric',
            metric: 'clicks',
            target: { kind: 'cost_per', value: 3 }
          }
        ]
      },
      packages: [
        {
          product_id: 'display_standard',
          pricing_option_id: 'cpm_fixed'
        }
      ],
      brand: { domain: 'acmecorp.com' },
      start_time: 'asap',
      end_time: '2099-12-31T23:59:59Z'
    },
    'Seller-optimized allocation goals reject legacy monetary targets'
  );

  await testSchemaValidation(
    '/schemas/core/proposal.json',
    {
      proposal_id: 'prop_shared_001',
      name: 'Seller-optimized performance plan',
      budget_allocation: {
        mode: 'seller_optimized',
        optimization_goals: [
          { kind: 'metric', metric: 'clicks' }
        ]
      },
      pacing: 'even',
      allocations: [
        {
          product_id: 'prospecting',
          min_spend_target_percentage: 20,
          max_spend_percentage: 70,
          pacing: 'even'
        },
        {
          product_id: 'retargeting',
          max_spend_percentage: 60,
          pacing: 'front_loaded'
        }
      ]
    },
    'Proposal accepts seller-optimized percentage constraints without exact allocations'
  );

  await testSchemaRejection(
    '/schemas/core/proposal.json',
    {
      proposal_id: 'prop_fixed_invalid_001',
      name: 'Invalid fixed plan',
      allocations: [
        { product_id: 'display_standard' }
      ]
    },
    'Proposal keeps allocation_percentage required in fixed mode'
  );

  log('');

  log('Build Creative Request Schema (push_notification_config field):', 'info');
  await testSchemaValidation(
    '/schemas/media-buy/build-creative-request.json',
    {
      idempotency_key: 'build-creative-webhook-001',
      target_capability_id: 'outdoor_video_builder',
      message: 'Create a short video ad for a fictional outdoor brand',
      push_notification_config: {
        url: 'https://buyer.example.com/webhooks/adcp',
        operation_id: 'build-creative-webhook-001'
      }
    },
    'Build creative request accepts operation-scoped push_notification_config'
  );

  log('');

  // Test 5: Get Media Buy Delivery Response (allOf with delivery-metrics.json)
  log('Get Media Buy Delivery Response Schema (allOf with delivery-metrics.json):', 'info');
  const deliveryResponseWithBreakdowns = {
    status: 'completed',
    reporting_period: {
      start: '2024-06-01T00:00:00Z',
      end: '2024-06-15T23:59:59Z'
    },
    currency: 'USD',
    media_buy_deliveries: [
      {
        media_buy_id: 'mb_123',
        status: 'active',
        totals: {
          spend: 25000,
          impressions: 1000000,
          effective_rate: 25.0
        },
        by_package: [
          {
            package_id: 'pkg_1',
            spend: 25000,
            impressions: 1000000,
            pacing_index: 1.05,
            pricing_model: 'cpm',
            rate: 25.0,
            currency: 'USD',
            missing_metrics: [
              {
                scope: 'standard',
                metric_id: 'completed_views'
              },
              {
                scope: 'vendor',
                vendor: {
                  domain: 'attentionvendor.example'
                },
                metric_id: 'attention_units'
              }
            ],
            by_catalog_item: [
              {
                content_id: 'sku-123',
                content_id_type: 'sku',
                spend: 1200,
                impressions: 48000
              }
            ],
            by_creative: [
              {
                creative_id: 'cr_123',
                spend: 14000,
                impressions: 560000,
                weight: 56
              }
            ],
            by_keyword: [
              {
                keyword: 'trail running shoes',
                match_type: 'phrase',
                spend: 900,
                impressions: 36000
              }
            ],
            by_geo: [
              {
                geo_level: 'region',
                geo_code: 'US-CA',
                geo_name: 'California',
                spend: 6500,
                impressions: 260000
              }
            ],
            by_geo_truncated: false
          }
        ]
      }
    ]
  };

  await testSchemaValidation(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    deliveryResponseWithBreakdowns,
    'Delivery response with aggregate metrics (allOf composition)'
  );

  const missingVendorMetricResponse = JSON.parse(JSON.stringify(deliveryResponseWithBreakdowns));
  delete missingVendorMetricResponse.media_buy_deliveries[0].by_package[0].missing_metrics[1].vendor;
  await testSchemaRejection(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    missingVendorMetricResponse,
    'Delivery response rejects vendor missing_metric without vendor'
  );

  const missingKeywordMatchTypeResponse = JSON.parse(JSON.stringify(deliveryResponseWithBreakdowns));
  delete missingKeywordMatchTypeResponse.media_buy_deliveries[0].by_package[0].by_keyword[0].match_type;
  await testSchemaRejection(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    missingKeywordMatchTypeResponse,
    'Delivery response rejects keyword metrics without match_type'
  );

  const missingGeoCodeResponse = JSON.parse(JSON.stringify(deliveryResponseWithBreakdowns));
  delete missingGeoCodeResponse.media_buy_deliveries[0].by_package[0].by_geo[0].geo_code;
  await testSchemaRejection(
    '/schemas/media-buy/get-media-buy-delivery-response.json',
    missingGeoCodeResponse,
    'Delivery response rejects geo metrics without geo_code'
  );

  log('');

  // Idempotency capability: discriminated oneOf on supported
  log('Get AdCP Capabilities Response (adcp.idempotency oneOf discriminator):', 'info');

  const capabilitiesBase = {
    status: 'completed',
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    account: {
      supported_billing: ['operator', 'agent'],
      supported_account_currency_modes: ['fixed', 'per_media_buy']
    }
  };

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.1'],
        idempotency: { supported: false }
      },
      account: { supported_billing: ['operator', 'agent'] }
    },
    'AdCP 3.1 capability responses may omit additive currency-mode discovery'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      account: {
        supported_billing: ['operator'],
        supported_account_currency_modes: ['account_default']
      }
    },
    'Account currency modes reject non-standard values'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      account: {
        supported_billing: ['operator'],
        supported_account_currency_modes: ['fixed'],
        timezone: {
          mode: 'account_fixed',
          account_selection: 'buyer_selected',
          supported_timezones: ['America/New_York', 'UTC']
        }
      }
    },
    'Account timezone capability accepts buyer-selected fixed account zones'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      account: {
        supported_billing: ['operator'],
        timezone: { mode: 'seller_fixed', fixed_timezone: 'UTC' }
      }
    },
    'Account timezone capability accepts one seller-fixed zone'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      account: {
        supported_billing: ['operator'],
        timezone: {
          mode: 'account_fixed',
          account_selection: 'seller_assigned'
        }
      }
    },
    'Account timezone capability accepts seller-assigned account zones'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      account: {
        supported_billing: ['operator'],
        timezone: { mode: 'seller_fixed' }
      }
    },
    'Seller-fixed account timezone requires fixed_timezone'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      account: {
        supported_billing: ['operator'],
        timezone: {
          mode: 'account_fixed',
          account_selection: 'buyer_selected'
        }
      }
    },
    'Buyer-selected account timezone requires supported_timezones'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } } },
    'IdempotencySupported: {supported: true, replay_ttl_seconds: 86400}'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } } },
    'IdempotencyUnsupported: {supported: false}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false, replay_ttl_seconds: 3600 } } },
    'Rejects TTL on unsupported branch: {supported: false, replay_ttl_seconds: 3600}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true } } },
    'Rejects missing TTL on supported branch: {supported: true}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: {} } },
    'Rejects empty idempotency block (missing discriminator)'
  );

  // in_flight_max_seconds — optional in 3.1, required when supported: true in 4.0.
  // Schema accepts the bound when present; cross-field bound (≤ replay_ttl_seconds)
  // is enforced below the schema layer (see custom assertion).
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400, in_flight_max_seconds: 60 } } },
    'IdempotencySupported with in_flight_max_seconds: {supported: true, replay_ttl_seconds: 86400, in_flight_max_seconds: 60}'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400, in_flight_max_seconds: 0 } } },
    'Rejects in_flight_max_seconds: 0 (below minimum 1)'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false, in_flight_max_seconds: 60 } } },
    'Rejects in_flight_max_seconds on unsupported branch: {supported: false, in_flight_max_seconds: 60}'
  );

  // Cross-field invariant: in_flight_max_seconds MUST NOT exceed replay_ttl_seconds.
  // JSON Schema cannot express field-relative bounds; the constraint is enforced
  // by a custom assertion alongside the schema check.
  const violatingCaps = { ...capabilitiesBase, adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 3600, in_flight_max_seconds: 7200 } } };
  // Schema layer accepts the shape (both bounds individually valid)
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    violatingCaps,
    'Schema accepts in_flight_max_seconds > replay_ttl_seconds at the schema layer (cross-field bound enforced below)'
  );
  // Cross-field invariant: programmatic check that the cross-field bound is violated.
  totalTests++;
  const idem = violatingCaps.adcp.idempotency;
  if (idem.in_flight_max_seconds > idem.replay_ttl_seconds) {
    log(`  ✓ Cross-field assertion: in_flight_max_seconds (${idem.in_flight_max_seconds}) > replay_ttl_seconds (${idem.replay_ttl_seconds}) detected — sellers MUST NOT emit this shape`, 'success');
    passedTests++;
  } else {
    log(`  ✗ Cross-field assertion: failed to detect in_flight_max_seconds > replay_ttl_seconds`, 'error');
    failedTests++;
  }

  log('');

  log('Get AdCP Capabilities Response (webhook delivery retry horizon):', 'info');

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      webhook_signing: {
        supported: true,
        delivery_retry_horizon_seconds: 86400
      }
    },
    'Webhook signing accepts the 24h delivery retry horizon floor'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      webhook_signing: { supported: true }
    },
    'Existing 3.x webhook signing remains schema-valid without the additive retry horizon'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      webhook_signing: { supported: false }
    },
    'Webhook signing supported=false does not require a retry horizon'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      webhook_signing: {
        supported: true,
        delivery_retry_horizon_seconds: 86399
      }
    },
    'Webhook delivery retry horizon rejects values below 24h'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: false } },
      webhook_signing: {
        supported: true,
        delivery_retry_horizon_seconds: 604801
      }
    },
    'Webhook delivery retry horizon rejects values above 7d'
  );

  log('');

  log('Get AdCP Capabilities Response (adcp.capability_changes.notifications oneOf discriminator):', 'info');

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: {
          capabilities_version: 'rev_20260702_091455',
          last_modified: '2026-07-02T09:14:55Z',
          cache_ttl_seconds: 3600,
          notifications: {
            supported: true,
            registration_task: 'sync_agent_notification_configs',
            event_types: ['capabilities.changed']
          }
        }
      }
    },
    'CapabilityChangeNotificationsSupported accepts registration task and event type'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: {
          notifications: { supported: false }
        }
      }
    },
    'CapabilityChangeNotificationsUnsupported accepts supported: false'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: {
          capabilities_version: 'rev_20260702_091455',
          cache_ttl_seconds: 3600,
          notifications: {
            supported: true,
            event_types: ['capabilities.changed']
          }
        }
      }
    },
    'Rejects capability-change notifications supported branch without registration_task'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: {
          capabilities_version: 'rev_20260702_091455',
          notifications: {
            supported: true,
            registration_task: 'sync_agent_notification_configs',
            event_types: ['capabilities.changed']
          }
        }
      }
    },
    'Rejects capability-change notifications supported branch without cache_ttl_seconds'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: {
          cache_ttl_seconds: 3600,
          notifications: {
            supported: true,
            registration_task: 'sync_agent_notification_configs',
            event_types: ['capabilities.changed']
          }
        }
      }
    },
    'Rejects capability-change notifications supported branch without capabilities_version'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: {
          last_modified: '2026-07-02T09:14:55Z',
          cache_ttl_seconds: 3600,
          notifications: {
            supported: true,
            registration_task: 'sync_agent_notification_configs',
            event_types: ['capabilities.changed']
          }
        }
      }
    },
    'Rejects capability-change notifications supported branch with last_modified but no capabilities_version'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        capability_changes: {
          notifications: {
            supported: false,
            event_types: ['capabilities.changed']
          }
        }
      }
    },
    'Rejects event_types on capability-change notifications unsupported branch'
  );

  log('');

  log('Get AdCP Capabilities Response (account.notifications oneOf discriminator):', 'info');

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      account: {
        supported_billing: ['operator', 'agent'],
        supported_account_currency_modes: ['fixed', 'per_media_buy'],
        notifications: {
          supported: true,
          registration_task: 'sync_accounts',
          read_task: 'list_accounts',
          event_types: ['account.status_changed'],
          supports_webhook_activity: true
        }
      }
    },
    'AccountNotificationsSupported accepts registration task, read task, and account status event type'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      account: {
        supported_billing: ['operator', 'agent'],
        supported_account_currency_modes: ['fixed', 'per_media_buy'],
        notifications: { supported: false }
      }
    },
    'AccountNotificationsUnsupported accepts supported: false'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      account: {
        supported_billing: ['operator', 'agent'],
        supported_account_currency_modes: ['fixed', 'per_media_buy'],
        notifications: {
          supported: true,
          registration_task: 'sync_accounts',
          event_types: ['account.status_changed']
        }
      }
    },
    'Rejects account notifications supported branch without read_task'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      account: {
        supported_billing: ['operator', 'agent'],
        supported_account_currency_modes: ['fixed', 'per_media_buy'],
        notifications: {
          supported: false,
          event_types: ['account.status_changed']
        }
      }
    },
    'Rejects event_types on account notifications unsupported branch'
  );

  totalTests++;
  try {
    const capabilitiesSchema = JSON.parse(
      fs.readFileSync(
        path.join(SCHEMA_BASE_DIR, 'protocol/get-adcp-capabilities-response.json'),
        'utf8'
      )
    );
    const webhookSigningConstraints =
      capabilitiesSchema.properties.webhook_signing.properties.supported['x-adcp-validation']
        .verifier_constraints.must_equal_when.any_of;
    const gatedFields = new Set(webhookSigningConstraints.map((constraint) => constraint.field));
    const expectedGates = [
      'adcp.capability_changes.notifications.supported',
      'account.notifications.supported'
    ];
    const missingGates = expectedGates.filter((field) => !gatedFields.has(field));

    if (missingGates.length === 0) {
      log('  ✓ webhook_signing gate covers agent and account notification capabilities', 'success');
      passedTests++;
    } else {
      log(`  ✗ webhook_signing gate missing notification capabilities: ${missingGates.join(', ')}`, 'error');
      failedTests++;
    }
  } catch (error) {
    log(`  ✗ webhook_signing gate covers agent and account notification capabilities: ${error.message}`, 'error');
    failedTests++;
  }

  log('');

  log('Account and agent notification payloads:', 'info');

  await testSchemaValidation(
    '/schemas/core/capabilities-changed-webhook.json',
    {
      idempotency_key: 'whk_01J1T3K6YZR7V5P9Q2M4N6B8CD',
      notification_id: 'capchg_20260702_0001',
      notification_type: 'capabilities.changed',
      fired_at: '2026-07-02T09:15:30Z',
      subscriber_id: 'registry-cache',
      agent_url: 'https://seller.example/adcp',
      changed_at: '2026-07-02T09:14:55Z',
      reason: 'capability_enabled',
      capabilities_version: 'rev_20260702_091455',
      changed_paths: ['/account/sandbox']
    },
    'capabilities-changed-webhook requires and accepts post-change capabilities_version'
  );

  await testSchemaRejection(
    '/schemas/core/capabilities-changed-webhook.json',
    {
      idempotency_key: 'whk_01J1T3K6YZR7V5P9Q2M4N6B8CD',
      notification_id: 'capchg_20260702_0001',
      notification_type: 'capabilities.changed',
      fired_at: '2026-07-02T09:15:30Z',
      subscriber_id: 'registry-cache',
      agent_url: 'https://seller.example/adcp',
      changed_at: '2026-07-02T09:14:55Z',
      reason: 'capability_enabled'
    },
    'capabilities-changed-webhook rejects missing capabilities_version'
  );

  await testSchemaValidation(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'acct-status-subscribe-0001',
      accounts: [
        {
          account: { account_id: 'acc_glow_pending' },
          notification_configs: [
            {
              subscriber_id: 'account-lifecycle',
              url: 'https://buyer.example/webhooks/adcp/accounts',
              event_types: ['account.status_changed'],
              active: true
            }
          ]
        }
      ]
    },
    'sync_accounts accepts account.status_changed in account-level notification_configs[]'
  );

  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'acct-status-subscribe-0002',
      accounts: [
        {
          account: { account_id: 'acc_glow_pending' },
          notification_configs: [
            {
              subscriber_id: 'registry-cache',
              url: 'https://buyer.example/webhooks/adcp/capabilities',
              event_types: ['capabilities.changed']
            }
          ]
        }
      ]
    },
    'sync_accounts rejects agent-level capabilities.changed in account-level notification_configs[]'
  );

  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'acct-status-subscribe-0003',
      accounts: [
        {
          account: { account_id: 'acc_glow_pending' },
          notification_configs: [
            {
              subscriber_id: 'delivery-report',
              url: 'https://buyer.example/webhooks/adcp/media-buy',
              event_types: ['scheduled']
            }
          ]
        }
      ]
    },
    'sync_accounts rejects media-buy scheduled in account-level notification_configs[]'
  );

  await testSchemaValidation(
    '/schemas/core/account-status-changed-webhook.json',
    {
      idempotency_key: 'whk_01K18GM0Z7J3Q6WBH7DYK2R4VM',
      notification_id: 'acctchg_acc_glow_20260719T100712Z',
      notification_type: 'account.status_changed',
      fired_at: '2026-07-19T10:07:15Z',
      subscriber_id: 'account-lifecycle',
      account_id: 'acc_glow_pending',
      previous_status: 'pending_approval',
      status: 'payment_required',
      observed_at: '2026-07-19T10:07:12Z',
      reason_code: 'setup_required',
      setup: {
        message: 'Complete advertiser billing setup.',
        expires_at: '2026-07-30T00:00:00Z'
      }
    },
    'account-status-changed-webhook accepts reduced setup hint without setup.url'
  );

  await testSchemaRejection(
    '/schemas/core/account-status-changed-webhook.json',
    {
      idempotency_key: 'whk_01K18GM0Z7J3Q6WBH7DYK2R4VM',
      notification_id: 'acctchg_acc_glow_20260719T100712Z',
      notification_type: 'account.status_changed',
      fired_at: '2026-07-19T10:07:15Z',
      subscriber_id: 'account-lifecycle',
      account_id: 'acc_glow_pending',
      previous_status: 'pending_approval',
      status: 'payment_required',
      observed_at: '2026-07-19T10:07:12Z',
      reason_code: 'setup_required',
      setup: {
        url: 'https://seller.example/onboard?token=secret',
        message: 'Complete advertiser billing setup.'
      }
    },
    'account-status-changed-webhook rejects setup.url fan-out'
  );

  await testSchemaRejection(
    '/schemas/core/agent-notification-config.json',
    {
      subscriber_id: 'account-lifecycle',
      url: 'https://buyer.example/webhooks/adcp/accounts',
      event_types: ['account.status_changed']
    },
    'agent-level notification config rejects account.status_changed'
  );

  await testSchemaValidation(
    '/schemas/account/list-accounts-response.json',
    {
      status: 'completed',
      accounts: [
        {
          account_id: 'acc_glow_pending',
          name: 'Glow',
          status: 'payment_required',
          webhook_activity: [
            {
              idempotency_key: 'whk_01K18GM0Z7J3Q6WBH7DYK2R4VM',
              notification_id: 'acctchg_acc_glow_20260719T100712Z',
              subscriber_id: 'account-lifecycle',
              fired_at: '2026-07-19T10:07:15Z',
              completed_at: '2026-07-19T10:07:15Z',
              notification_type: 'account.status_changed',
              attempt: 1,
              status: 'success',
              url: 'https://buyer.example/webhooks/adcp/accounts',
              http_status_code: 200,
              response_time_ms: 142,
              payload_size_bytes: 512,
              error_message: null
            }
          ]
        }
      ]
    },
    'list_accounts response accepts account-scoped webhook_activity for account.status_changed'
  );

  await testSchemaValidation(
    '/schemas/core/webhook-activity-record.json',
    {
      idempotency_key: 'whk_01K18GM0Z7J3Q6WBH7DYK2R4VM',
      fired_at: '2026-07-19T10:07:15Z',
      notification_type: 'account.status_changed',
      attempt: 1,
      status: 'success',
      url: 'https://buyer.example/webhooks/adcp/accounts'
    },
    'retained pre-3.2 state activity remains valid without notification_id'
  );

  await testSchemaValidation(
    '/schemas/core/webhook-activity-record.json',
    {
      idempotency_key: 'whk_01K18GM0Z7J3Q6WBH7DYK2R4VN',
      fired_at: '2026-07-19T11:00:00Z',
      notification_type: 'window_update',
      sequence_number: 42,
      attempt: 1,
      status: 'success',
      url: 'https://buyer.example/webhooks/adcp/delivery'
    },
    'window_update delivery activity is represented without notification_id'
  );

  totalTests++;
  try {
    const notificationTypeSchema = JSON.parse(
      fs.readFileSync(path.join(SCHEMA_BASE_DIR, 'enums/notification-type.json'), 'utf8')
    );
    const values = [...notificationTypeSchema.enum].sort();
    const describedValues = Object.keys(notificationTypeSchema.enumDescriptions || {}).sort();
    const complete =
      JSON.stringify(values) === JSON.stringify(describedValues) &&
      values.includes('window_update');
    if (complete) {
      log('  ✓ Every notification type has exactly one registry description, including window_update', 'success');
      passedTests++;
    } else {
      log(`  ✗ Notification registry drift: enum=${JSON.stringify(values)} descriptions=${JSON.stringify(describedValues)}`, 'error');
      failedTests++;
    }
  } catch (error) {
    log(`  ✗ Notification registry exhaustiveness check failed: ${error.message}`, 'error');
    failedTests++;
  }

  totalTests++;
  try {
    const listSchema = JSON.parse(
      fs.readFileSync(path.join(SCHEMA_BASE_DIR, 'creative/list-creatives-response.json'), 'utf8')
    );
    const listExample = listSchema.examples.find((example) =>
      example.description.includes('webhook_activity')
    ).data;
    const activitiesByType = new Map(
      listExample.creatives.flatMap((creative) => creative.webhook_activity || [])
        .map((activity) => [activity.notification_type, activity])
    );
    const webhookSchemas = [
      'creative/creative-status-changed-webhook.json',
      'creative/creative-purged-webhook.json'
    ];
    const mismatches = webhookSchemas.flatMap((relativePath) => {
      const webhookSchema = JSON.parse(
        fs.readFileSync(path.join(SCHEMA_BASE_DIR, relativePath), 'utf8')
      );
      const payload = webhookSchema.examples[0].data;
      const activity = activitiesByType.get(payload.notification_type);
      return activity &&
        activity.idempotency_key === payload.idempotency_key &&
        activity.notification_id === payload.notification_id
        ? []
        : [payload.notification_type];
    });
    if (mismatches.length === 0) {
      log('  ✓ Creative webhook and activity examples reuse idempotency_key and notification_id', 'success');
      passedTests++;
    } else {
      log(`  ✗ Activity identity differs from webhook examples for: ${mismatches.join(', ')}`, 'error');
      failedTests++;
    }
  } catch (error) {
    log(`  ✗ Webhook/activity identity correlation check failed: ${error.message}`, 'error');
    failedTests++;
  }

  log('');

  // oauth — explicit capability gate for the universal OAuth metadata graph
  // storyboard (adcp#4293). The block is optional, but when present it must
  // carry the supported discriminator.
  log('Get AdCP Capabilities Response (oauth capability gate):', 'info');

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      oauth: { supported: true },
    },
    'Accepts an explicit oauth.supported capability claim'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      oauth: { supported: false },
    },
    'Accepts an explicit unsupported OAuth capability declaration'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      oauth: {},
    },
    'Rejects an OAuth capability block without the supported discriminator'
  );

  log('');

  // request_signing.protocol_methods_* — JSON-RPC method namespace (adcp#4318).
  // The `protocol_methods_supported_for` / `_warn_for` / `_required_for` arrays
  // carry JSON-RPC method strings (e.g. `tasks/cancel`); plain AdCP tool names
  // (no `/`) are wire-distinct and belong in `supported_for` / `required_for`.
  // The schema enforces the namespace split via a `pattern: "/"` constraint on
  // the items.
  log('Get AdCP Capabilities Response (request_signing.protocol_methods_*):', 'info');

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: ['create_media_buy'],
        supported_for: ['create_media_buy', 'update_media_buy'],
        protocol_methods_supported_for: ['tasks/cancel', 'tasks/get'],
        protocol_methods_required_for: ['tasks/cancel'],
      },
    },
    'Accepts protocol_methods_* with JSON-RPC method strings (`tasks/cancel`, `tasks/get`)'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.1', '3.2'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      request_signing: {
        supported: true,
        covers_content_digest: 'required',
        required_for: [],
        supported_for: ['create_media_buy'],
      },
    },
    'Accepts the required body-integrity posture for a 3.2 signing profile'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.1', '3.2'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        supported_for: ['create_media_buy'],
      },
    },
    'Rejects the legacy either posture when the agent advertises 3.2 signing'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.2-beta.1'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      request_signing: {
        supported: true,
        required_for: [],
        supported_for: ['create_media_buy'],
      },
    },
    'Requires an explicit body-integrity posture when the agent advertises a 3.2 prerelease'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp_version: '3.2',
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.0', '3.1'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        supported_for: ['create_media_buy'],
      },
    },
    'Uses the served 3.2 response version even when supported_versions only lists legacy releases'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp_version: '3.2',
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        supported_for: ['create_media_buy'],
      },
    },
    'Uses the served 3.2 response version when supported_versions is omitted'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp_version: '03.2',
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.0', '3.1'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
    },
    'Rejects non-canonical release versions with a leading zero'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.02'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
    },
    'Rejects non-canonical supported_versions entries with a leading zero'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.0', '3.1'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        supported_for: ['create_media_buy'],
      },
    },
    'Preserves the legacy either posture for agents capped at AdCP 3.1'
  );

  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp_version: '3.1',
      adcp: {
        ...capabilitiesBase.adcp,
        supported_versions: ['3.0', '3.1'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      request_signing: {
        supported: true,
        required_for: [],
        supported_for: ['create_media_buy'],
      },
    },
    'Preserves legacy 3.1 omission of covers_content_digest without a 3.2 default'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        protocol_methods_supported_for: ['create_media_buy'],
      },
    },
    'Rejects AdCP tool name (no `/`) in protocol_methods_supported_for'
  );

  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: { ...capabilitiesBase.adcp, idempotency: { supported: true, replay_ttl_seconds: 86400 } },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: [],
        protocol_methods_required_for: ['update_media_buy'],
      },
    },
    'Rejects AdCP tool name (no `/`) in protocol_methods_required_for'
  );

  log('');

  // Test 6: Envelope `replayed` field on mutating response roots (#2839)
  // The seller's idempotency layer injects `replayed` into the response envelope at
  // replay time. Every mutating response root must accept it — either by declaring
  // the property or by keeping `additionalProperties` open at the root.
  log('Envelope `replayed` acceptance on mutating response roots (#2839):', 'info');

  const propertyListBody = {
    list_id: 'pl_01HW7J8K9P0Q1R2S3T4U5V6W7X',
    name: 'Spring 2026 brand-safe inventory'
  };
  const collectionListBody = {
    list_id: 'cl_01HW7J8K9P0Q1R2S3T4U5V6W7X',
    name: 'Premium CTV series'
  };

  await testSchemaValidation(
    '/schemas/property/create-property-list-response.json',
    {
      list: propertyListBody,
      auth_token: 'secret_token_at_least_32_chars_long__________',
      replayed: true,
      status: 'completed'
    },
    'create_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/property/update-property-list-response.json',
    { list: propertyListBody, replayed: false, status: 'completed' },
    'update_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/property/delete-property-list-response.json',
    { deleted: true, list_id: 'pl_01HW7J8K9P0Q1R2S3T4U5V6W7X', replayed: true, status: 'completed' },
    'delete_property_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/create-collection-list-response.json',
    {
      list: collectionListBody,
      auth_token: 'secret_token_at_least_32_chars_long__________',
      replayed: true,
      status: 'completed'
    },
    'create_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/update-collection-list-response.json',
    { list: collectionListBody, replayed: false, status: 'completed' },
    'update_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/collection/delete-collection-list-response.json',
    { deleted: true, list_id: 'cl_01HW7J8K9P0Q1R2S3T4U5V6W7X', replayed: true, status: 'completed' },
    'delete_collection_list accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/governance/report-plan-outcome-response.json',
    { outcome_id: 'outcome_abc123', outcome_state: 'accepted', replayed: true },
    'report_plan_outcome accepts replayed on envelope'
  );

  await testSchemaValidation(
    '/schemas/governance/sync-plans-response.json',
    {
      plans: [{ plan_id: 'plan_abc123', status: 'active', version: 1 }],
      replayed: false,
      status: 'completed'
    },
    'sync_plans accepts replayed on envelope'
  );

  // Negative test: explicit `replayed` declaration must type-check. An AJV
  // schema with `additionalProperties: true` alone would accept `replayed:
  // "true"` as a string; the explicit property block is what enforces the
  // boolean contract.
  await testSchemaRejection(
    '/schemas/governance/sync-plans-response.json',
    {
      plans: [{ plan_id: 'plan_abc123', status: 'active', version: 1 }],
      replayed: 'true'
    },
    'sync_plans rejects replayed as string (type enforced)'
  );

  // Structural lint: no task-family response schema may seal the envelope with
  // `additionalProperties: false` anywhere on the root or in a composition
  // branch (oneOf/anyOf/allOf) unless `replayed` is declared on that seal. This
  // catches the #2839 class of bug at author time. Skips `core/` (field
  // sub-schemas that ship with `*-response.json` filenames but are not task
  // response envelopes).
  totalTests++;
  const offenders = [];
  const inspectEnvelope = (schema, where) => {
    const localOffenders = [];
    const sealed = schema.additionalProperties === false;
    const declaresReplayed = !!(schema.properties && schema.properties.replayed);
    if (sealed && !declaresReplayed) localOffenders.push(where);
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      if (Array.isArray(schema[key])) {
        schema[key].forEach((branch, i) => {
          if (branch && typeof branch === 'object') {
            localOffenders.push(...inspectEnvelope(branch, `${where}.${key}[${i}]`));
          }
        });
      }
    }
    return localOffenders;
  };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('-response.json')) {
        const rel = path.relative(SCHEMA_BASE_DIR, p);
        if (rel.startsWith('core/') || rel.startsWith('core' + path.sep)) continue;
        const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
        const issues = inspectEnvelope(schema, 'root');
        for (const issue of issues) offenders.push(`${rel} (${issue})`);
      }
    }
  };
  walk(SCHEMA_BASE_DIR);
  if (offenders.length === 0) {
    log(`  \u2713 All *-response.json schemas accept envelope-level passthrough (#2839 lint)`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${offenders.length} response schema(s) seal the envelope with additionalProperties: false:`, 'error');
    for (const f of offenders) log(`      ${f}`, 'error');
    log(`    Either flip additionalProperties to true, or declare envelope fields (replayed, context, ext).`, 'error');
    failedTests++;
  }

  // Drift guard: every inlined `replayed` description must match the canonical
  // definition in core/protocol-envelope.json so that a clarification there
  // propagates or is deliberately diverged. Catches silent drift across the 8
  // mutating response schemas.
  totalTests++;
  const envelopeSchemaPath = path.join(SCHEMA_BASE_DIR, 'core/protocol-envelope.json');
  const canonicalReplayed = JSON.parse(fs.readFileSync(envelopeSchemaPath, 'utf8'))
    .properties.replayed.description;
  const driftOffenders = [];
  const walkDrift = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDrift(p);
      else if (entry.name.endsWith('-response.json')) {
        const rel = path.relative(SCHEMA_BASE_DIR, p);
        if (rel.startsWith('core/') || rel.startsWith('core' + path.sep)) continue;
        const schema = JSON.parse(fs.readFileSync(p, 'utf8'));
        const r = schema.properties && schema.properties.replayed;
        if (r && r.description && r.description !== canonicalReplayed) {
          driftOffenders.push(rel);
        }
      }
    }
  };
  walkDrift(SCHEMA_BASE_DIR);
  if (driftOffenders.length === 0) {
    log(`  \u2713 Inlined replayed descriptions match core/protocol-envelope.json (drift guard)`, 'success');
    passedTests++;
  } else {
    log(`  \u2717 ${driftOffenders.length} inlined replayed description(s) diverge from core/protocol-envelope.json:`, 'error');
    for (const f of driftOffenders) log(`      ${f}`, 'error');
    failedTests++;
  }

  log('');

  log('Task listing accepts creative-domain build_creative tasks:', 'info');
  const creativeBuildTaskList = {
    status: 'completed',
    query_summary: {
      total_matching: 1,
      returned: 1,
      domain_breakdown: {
        creative: 1
      }
    },
    tasks: [
      {
        task_id: 'task_build_creative_001',
        task_type: 'build_creative',
        domain: 'creative',
        status: 'submitted',
        created_at: '2026-06-07T19:00:00Z',
        updated_at: '2026-06-07T19:01:00Z',
        has_webhook: true
      }
    ],
    pagination: {
      has_more: false
    }
  };

  await testSchemaValidation(
    '/schemas/core/tasks-list-response.json',
    creativeBuildTaskList,
    'Legacy tasks/list response accepts build_creative task with creative domain'
  );
  await testSchemaValidation(
    '/schemas/protocol/list-tasks-response.json',
    creativeBuildTaskList,
    'Protocol list_tasks response accepts build_creative task with creative domain'
  );
  await testSchemaRejection(
    '/schemas/core/tasks-list-response.json',
    {
      ...creativeBuildTaskList,
      query_summary: {
        ...creativeBuildTaskList.query_summary,
        domain_breakdown: {
          creative: -1
        }
      }
    },
    'Legacy tasks/list response rejects negative creative domain breakdown'
  );
  await testSchemaRejection(
    '/schemas/protocol/list-tasks-response.json',
    {
      ...creativeBuildTaskList,
      query_summary: {
        ...creativeBuildTaskList.query_summary,
        domain_breakdown: {
          creative: -1
        }
      }
    },
    'Protocol list_tasks response rejects negative creative domain breakdown'
  );

  log('');

  log('SignalRef scope hygiene:', 'info');
  await testSchemaValidation(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers' },
    'SignalRef product scope accepts product-local signal_id'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers', data_provider_domain: 'pinnacle-data.example' },
    'SignalRef product scope rejects data_provider_domain carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers', signal_source_url: 'https://signals.example/.well-known/adcp/signals' },
    'SignalRef product scope rejects signal_source_url carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'product', signal_id: 'high_intent_shoppers', source: 'agent' },
    'SignalRef product scope rejects SignalId source carry-over'
  );
  await testSchemaValidation(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders' },
    'SignalRef data_provider scope accepts provider-published signal'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders', agent_url: 'https://signals.example' },
    'SignalRef data_provider scope rejects agent_url carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders', signal_source_url: 'https://signals.example/.well-known/adcp/signals' },
    'SignalRef data_provider scope rejects signal_source_url carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders', id: 'legacy_id' },
    'SignalRef data_provider scope rejects SignalId id carry-over'
  );
  await testSchemaValidation(
    '/schemas/core/signal-ref.json',
    { scope: 'signal_source', signal_source_url: 'https://signals.example/.well-known/adcp/signals', signal_id: 'custom_model_run_123' },
    'SignalRef signal_source scope accepts source-native signal'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'signal_source', signal_source_url: 'https://signals.example/.well-known/adcp/signals', signal_id: 'custom_model_run_123', data_provider_domain: 'pinnacle-data.example' },
    'SignalRef signal_source scope rejects data_provider_domain carry-over'
  );
  await testSchemaRejection(
    '/schemas/core/signal-ref.json',
    { scope: 'signal_source', signal_source_url: 'https://signals.example/.well-known/adcp/signals', signal_id: 'custom_model_run_123', source: 'agent' },
    'SignalRef signal_source scope rejects SignalId source carry-over'
  );
  log('');

  log('product signal targeting invariants:', 'info');
  const productBase = {
    product_id: 'signal_targeting_product',
    name: 'Signal Targeting Product',
    description: 'Test',
    publisher_properties: [
      { publisher_domain: 'example.com', selection_type: 'all' }
    ],
    format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
    delivery_type: 'guaranteed',
    delivery_measurement: { provider: 'Test' },
    pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 240,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions'],
      date_range_support: 'date_range'
    }
  };
  const canonicalProductBase = structuredClone(productBase);
  delete canonicalProductBase.format_ids;
  delete canonicalProductBase.delivery_measurement;
  canonicalProductBase.pricing_options = [{ pricing_option_id: 'cpm', pricing_model: 'cpm', fixed_price: 10, currency: 'USD' }];
  canonicalProductBase.format_options = [{
    format_kind: 'image',
    params: { width: 300, height: 250 }
  }];
  const productSignalOption = {
    signal_ref: { scope: 'product', signal_id: 'high_intent_shoppers' },
    name: 'High intent shoppers',
    value_type: 'binary'
  };
  const dataProviderSignalRefOnly = {
    signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'auto_intenders' }
  };
  const legacySignalId = {
    source: 'catalog',
    data_provider_domain: 'pinnacle-data.example',
    id: 'auto_intenders'
  };
  const signalListingCore = {
    signal_agent_segment_id: 'sig_auto_intenders',
    name: 'Auto intenders',
    description: 'People likely to be in market for a vehicle.',
    signal_type: 'marketplace',
    coverage_percentage: 12,
    deployments: [
      { type: 'platform', platform: 'example_dsp', is_live: true }
    ]
  };
  const signalListingCoreWithoutLegacyCoverage = { ...signalListingCore };
  delete signalListingCoreWithoutLegacyCoverage.coverage_percentage;
  const signalCoverageForecast = {
    method: 'estimate',
    forecast_range_unit: 'availability',
    scope: {
      kind: 'inventory',
      label: 'network price-priority inventory'
    },
    bucket_semantics: 'exclusive',
    bucket_completeness: 'partial',
    points: [
      {
        label: 'auto intent present',
        dimensions: [
          {
            kind: 'signal',
            signal_ref: {
              scope: 'data_provider',
              data_provider_domain: 'pinnacle-data.example',
              signal_id: 'auto_intenders'
            },
            presence: 'present'
          }
        ],
        metrics: {
          impressions: { mid: 120000 },
          coverage_rate: { mid: 0.12 }
        }
      }
    ]
  };

  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [productSignalOption],
      signal_targeting_rules: { resolution_model: 'seller_planned', selection_mode: 'optional' }
    },
    'Product accepts signal_targeting_options and seller-planned resolution when signal_targeting_allowed is true'
  );
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      included_signals: [dataProviderSignalRefOnly]
    },
    'Product accepts included_signals as non-targetable data-provider refs without redefining signal metadata'
  );
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [dataProviderSignalRefOnly]
    },
    'Product accepts data-provider signal_targeting_options without redefining name or value_type'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      included_signals: [{ signal_ref: { scope: 'product', signal_id: 'seller_defined_signal' } }]
    },
    'Product rejects product-local included_signals without inline name and value_type'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [{ signal_ref: { scope: 'product', signal_id: 'seller_defined_signal' } }]
    },
    'Product rejects product-local signal_targeting_options without inline name and value_type'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [{ signal_id: legacySignalId }]
    },
    'Product signal_targeting_options require canonical signal_ref even though shared listings accept legacy signal_id'
  );
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_rules: { resolution_model: 'direct_targeting', selection_mode: 'optional' }
    },
    'Product accepts signal_targeting_rules without inline options when signal targeting is allowed'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: true,
      signal_targeting_options: [productSignalOption],
      signal_targeting_rules: { resolution_model: 'buyer_planned', selection_mode: 'optional' }
    },
    'Product rejects invalid signal_targeting_rules resolution_model'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_options: [productSignalOption]
    },
    'Product rejects signal_targeting_options without signal_targeting_allowed: true'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: false,
      signal_targeting_options: [productSignalOption]
    },
    'Product rejects signal_targeting_options with signal_targeting_allowed: false'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_rules: { selection_mode: 'optional' }
    },
    'Product rejects signal_targeting_rules without signal_targeting_allowed: true'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      ...productBase,
      signal_targeting_allowed: false,
      signal_targeting_rules: { selection_mode: 'optional' }
    },
    'Product rejects signal_targeting_rules with signal_targeting_allowed: false'
  );
  log('');

  log('SignalCoverageForecast schema (top-level additionalProperties enforcement):', 'info');
  await testSchemaValidation(
    '/schemas/core/signal-coverage-forecast.json',
    signalCoverageForecast,
    'SignalCoverageForecast accepts valid forecast with presence: present and omitted signal_value'
  );
  await testSchemaValidation(
    '/schemas/core/signal-coverage-forecast.json',
    {
      ...signalCoverageForecast,
      scope: {
        kind: 'inventory',
        label: 'network price-priority inventory',
        inventory_class: 'price_priority'
      }
    },
    'SignalCoverageForecast scope accepts seller-specific extra qualifier (inventory_class)'
  );
  await testSchemaRejection(
    '/schemas/core/signal-coverage-forecast.json',
    {
      ...signalCoverageForecast,
      bucket_completness: 'partial'
    },
    'SignalCoverageForecast rejects unknown top-level field (bucket_completness typo)'
  );
  log('');

  log('AdCP 3.2 split product-discovery request contracts:', 'info');
  await testSchemaValidation(
    '/schemas/media-buy/get-products-request.json',
    { buying_mode: 'wholesale' },
    'Legacy get_products remains valid without an idempotency key throughout 3.x'
  );
  await testSchemaValidation(
    '/schemas/media-buy/list-products-request.json',
    { fields: ['product_id', 'pricing_options'] },
    'list_products is a key-optional synchronous read'
  );
  await testSchemaRejection(
    '/schemas/media-buy/list-products-request.json',
    { fields: ['product_id', 'format_ids'] },
    'list_products does not expose the legacy named-format field selector'
  );
  await testSchemaValidation(
    '/schemas/media-buy/list-products-request.json',
    {
      push_notification_config: {
        url: 'https://buyer.example.com/adcp-events'
      }
    },
    'list_products tolerates uniform callback envelope configuration even though the read is synchronous'
  );
  await testSchemaRejection(
    '/schemas/media-buy/list-products-request.json',
    { criteria: { catalog: { catalog_id: 'catalog-1', type: 'product' } } },
    'list_products requires brand when catalog is present'
  );
  await testSchemaValidation(
    '/schemas/media-buy/request-proposals-request.json',
    {
      idempotency_key: 'request-proposals-0001',
      brand: { domain: 'acmeoutdoor.example' },
      brief: 'Reach streaming audio listeners in Rome'
    },
    'request_proposals requires a brief and accepts a replay key'
  );
  await testSchemaValidation(
    '/schemas/media-buy/request-proposals-request.json',
    {
      idempotency_key: 'request-proposals-natural-account-0001',
      account: {
        brand: { domain: 'acmeoutdoor.example', countries: ['NL'] },
        operator: 'buyer.example',
        operator_unit: { id: '234284238', name: 'Acme EMEA' },
        currency: 'EUR',
        timezone: 'Europe/Amsterdam',
        sandbox: true
      },
      brief: 'Reach streaming audio listeners in Rome'
    },
    'request_proposals accepts country, operator-unit, currency, and timezone qualifiers in its natural account key'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-request.json',
    {
      idempotency_key: 'request-proposals-invalid-account-key-0001',
      account: {
        brand: { domain: 'acmeoutdoor.example', countries: ['nl'] },
        operator: 'buyer.example',
        operator_unit: { id: '234284238', name: 'Acme EMEA' },
        currency: 'eur'
      },
      brief: 'Reach streaming audio listeners in Rome'
    },
    'request_proposals rejects non-canonical country and currency identifiers'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-operator-unit-0001',
      accounts: [{
        brand: { domain: 'nova-athletics.example', countries: ['NL'] },
        operator: 'nova-athletics.example',
        operator_unit: { id: '234284238', name: 'Nova EMEA' },
        currency: 'EUR',
        timezone: 'Europe/Amsterdam',
        billing: 'operator'
      }]
    },
    'sync_accounts provisions currency and timezone qualifiers in the natural key'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-timezone-update-0001',
      accounts: [{
        account: { account_id: 'seller-account-123' },
        timezone: 'Europe/Amsterdam'
      }]
    },
    'sync_accounts rejects immutable timezone changes in settings-update mode'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-identity-update-0001',
      accounts: [{
        account: { account_id: 'seller-account-123' },
        revision: 7,
        operator_identity: {
          operator: 'pinnacle-media.example',
          operator_unit: { id: 'east-coast', name: 'East Coast' }
        }
      }]
    },
    'sync_accounts settings-update mode accepts a revisioned complete desired operator identity'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-remove-unit-0001',
      accounts: [{
        account: {
          brand: { domain: 'nova-athletics.example' },
          operator: 'pinnacle-media.example',
          operator_unit: { id: 'legacy-seat' }
        },
        revision: 7,
        operator_identity: { operator: 'pinnacle-media.example' }
      }]
    },
    'sync_accounts expresses operator-unit removal by omitting the unit from the complete desired identity'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-confused-rekey-0001',
      accounts: [{
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        billing: 'operator',
        operator_identity: { operator: 'new-operator.example' }
      }]
    },
    'sync_accounts rejects identity replacement fields in provisioning mode'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-stale-revision-0001',
      accounts: [{
        account: { account_id: 'seller-account-123' },
        revision: 0,
        operator_identity: { operator: 'pinnacle-media.example' }
      }]
    },
    'sync_accounts rejects invalid account revisions'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-identity-without-revision-0001',
      accounts: [{
        account: { account_id: 'seller-account-123' },
        operator_identity: { operator: 'pinnacle-media.example' }
      }]
    },
    'sync_accounts requires revision for operator identity changes'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-settings-revision-0001',
      accounts: [{
        account: { account_id: 'seller-account-123' },
        revision: 8,
        payment_terms: 'net_30'
      }]
    },
    'sync_accounts retains optional revisions on non-identity settings updates'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-provisioning-revision-0001',
      accounts: [{
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        billing: 'operator',
        revision: 8
      }]
    },
    'sync_accounts rejects revisions in provisioning mode'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-operator-handoff-billing-0001',
      accounts: [{
        account: { account_id: 'seller-account-123' },
        revision: 8,
        operator_identity: { operator: 'new-operator.example' },
        destination_billing_entity: {
          legal_name: 'New Operator Example LLC',
          tax_id: '98-7654321'
        }
      }]
    },
    'sync_accounts accepts staged destination billing for an operator handoff'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-destination-billing-alone-0001',
      accounts: [{
        account: { account_id: 'seller-account-123' },
        revision: 8,
        destination_billing_entity: {
          legal_name: 'New Operator Example LLC'
        }
      }]
    },
    'sync_accounts rejects destination billing without an operator identity request'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-request.json',
    {
      idempotency_key: 'sync-accounts-provisioning-destination-billing-0001',
      accounts: [{
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        billing: 'operator',
        destination_billing_entity: {
          legal_name: 'New Operator Example LLC'
        }
      }]
    },
    'sync_accounts rejects staged destination billing in provisioning mode'
  );
  await testSchemaValidation(
    '/schemas/core/account.json',
    {
      account_id: 'seller-account-123',
      name: 'Nova via Pinnacle',
      status: 'active',
      brand: { domain: 'nova-athletics.example' },
      operator: 'pinnacle-media.example',
      timezone: 'America/New_York',
      revision: 8,
      identity_change: {
        status: 'pending_approval',
        requested_operator_identity: { operator: 'new-operator.example' }
      }
    },
    'account reads expose canonical identity alongside a pending desired operator transition'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      accounts: [{
        account_id: 'seller-account-123',
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        timezone: 'America/New_York',
        revision: 8,
        identity_change: {
          status: 'pending_approval',
          requested_operator_identity: { operator: 'new-operator.example' }
        },
        action: 'updated',
        status: 'active'
      }]
    },
    'sync_accounts returns canonical identity and revision while a desired transition awaits approval'
  );
  await testSchemaRejection(
    '/schemas/core/account.json',
    {
      account_id: 'seller-account-123',
      name: 'Nova via Pinnacle',
      status: 'active',
      operator: 'pinnacle-media.example',
      revision: 9,
      identity_change: {
        status: 'rejected',
        requested_operator_identity: { operator: 'new-operator.example' }
      }
    },
    'rejected account identity changes require a reason'
  );
  await testSchemaValidation(
    '/schemas/core/account.json',
    {
      account_id: 'seller-account-123',
      name: 'Nova via Pinnacle',
      status: 'active',
      operator: 'pinnacle-media.example',
      revision: 9,
      identity_change: {
        status: 'rejected',
        requested_operator_identity: { operator: 'new-operator.example' },
        reason: 'Destination operator approval was not received'
      }
    },
    'rejected account identity changes accept a reason'
  );
  await testSchemaRejection(
    '/schemas/core/account.json',
    {
      account_id: 'seller-account-123',
      name: 'Nova via Pinnacle',
      status: 'active',
      operator: 'pinnacle-media.example',
      revision: 9,
      identity_change: {
        status: 'pending_approval',
        requested_operator_identity: { operator: 'new-operator.example' },
        reason: 'Pending changes do not carry rejection reasons'
      }
    },
    'pending account identity changes reject a rejection reason'
  );
  await testSchemaRejection(
    '/schemas/core/account.json',
    {
      account_id: 'seller-account-123',
      name: 'Nova via Pinnacle',
      status: 'active',
      operator: 'pinnacle-media.example',
      identity_change: {
        status: 'pending_approval',
        requested_operator_identity: { operator: 'new-operator.example' }
      }
    },
    'account identity change reads require a revision'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      accounts: [{
        account_id: 'seller-account-123',
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        identity_change: {
          status: 'pending_approval',
          requested_operator_identity: { operator: 'new-operator.example' }
        },
        action: 'updated',
        status: 'active'
      }]
    },
    'sync_accounts identity change results require a revision'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      dry_run: true,
      accounts: [{
        account_id: 'seller-account-123',
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        revision: 9,
        identity_change_preview: {
          outcome: 'would_require_approval',
          requested_operator_identity: { operator: 'new-operator.example' },
          impacts: [
            { area: 'account_id', effect: 'preserved' },
            { area: 'billing', effect: 'revalidation_required' },
            { area: 'grants', effect: 'revoke_and_regrant' }
          ]
        },
        action: 'updated',
        status: 'active'
      }]
    },
    'sync_accounts dry runs expose identity disposition and resource impacts'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      accounts: [{
        account_id: 'seller-account-123',
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        revision: 9,
        identity_change_preview: {
          outcome: 'would_apply',
          requested_operator_identity: {
            operator: 'pinnacle-media.example',
            operator_unit: { id: 'east-coast' }
          },
          impacts: [{ area: 'account_id', effect: 'preserved' }]
        },
        action: 'updated',
        status: 'active'
      }]
    },
    'sync_accounts rejects identity previews outside dry runs'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      accounts: [{
        account_id: 'seller-account-123',
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        revision: 9,
        destination_billing_entity: {
          legal_name: 'Destination Operator LLC'
        },
        action: 'updated',
        status: 'pending_approval'
      }]
    },
    'sync_accounts responses reject write-only destination billing identity'
  );
  await testSchemaRejection(
    '/schemas/account/list-accounts-response.json',
    {
      accounts: [{
        account_id: 'seller-account-123',
        name: 'Nova Athletics',
        status: 'active',
        destination_billing_entity: {
          legal_name: 'Destination Operator LLC'
        }
      }]
    },
    'list_accounts responses reject write-only destination billing identity'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      dry_run: true,
      accounts: [{
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        revision: 9,
        identity_change_preview: {
          outcome: 'would_apply',
          requested_operator_identity: { operator: 'pinnacle-media.example' },
          impacts: [{ area: 'media_buys', effect: 'blocked' }]
        },
        action: 'updated',
        status: 'active'
      }]
    },
    'non-blocked identity previews reject blocked impacts'
  );
  await testSchemaRejection(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      dry_run: true,
      accounts: [{
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        revision: 9,
        identity_change_preview: {
          outcome: 'blocked',
          requested_operator_identity: { operator: 'new-operator.example' },
          impacts: [{ area: 'account_id', effect: 'preserved' }],
          blockers: ['An active resource cannot be transferred']
        },
        action: 'failed',
        status: 'active'
      }]
    },
    'blocked identity previews require a blocked impact'
  );
  await testSchemaValidation(
    '/schemas/account/sync-accounts-response.json',
    {
      status: 'completed',
      dry_run: true,
      accounts: [{
        brand: { domain: 'nova-athletics.example' },
        operator: 'pinnacle-media.example',
        revision: 9,
        identity_change_preview: {
          outcome: 'blocked',
          requested_operator_identity: { operator: 'new-operator.example' },
          impacts: [
            { area: 'account_id', effect: 'preserved' },
            {
              area: 'billing',
              effect: 'blocked',
              reason: 'The requested operator identity conflicts with another account'
            }
          ],
          blockers: ['The requested operator identity conflicts with another account']
        },
        action: 'failed',
        status: 'active'
      }]
    },
    'blocked identity previews identify the blocking resource impact'
  );
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: false }
      },
      account: {
        supported_billing: ['operator'],
        identity_updates: {
          supported: true,
          supported_changes: ['operator_unit_name', 'operator_unit', 'operator']
        }
      }
    },
    'account capabilities advertise supported operator identity transitions'
  );
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: false }
      },
      account: {
        supported_billing: ['operator'],
        identity_updates: {
          supported: true,
          supported_changes: ['operator']
        }
      }
    },
    'operator capability encompasses a complete cross-operator identity replacement'
  );
  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: false }
      },
      account: {
        supported_billing: ['operator'],
        identity_updates: {
          supported: false,
          supported_changes: ['operator']
        }
      }
    },
    'unsupported account identity-update capabilities reject supported_changes'
  );
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...capabilitiesBase,
      adcp: {
        ...capabilitiesBase.adcp,
        idempotency: { supported: false }
      },
      account: {
        supported_billing: ['operator'],
        identity_updates: { supported: false }
      }
    },
    'account capabilities accept identity updates as unsupported'
  );
  await testSchemaValidation(
    '/schemas/error-details/account-moved.json',
    {
      current_account: {
        brand: { domain: 'nova-athletics.example' },
        operator: 'new-operator.example'
      },
      revision: 8
    },
    'ACCOUNT_MOVED details provide an authorized repair reference and current revision'
  );
  await testSchemaRejection(
    '/schemas/error-details/account-moved.json',
    { revision: 8 },
    'ACCOUNT_MOVED details require the current canonical account reference'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-request.json',
    {
      idempotency_key: 'request-proposals-confused-brand-0001',
      account: {
        brand: { domain: 'tenant-a.example' },
        operator: 'buyer.example'
      },
      brand: { domain: 'tenant-b.example' },
      brief: 'This must be rejected before account lookup'
    },
    'request_proposals rejects duplicate natural-account and top-level brand identity'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-request.json',
    { brief: 'Reach streaming audio listeners in Rome' },
    'request_proposals rejects a missing replay key'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-request.json',
    {
      idempotency_key: 'request-proposals-0002',
      account_id: 'seller-account-1',
      brief: 'Reach streaming audio listeners in Rome'
    },
    'request_proposals requires a stable BrandKey even when account_id is supplied'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-0001',
      refinements: [
        { proposal_id: 'proposal-1', action: 'revise', ask: 'Prefer video and move budget toward it' },
        { proposal_id: 'proposal-2', action: 'revise', ask: 'Use only the premium video product' }
      ]
    },
    'refine_proposals accepts plural proposal-scoped immutable refinements'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-typed-0001',
      refinements: [{
        proposal_id: 'proposal-1',
        action: 'revise',
        constraints: { total_budget: { max: 50000, currency: 'USD' } },
        product_changes: {
          'premium-video': 'include',
          'display-ros': 'omit'
        },
        alternatives: { count: 3 }
      }]
    },
    'refine_proposals accepts deterministic typed revision dimensions without free text'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-typed-0002',
      refinements: [{
        proposal_id: 'proposal-1',
        action: 'revise',
        constraints: {
          cpm: { max: 18, currency: 'USD' },
          impressions: { min: 2000000 },
          flight: { start_no_later_than: '2027-06-01T00:00:00Z', end_no_earlier_than: '2027-06-30T23:59:59Z' }
        }
      }]
    },
    'refine_proposals accepts rate, volume, and flight hard constraints'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-typed-0003',
      refinements: [{
        proposal_id: 'proposal-1',
        action: 'revise',
        constraints: { cpm: { max: 18 } }
      }]
    },
    'refine_proposals cpm constraint requires an explicit currency'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-typed-0004',
      refinements: [{
        proposal_id: 'proposal-1',
        action: 'revise',
        constraints: { flight: {} }
      }]
    },
    'refine_proposals flight constraint requires at least one bound'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-too-many-alternatives-0001',
      refinements: [{
        proposal_id: 'proposal-1',
        action: 'revise',
        alternatives: { count: 11 }
      }]
    },
    'refine_proposals rejects alternatives above the protocol maximum'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-oversized-batch-0001',
      refinements: Array.from({ length: 26 }, (_, index) => ({
        proposal_id: `proposal-${index + 1}`,
        action: 'revise',
        ask: 'Prefer premium video.'
      }))
    },
    'refine_proposals rejects batches above the protocol maximum'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-contradictory-product-0001',
      refinements: [{
        proposal_id: 'proposal-1',
        action: 'revise',
        product_changes: [
          { product_id: 'premium-video', action: 'include' },
          { product_id: 'premium-video', action: 'omit' }
        ]
      }]
    },
    'refine_proposals rejects the array shape that could express contradictory product actions'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-unknown-budget-member-0001',
      refinements: [{
        proposal_id: 'proposal-1',
        action: 'revise',
        constraints: { total_budget: { max: 50000, currency: 'USD', tolerance: 0.1 } }
      }]
    },
    'refine_proposals hard budget constraints reject unknown members'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-empty-amendment-0001',
      refinements: [{ proposal_id: 'proposal-1', action: 'revise', change_kind: 'amendment' }]
    },
    'refine_proposals rejects an amendment with no requested change'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-missing-action-0001',
      refinements: [
        { proposal_id: 'proposal-1', ask: 'Prefer video and move budget toward it' }
      ]
    },
    'refine_proposals requires an explicit action discriminator'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-accepted-cancel-0001',
      refinements: [{
        proposal_id: 'accepted-proposal-1',
        action: 'revise',
        change_kind: 'cancellation',
        ask: 'Cancel at the earliest date permitted by the accepted terms.'
      }]
    },
    'refine_proposals forks an accepted proposal into a cancellation proposal'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-0002',
      refinements: [{ proposal_id: 'proposal-1', action: 'finalize' }]
    },
    'refine_proposals accepts explicit finalization without a fake revision ask'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-request.json',
    {
      idempotency_key: 'refine-proposals-mixed-finalize-0001',
      refinements: [
        { proposal_id: 'proposal-1', action: 'finalize' },
        { proposal_id: 'proposal-2', action: 'revise', ask: 'Change the budget.' }
      ]
    },
    'refine_proposals keeps finalize batches exclusive and atomic'
  );
  const cleanPurchase = {
    idempotency_key: 'buy-products-clean-0001',
    account: { account_id: 'account-clean-1' },
    brand: { domain: 'buyer.example' },
    feed_version: 'feed-version-1',
    pricing_version: 'pricing-version-1',
    purchases: [{
      product_id: 'display-standard',
      pricing_option_id: 'fixed-cpm',
      budget: 50000
    }],
    start_time: 'asap',
    end_time: '2027-07-01T00:00:00Z'
  };
  await testSchemaValidation(
    '/schemas/media-buy/buy-products-request.json',
    cleanPurchase,
    'buy_products creates directly from canonical product selections'
  );
  await testSchemaRejection(
    '/schemas/media-buy/buy-products-request.json',
    {
      ...cleanPurchase,
      purchases: [{
        product_id: 'display-standard',
        pricing_option_id: 'fixed-cpm',
        creatives: [{ creative_id: 'legacy-inline' }]
      }]
    },
    'buy_products rejects inline creatives'
  );
  await testSchemaValidation(
    '/schemas/media-buy/accept-proposal-request.json',
    {
      idempotency_key: 'accept-proposal-0001',
      account: { account_id: 'account-clean-1' },
      proposal_id: 'proposal-committed-1',
      proposal_terms_digest: `sha256:${'A'.repeat(43)}`
    },
    'accept_proposal needs only the committed proposal and execution identity'
  );
  const cleanControl = {
    idempotency_key: 'control-media-buy-0001',
    account: { account_id: 'account-clean-1' },
    media_buy_id: 'media-buy-1',
    revision: 4,
    pacing: 'even',
    packages: [{ package_id: 'package-1', paused: true }]
  };
  await testSchemaValidation(
    '/schemas/media-buy/control-media-buy-request.json',
    cleanControl,
    'control_media_buy accepts operational controls inside accepted terms'
  );
  const nameControl = {
    idempotency_key: 'control-media-buy-name-0001',
    account: { account_id: 'account-clean-1' },
    media_buy_id: 'media-buy-1',
    revision: 4,
    name: 'Acme autumn campaign'
  };
  await testSchemaValidation(
    '/schemas/media-buy/control-media-buy-request.json',
    nameControl,
    'control_media_buy accepts a revision-checked MediaBuy name change'
  );
  await testSchemaRejection(
    '/schemas/media-buy/control-media-buy-request.json',
    { ...nameControl, canceled: true },
    'control_media_buy keeps cancellation mutually exclusive with a name change'
  );
  await testSchemaValidation(
    '/schemas/core/canonical-media-buy-action.json',
    { task: 'control_media_buy', action: 'update_name', mode: 'self_serve' },
    'canonical MediaBuy actions route name changes through control_media_buy'
  );
  await testSchemaValidation(
    '/schemas/creative/sync-creatives-request.json',
    {
      idempotency_key: 'assignment-operations-0001',
      account: { account_id: 'account-clean-1' },
      assignment_operations: [
        { operation: 'replace', package_id: 'package-1', replaces_creative_id: 'creative-old', creative_id: 'creative-new' },
        { operation: 'unassign', package_id: 'package-2', creative_id: 'creative-retired' }
      ]
    },
    'sync_creatives supports assignment-only replace and unassign operations'
  );
  await testSchemaRejection(
    '/schemas/creative/sync-creatives-request.json',
    {
      idempotency_key: 'assignment-operations-lenient-0001',
      account: { account_id: 'account-clean-1' },
      validation_mode: 'lenient',
      assignment_operations: [
        { operation: 'assign', package_id: 'package-1', creative_id: 'creative-new' }
      ]
    },
    'sync_creatives forbids partial lenient assignment operations'
  );
  await testSchemaRejection(
    '/schemas/media-buy/control-media-buy-request.json',
    { ...cleanControl, end_time: '2027-08-01T00:00:00Z' },
    'control_media_buy routes flight changes through proposal refinement'
  );
  await testSchemaRejection(
    '/schemas/media-buy/control-media-buy-request.json',
    { ...cleanControl, creatives: [{ creative_id: 'legacy-inline' }] },
    'control_media_buy rejects creative mutation'
  );
  await testSchemaValidation(
    '/schemas/media-buy/buy-products-response.json',
    {
      status: 'completed',
      media_buy_id: 'media-buy-1',
      revision: 1,
      accepted_proposal: {
        proposal_id: 'accepted-proposal-1',
        name: 'Accepted direct purchase',
        proposal_kind: 'new_media_buy',
        proposal_status: 'accepted',
        media_buy_id: 'media-buy-1',
        accepted_at: '2027-06-01T12:00:00Z',
        commercial_terms: {
          source_feed_version: 'feed-version-1',
          source_pricing_version: 'pricing-version-1',
          brand: { domain: 'buyer.example' },
          purchases: [{
            product_id: 'display-standard',
            pricing_option_id: 'fixed-cpm',
            pricing: { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 },
            budget: 50000,
            start_time: '2027-06-01T12:00:00Z',
            end_time: '2027-07-01T00:00:00Z'
          }],
          start_time: 'asap',
          end_time: '2027-07-01T00:00:00Z'
        },
        terms_digest: `sha256:${'A'.repeat(43)}`
      },
      purchase_bindings: [{ purchase_index: 0, product_id: 'display-standard', package_id: 'package-1' }],
      available_actions: [{ task: 'control_media_buy', action: 'update_catalog_assignments', mode: 'self_serve' }]
    },
    'buy_products returns an accepted immutable proposal snapshot'
  );
  await testSchemaValidation(
    '/schemas/media-buy/get-media-buys-response.json',
    {
      status: 'completed',
      media_buys: [{
        media_buy_id: 'media-buy-1',
        accepted_proposal_id: 'accepted-proposal-1',
        accepted_proposal_terms_digest: `sha256:${'A'.repeat(43)}`,
        accepted_proposal: {
          proposal_id: 'accepted-proposal-1',
          name: 'Recovered accepted terms',
          proposal_kind: 'new_media_buy',
          proposal_status: 'accepted',
          media_buy_id: 'media-buy-1',
          accepted_at: '2027-06-01T12:00:00Z',
          commercial_terms: {
            brand: { domain: 'buyer.example' },
            purchases: [{
              product_id: 'display-standard',
              pricing_option_id: 'fixed-cpm',
              pricing: { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 },
              start_time: '2027-06-01T12:00:00Z',
              end_time: '2027-07-01T00:00:00Z'
            }],
            start_time: 'asap',
            end_time: '2027-07-01T00:00:00Z'
          },
          terms_digest: `sha256:${'A'.repeat(43)}`
        },
        status: 'active',
        currency: 'USD',
        total_budget: 50000,
        confirmed_at: '2027-06-01T12:00:00Z',
        revision: 2,
        packages: [],
        available_actions: [{ task: 'control_media_buy', action: 'update_catalog_assignments', mode: 'self_serve' }]
      }]
    },
    'get_media_buys recovers accepted compact terms and routed actions after restart'
  );
  await testSchemaValidation(
    '/schemas/media-buy/request-proposals-request.json',
    {
      idempotency_key: 'request-proposals-opp-0001',
      brand: { domain: 'buyer.example' },
      brief: 'Reach streaming audio listeners in Rome',
      opportunity: {
        opportunity_id: 'opp-rome-audio-2027',
        phase: 'active_sourcing',
        intent: 'live_rfp',
        response_deadline: '2027-01-15T17:00:00Z'
      }
    },
    'request_proposals accepts reusable opportunity context'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-request.json',
    {
      idempotency_key: 'request-proposals-opp-0002',
      brand: { domain: 'buyer.example' },
      brief: 'Reach streaming audio listeners in Rome',
      opportunity: {
        opportunity_id: 'opp-rome-audio-closed',
        status: 'closed',
        close_reason: 'not_pursued'
      }
    },
    'request_proposals rejects a closed opportunity'
  );
  await testSchemaValidation(
    '/schemas/media-buy/decline-proposals-request.json',
    {
      idempotency_key: 'decline-proposals-0001',
      declines: [{ proposal_id: 'proposal-1', reason: 'inventory_fit' }],
      opportunity: {
        opportunity_id: 'opp-rome-audio-2027',
        status: 'closed',
        close_reason: 'not_pursued'
      }
    },
    'decline_proposals accepts terminal proposal and opportunity feedback'
  );
  await testSchemaRejection(
    '/schemas/media-buy/decline-proposals-request.json',
    {
      idempotency_key: 'decline-proposals-0002',
      declines: [{ proposal_id: 'proposal-1', reason: 'other' }]
    },
    'decline_proposals requires detail for an other reason'
  );
  await testSchemaRejection(
    '/schemas/media-buy/decline-proposals-request.json',
    {
      idempotency_key: 'decline-proposals-0003',
      declines: [{ proposal_id: 'proposal-1', reason: 'price' }],
      opportunity: {
        opportunity_id: 'opp-rome-audio-2027',
        close_reason: 'not_pursued'
      }
    },
    'opportunity close fields require closed status'
  );
  await testSchemaValidation(
    '/schemas/media-buy/decline-proposals-response.json',
    {
      results: [
        { proposal_id: 'proposal-1', outcome: 'declined' },
        { proposal_id: 'proposal-2', outcome: 'unable', reason: 'Proposal not found.' }
      ]
    },
    'decline_proposals returns one explicit outcome per proposal'
  );
  const proposalExecution = {
    idempotency_key: 'create-proposal-opportunity-0001',
    account: { account_id: 'account-opportunity-test' },
    brand: { domain: 'buyer.example' },
    proposal_id: 'proposal-1',
    total_budget: { amount: 50000, currency: 'USD' },
    start_time: 'asap',
    end_time: '2027-07-01T00:00:00Z'
  };
  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      ...proposalExecution,
      opportunity: { opportunity_id: 'opp-rome-audio-2027' }
    },
    'create_media_buy permits status omission for inferred close-won'
  );
  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      ...proposalExecution,
      opportunity: {
        opportunity_id: 'opp-rome-audio-2027',
        status: 'closed',
        close_reason: 'accepted_with_seller'
      }
    },
    'create_media_buy accepts explicit accepted-with-seller closure'
  );
  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      ...proposalExecution,
      opportunity: {
        opportunity_id: 'opp-rome-audio-2027',
        status: 'closed',
        close_reason: 'not_pursued'
      }
    },
    'create_media_buy rejects non-winning explicit opportunity closure'
  );
  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'create-package-opportunity-0001',
      account: { account_id: 'account-opportunity-test' },
      brand: { domain: 'buyer.example' },
      packages: [{
        product_id: 'display-standard',
        pricing_option_id: 'fixed-cpm',
        budget: 50000
      }],
      start_time: 'asap',
      end_time: '2027-07-01T00:00:00Z',
      opportunity: { opportunity_id: 'opp-package-mode' }
    },
    'create_media_buy restricts opportunity closure to proposal mode'
  );
  const splitCapabilityBase = {
    status: 'completed',
    adcp: {
      major_versions: [3],
      idempotency: { supported: true, replay_ttl_seconds: 86400 }
    },
    supported_protocols: ['media_buy']
  };
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...splitCapabilityBase,
      media_buy: {
        lifecycle_tools: ['request_proposals', 'refine_proposals'],
        proposal_refinement: {
          supported_dimensions: ['total_budget', 'cpm', 'impressions', 'flight', 'product_changes', 'alternatives', 'criteria'],
          max_alternatives: 4
        }
      }
    },
    'compact proposal capability advertises typed refinement dimensions'
  );
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...splitCapabilityBase,
      media_buy: {
        lifecycle_tools: ['refine_proposals'],
        proposal_refinement: { supported_dimensions: [] }
      }
    },
    'compact proposal capability can authoritatively advertise ask-only refinement'
  );
  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...splitCapabilityBase,
      media_buy: {
        lifecycle_tools: ['request_proposals'],
        proposal_refinement: { supported_dimensions: ['total_budget'] }
      }
    },
    'proposal refinement capabilities require the refine_proposals lifecycle tool'
  );
  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...splitCapabilityBase,
      media_buy: {
        lifecycle_tools: ['refine_proposals'],
        proposal_refinement: {
          supported_dimensions: ['total_budget'],
          max_alternatives: 4
        }
      }
    },
    'proposal refinement cannot advertise an alternatives limit without alternatives support'
  );
  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      ...splitCapabilityBase,
      media_buy: {
        lifecycle_tools: ['refine_proposals'],
        proposal_refinement: {
          supported_dimensions: ['alternatives'],
          max_alternatives: 11
        }
      }
    },
    'proposal refinement cannot advertise an alternatives limit above the protocol maximum'
  );
  await testSchemaValidation(
    '/schemas/media-buy/list-products-response.json',
    { outcome: 'listed', products: [], feed_version: 'feed-empty-1', cache_scope: 'public' },
    'list_products treats no matches as an empty successful product page'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-response.json',
    { status: 'submitted', task_id: 'task-refinement-approval-1' },
    'refine_proposals can enter an async approval workflow'
  );
  await testSchemaValidation(
    '/schemas/core/canonical-product.json',
    canonicalProductBase,
    'split product tools accept canonical format options'
  );
  await testSchemaRejection(
    '/schemas/core/canonical-product.json',
    {
      ...canonicalProductBase,
      allowed_actions: [{ action: 'update_packages', modes: ['self_serve'] }]
    },
    'split product tools reject deprecated coarse MediaBuy actions'
  );
  await testSchemaRejection(
    '/schemas/core/canonical-product.json',
    productBase,
    'split product tools reject legacy-only product format IDs'
  );
  await testSchemaRejection(
    '/schemas/core/canonical-product.json',
    { ...canonicalProductBase, format_ids: productBase.format_ids },
    'split product tools reject dual-emitted legacy product format IDs'
  );
  await testSchemaRejection(
    '/schemas/core/canonical-product.json',
    {
      ...canonicalProductBase,
      format_options: [{
        ...canonicalProductBase.format_options[0],
        v1_format_ref: productBase.format_ids
      }]
    },
    'split product tools reject legacy named-format links inside canonical options'
  );
  await testSchemaRejection(
    '/schemas/core/canonical-product.json',
    {
      ...canonicalProductBase,
      placements: [{
        kind: 'seller_inline',
        placement_id: 'homepage',
        name: 'Homepage',
        mode: 'targetable',
        format_ids: productBase.format_ids
      }]
    },
    'split product tools reject legacy placement format IDs'
  );
  await testSchemaRejection(
    '/schemas/core/canonical-product.json',
    {
      ...canonicalProductBase,
      placements: [{
        kind: 'seller_inline',
        placement_id: 'homepage',
        name: 'Homepage',
        mode: 'targetable',
        format_options: [{
          ...canonicalProductBase.format_options[0],
          v1_format_ref: productBase.format_ids
        }]
      }]
    },
    'split product tools reject legacy named-format links inside placement options'
  );
  await testSchemaValidation(
    '/schemas/media-buy/list-products-response.json',
    { outcome: 'unchanged', feed_version: 'feed-v2', cache_scope: 'public' },
    'list_products explicitly discriminates an unchanged feed response'
  );
  await testSchemaValidation(
    '/schemas/media-buy/request-proposals-response.json',
    {
      outcome: 'proposed',
      proposals: [{
        proposal_id: 'proposal-1',
        name: 'Draft premium video plan',
        proposal_kind: 'new_media_buy',
        proposal_status: 'draft',
        expires_at: '2027-06-30T23:59:59Z',
        commercial_terms: {
          brand: { domain: 'buyer.example' },
          purchases: [{
            product_id: 'premium-video',
            pricing_option_id: 'fixed-cpm',
            pricing: { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 28 },
            start_time: '2027-06-01T12:00:00Z',
            end_time: '2027-07-01T00:00:00Z'
          }],
          start_time: 'asap',
          end_time: '2027-07-01T00:00:00Z'
        },
        terms_digest: `sha256:${'A'.repeat(43)}`
      }],
      products: [{ ...canonicalProductBase, product_id: 'premium-video' }]
    },
    'request_proposals explicitly discriminates a successful proposal response'
  );
  await testSchemaValidation(
    '/schemas/media-buy/request-proposals-response.json',
    {
      outcome: 'rejected',
      reason: 'No available offer satisfies the campaign constraints.',
      suggestions: ['Broaden the flight dates.']
    },
    'request_proposals has an explicit business-rejection outcome'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-response.json',
    { products: [] },
    'request_proposals products-only compatibility requires an explicit outcome and continuation'
  );
  await testSchemaValidation(
    '/schemas/media-buy/request-proposals-response.json',
    {
      outcome: 'products_available',
      products: [{ ...canonicalProductBase, product_id: 'brief-composed-video' }],
      incomplete: [{
        scope: 'proposals',
        description: 'The established seller returned products but did not construct a proposal.'
      }],
      purchase_continuation: {
        kind: 'legacy_create',
        continuation_token: 'products-only-composed-token-01',
        continuation_expires_at: '2027-01-01T00:05:00Z',
        product_ids: ['brief-composed-video'],
        source_adcp_version: '3.1',
        losses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
        requires_explicit_acceptance: true
      }
    },
    'request_proposals preserves a products-only established result without fabricating proposal terms'
  );
  await testSchemaValidation(
    '/schemas/media-buy/request-proposals-response.json',
    {
      outcome: 'products_available',
      products: [{ ...canonicalProductBase, product_id: 'brief-composed-video' }],
      purchase_continuation: {
        kind: 'listed_purchase',
        product_ids: ['brief-composed-video'],
        cache_scope: 'account',
        feed_version: 'account-feed-v17',
        pricing_version: 'account-pricing-v9'
      }
    },
    'request_proposals can direct an adapter to obtain a real account-scoped listing fence'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-response.json',
    {
      outcome: 'products_available',
      products: [{ ...canonicalProductBase, product_id: 'brief-composed-video' }],
      incomplete: [{
        scope: 'pricing',
        description: 'The established seller did not return complete pricing.'
      }],
      purchase_continuation: {
        kind: 'listed_purchase',
        product_ids: ['brief-composed-video'],
        cache_scope: 'account',
        feed_version: 'account-feed-v17',
        pricing_version: 'account-pricing-v9'
      }
    },
    'listed purchase cannot claim an atomic fence when pricing is incomplete'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-response.json',
    {
      outcome: 'products_available',
      products: [{ ...canonicalProductBase, product_id: 'brief-composed-video' }],
      proposals: [{ proposal_id: 'synthetic-proposal' }],
      purchase_continuation: {
        kind: 'legacy_create',
        continuation_token: 'products-only-composed-token-01',
        continuation_expires_at: '2027-01-01T00:05:00Z',
        product_ids: ['brief-composed-video'],
        losses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
        requires_explicit_acceptance: true
      }
    },
    'products_available cannot carry a synthetic proposal or terms digest'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-response.json',
    {
      outcome: 'products_available',
      products: [{ ...canonicalProductBase, product_id: 'brief-composed-video' }],
      purchase_continuation: {
        kind: 'legacy_create',
        continuation_token: 'products-only-composed-token-01',
        continuation_expires_at: '2027-01-01T00:05:00Z',
        product_ids: ['brief-composed-video'],
        losses: ['feed_version_not_atomic'],
        requires_explicit_acceptance: true
      }
    },
    'legacy products-only continuation names every lost fence and fails closed'
  );
  await testSchemaRejection(
    '/schemas/media-buy/request-proposals-response.json',
    {
      proposals: [{
        proposal_id: 'proposal-1',
        name: 'Draft premium video plan',
        allocations: [{ product_id: 'premium-video', allocation_percentage: 100 }],
        proposal_status: 'draft',
        expires_at: '2027-06-30T23:59:59Z'
      }],
      outcome: 'proposed',
      products: [{ ...canonicalProductBase, product_id: 'premium-video' }],
      reason: 'This must not appear on the success arm.'
    },
    'request_proposals success cannot carry rejection fields'
  );
  const canonicalDraftRevision = {
    proposal_id: 'proposal-2',
    parent_proposal_id: 'proposal-1',
    proposal_kind: 'new_media_buy',
    proposal_status: 'draft',
    name: 'Revised premium video plan',
    commercial_terms: {
      brand: { domain: 'buyer.example' },
      purchases: [{
        product_id: 'premium-video',
        pricing_option_id: 'fixed-cpm',
        pricing: { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 28 },
        start_time: '2027-06-01T12:00:00Z',
        end_time: '2027-07-01T00:00:00Z'
      }],
      start_time: '2027-06-01T12:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      total_budget: { amount: 50000, currency: 'USD' }
    },
    terms_digest: `sha256:${'A'.repeat(43)}`
  };
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-1',
        outcome: 'partial',
        proposals: [canonicalDraftRevision],
        reason_code: 'constraint_unsatisfiable',
        reason: 'The requested budget floor could not be met.',
        unsatisfied_constraints: ['total_budget', 'cpm']
      }],
      products: []
    },
    'refine_proposals partial results identify unsatisfied keyed constraints'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-1',
        outcome: 'unable',
        reason_code: 'constraint_unsatisfiable',
        reason: 'The required product cannot be included.',
        unsatisfied_product_changes: { 'premium-video': 'include' }
      }],
      products: []
    },
    'refine_proposals unable results identify unsatisfied keyed product changes'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-1',
        outcome: 'partial',
        proposals: [canonicalDraftRevision],
        reason_code: 'constraint_unsatisfiable',
        reason: 'A structured request was not satisfied.'
      }],
      products: []
    },
    'refine_proposals constraint failures require machine-readable failed identifiers'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-1',
        outcome: 'revised',
        proposals: [
          canonicalDraftRevision,
          { ...canonicalDraftRevision, proposal_id: 'proposal-3', terms_digest: `sha256:${'B'.repeat(43)}` }
        ]
      }],
      products: []
    },
    'refine_proposals accepts multiple commercially distinct revised alternatives'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-1',
        outcome: 'revised',
        proposals: [canonicalDraftRevision],
        unsatisfied_constraints: ['total_budget']
      }],
      products: []
    },
    'refine_proposals cannot label a constraint-violating draft revised'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-1',
        outcome: 'revised',
        proposals: [(() => { const { parent_proposal_id, ...orphan } = canonicalDraftRevision; return orphan; })()]
      }],
      products: []
    },
    'refine_proposals rejects returned proposals without negotiation lineage'
  );
  await testSchemaValidation(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-draft-1',
        outcome: 'finalized',
        proposal: {
          proposal_id: 'proposal-committed-1',
          parent_proposal_id: 'proposal-draft-1',
          proposal_kind: 'new_media_buy',
          proposal_status: 'committed',
          expires_at: '2027-06-30T23:59:59Z',
          name: 'Held premium video plan',
          commercial_terms: {
            brand: { domain: 'buyer.example' },
            purchases: [{
              product_id: 'premium-video',
              pricing_option_id: 'fixed-cpm',
              pricing: { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 28 },
              start_time: '2027-06-01T12:00:00Z',
              end_time: '2027-07-01T00:00:00Z'
            }],
            start_time: 'asap',
            end_time: '2027-07-01T00:00:00Z'
          },
          terms_digest: `sha256:${'A'.repeat(43)}`
        }
      }],
      products: []
    },
    'refine_proposals finalization returns a committed proposal with a hold deadline'
  );
  await testSchemaRejection(
    '/schemas/media-buy/refine-proposals-response.json',
    {
      results: [{
        source_proposal_id: 'proposal-draft-1',
        outcome: 'finalized',
        proposal: {
          proposal_id: 'proposal-committed-1',
          parent_proposal_id: 'proposal-draft-1',
          proposal_kind: 'new_media_buy',
          proposal_status: 'committed',
          expires_at: '2027-06-30T23:59:59Z',
          name: 'Held premium video plan',
          commercial_terms: {
            brand: { domain: 'buyer.example' },
            purchases: [{
              product_id: 'premium-video',
              pricing_option_id: 'fixed-cpm',
              pricing: { pricing_option_id: 'fixed-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 28 },
              start_time: '2027-06-01T12:00:00Z',
              end_time: '2027-07-01T00:00:00Z'
            }],
            start_time: '2027-06-01T12:00:00Z',
            end_time: '2027-07-01T00:00:00Z'
          },
          terms_digest: `sha256:${'A'.repeat(43)}`
        }
      }, {
        source_proposal_id: 'proposal-draft-2',
        outcome: 'unable',
        reason_code: 'source_unavailable',
        reason: 'Inventory could not be held.'
      }],
      products: []
    },
    'refine_proposals forbids partially successful atomic finalization batches'
  );
  log('');

  log('SignalId compatibility during SignalRef migration:', 'info');
  await testSchemaValidation(
    '/schemas/signals/get-signals-response.json',
    {
      status: 'completed',
      cache_scope: 'public',
      signals: [
        {
          signal_id: legacySignalId,
          ...signalListingCore
        }
      ]
    },
    'get_signals response accepts deprecated signal_id without signal_ref during migration window'
  );
  await testSchemaValidation(
    '/schemas/core/audience-selector.json',
    {
      type: 'signal',
      signal_id: legacySignalId,
      value_type: 'binary',
      value: true
    },
    'AudienceSelector accepts deprecated signal_id without signal_ref during migration window'
  );
  await testSchemaValidation(
    '/schemas/core/targeting.json',
    {
      signal_targeting: [
        {
          signal_id: legacySignalId,
          value_type: 'binary',
          value: true
        }
      ]
    },
    'Targeting overlay accepts deprecated flat signal_targeting during migration window'
  );
  await testSchemaValidation(
    '/schemas/media-buy/get-products-request.json',
    {
      idempotency_key: '550e8400-e29b-41d4-a716-446655440005',
      buying_mode: 'wholesale',
      filters: {
        signal_targeting: [
          {
            signal_id: legacySignalId,
            value_type: 'binary',
            value: true,
            targeting_mode: 'include'
          }
        ]
      }
    },
    'get_products filters.signal_targeting accepts deprecated signal_id during SignalRef migration window'
  );
  await testSchemaValidation(
    '/schemas/core/wholesale-feed-event.json',
    {
      event_id: '018f4f28-6b5d-7f50-9d57-111111111111',
      event_type: 'signal.created',
      entity_type: 'signal',
      entity_id: 'sig_auto_intenders',
      created_at: '2026-05-25T10:00:00Z',
      payload: {
        signal_agent_segment_id: 'sig_auto_intenders',
        applies_to: { scope: 'public' },
        signal: {
          signal_id: legacySignalId,
          ...signalListingCoreWithoutLegacyCoverage,
          coverage_forecast: signalCoverageForecast
        }
      }
    },
    'Wholesale signal event accepts deprecated signal_id, optional legacy coverage_percentage, relaxed data_provider/pricing_options, and coverage_forecast'
  );
  await testSchemaValidation(
    '/schemas/core/wholesale-feed-event.json',
    {
      event_id: '018f1f5d-7b6a-7cc2-8a1f-1234567890ab',
      event_type: 'product.updated',
      entity_type: 'product',
      entity_id: 'canonical-product-1',
      created_at: '2027-06-01T12:00:00Z',
      payload: {
        product_id: 'canonical-product-1',
        canonical_product: { product_id: 'canonical-product-1', name: 'Canonical product' },
        changed_fields: ['name'],
        applies_to: { scope: 'public' }
      }
    },
    'Wholesale product event updates a list_products canonical mirror without legacy Product'
  );
  await testSchemaValidation(
    '/schemas/core/wholesale-feed-webhook.json',
    {
      idempotency_key: 'canonical-product-webhook-0001',
      notification_id: '018f1f5d-7b6a-7cc2-8a1f-1234567890ab',
      notification_type: 'product.updated',
      fired_at: '2027-06-01T12:00:01Z',
      subscriber_id: 'canonical-product-mirror',
      account_id: 'account-1',
      wholesale_feed_version: 'feed-version-2',
      product_payload_view: 'canonical',
      cache_scope: 'public',
      event: {
        event_id: '018f1f5d-7b6a-7cc2-8a1f-1234567890ab',
        event_type: 'product.updated',
        entity_type: 'product',
        entity_id: 'canonical-product-1',
        created_at: '2027-06-01T12:00:00Z',
        payload: {
          product_id: 'canonical-product-1',
          canonical_product: { product_id: 'canonical-product-1', name: 'Canonical product' },
          applies_to: { scope: 'public' }
        }
      }
    },
    'Wholesale product webhook requires and echoes the canonical product view'
  );
  await testSchemaRejection(
    '/schemas/core/wholesale-feed-webhook.json',
    {
      idempotency_key: 'signal-webhook-view-0001',
      notification_id: '018f4f28-6b5d-7f50-9d57-111111111111',
      notification_type: 'signal.created',
      fired_at: '2027-06-01T12:00:01Z',
      subscriber_id: 'signal-mirror',
      account_id: 'account-1',
      wholesale_feed_version: 'signal-version-2',
      product_payload_view: 'canonical',
      cache_scope: 'public',
      event: {
        event_id: '018f4f28-6b5d-7f50-9d57-111111111111',
        event_type: 'signal.created',
        entity_type: 'signal',
        entity_id: 'sig_auto_intenders',
        created_at: '2027-06-01T12:00:00Z',
        payload: {
          signal_agent_segment_id: 'sig_auto_intenders',
          applies_to: { scope: 'public' },
          signal: {
            signal_id: legacySignalId,
            ...signalListingCoreWithoutLegacyCoverage,
            coverage_forecast: signalCoverageForecast
          }
        }
      }
    },
    'Wholesale signal webhook rejects product view negotiation'
  );

  log('Registry change feed schemas:', 'info');
  await testSchemaValidation(
    '/schemas/core/registry-feed-response.json',
    {
      events: [
        {
          event_id: '019539a0-1234-7000-8000-000000000001',
          event_type: 'property.created',
          entity_type: 'property',
          entity_id: '019539a0-b1c2-7000-8000-000000000002',
          payload: {
            property_rid: '019539a0-b1c2-7000-8000-000000000002',
            classification: 'property',
            source: 'contributed',
            identifiers: [{ type: 'domain', value: 'streamer.example.com' }]
          },
          actor: 'pipeline:crawler',
          created_at: '2026-03-31T10:00:00.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000003',
          event_type: 'collection.created',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000011',
          payload: {
            collection_rid: '019539a0-b1c2-7000-8000-000000000011',
            publisher_domain: 'streamer.example.com',
            collection_id: 'weekly_show',
            name: 'Weekly show',
            kind: 'series',
            source: 'authoritative',
            status: 'active',
            identifiers: [
              { publisher_domain: 'youtube.com', type: 'youtube_channel_id', value: 'uc_example123' }
            ]
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:00:30.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000013',
          event_type: 'collection.updated',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000011',
          payload: {
            collection_rid: '019539a0-b1c2-7000-8000-000000000011',
            publisher_domain: 'streamer.example.com',
            collection_id: 'weekly_show',
            name: 'Weekly show',
            kind: 'series',
            source: 'authoritative',
            status: 'active',
            identifiers: [
              { publisher_domain: 'youtube.com', type: 'youtube_channel_id', value: 'UCK5Fn7Z6-iFMdxEye2FsKXg' },
              { publisher_domain: 'youtube.com', type: 'youtube_channel_handle', value: '@weeklyshow' },
              { publisher_domain: 'youtube.com', type: 'youtube_channel_url', value: 'https://youtube.com/@weeklyshow' }
            ]
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:00:40.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000014',
          event_type: 'collection.merged',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000015',
          payload: {
            alias_rid: '019539a0-b1c2-7000-8000-000000000015',
            canonical_rid: '019539a0-b1c2-7000-8000-000000000011',
            evidence: 'manual_review'
          },
          actor: 'registry:manual_review',
          created_at: '2026-03-31T10:00:42.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000015',
          event_type: 'collection.removed',
          entity_type: 'collection',
          entity_id: '019539a0-b1c2-7000-8000-000000000014',
          payload: {
            collection_rid: '019539a0-b1c2-7000-8000-000000000014',
            publisher_domain: 'streamer.example.com',
            collection_id: 'retired_show',
            name: 'Retired show',
            kind: 'series',
            source: 'authoritative',
            status: 'removed',
            identifiers: []
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:00:45.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000012',
          event_type: 'authorization.granted',
          entity_type: 'authorization',
          entity_id: 'https://ads.agency.example.com:streamer.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            publisher_domain: 'streamer.example.com',
            authorization_type: 'property_ids',
            property_ids: ['primetime_ctv'],
            placement_ids: ['pre_roll_30s'],
            countries: ['US', 'CA'],
            delegation_type: 'direct',
            exclusive: false,
            signing_keys: [{ kid: 'pub-2026-04', kty: 'OKP', alg: 'EdDSA', crv: 'Ed25519', x: 'abc123' }]
          },
          actor: 'pipeline:crawler',
          created_at: '2026-03-31T10:01:00.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000007',
          event_type: 'agent.discovered',
          entity_type: 'agent',
          entity_id: 'https://new-agent.example.com',
          payload: {
            agent_url: 'https://new-agent.example.com',
            channels: [],
            property_types: [],
            markets: [],
            categories: [],
            tags: [],
            delivery_types: [],
            property_count: 0,
            publisher_count: 0,
            has_tmp: false
          },
          actor: 'pipeline:crawler',
          created_at: '2026-03-31T10:01:30.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000004',
          event_type: 'agent.compliance_changed',
          entity_type: 'agent',
          entity_id: 'https://ads.agency.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            previous_status: 'passing',
            current_status: 'degraded',
            headline: 'media_buy track failing: 2 scenarios down',
            tracks: { core: 'pass', media_buy: 'partial', creative: 'skip', governance: 'silent' },
            storyboards_passing: 24,
            storyboards_total: 27,
            storyboards: [
              { storyboard_id: 'media_buy_seller', status: 'failing', steps_passed: 4, steps_total: 7 },
              { storyboard_id: 'optional_controller', status: 'untested' },
              { storyboard_id: 'mixed_flow', status: 'partial', steps_passed: 3, steps_total: 5 }
            ]
          },
          actor: 'pipeline:compliance-heartbeat',
          created_at: '2026-03-31T10:02:00.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000008',
          event_type: 'agent.verification_earned',
          entity_type: 'agent',
          entity_id: 'https://ads.agency.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            role: 'media-buy',
            verified_specialisms: ['sales-catalog-driven'],
            adcp_version: '3.1.0-beta.5'
          },
          actor: 'pipeline:compliance-heartbeat',
          created_at: '2026-03-31T10:02:30.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000009',
          event_type: 'agent.verification_lost',
          entity_type: 'agent',
          entity_id: 'https://ads.agency.example.com',
          payload: {
            agent_url: 'https://ads.agency.example.com',
            role: 'media-buy',
            reason: 'media_buy track failing'
          },
          actor: 'pipeline:compliance-heartbeat',
          created_at: '2026-03-31T10:02:45.000Z'
        },
        {
          event_id: '019539a0-1234-7000-8000-000000000010',
          event_type: 'publisher.adagents_discovered',
          entity_type: 'publisher',
          entity_id: 'streamer.example.com',
          payload: {
            publisher_domain: 'streamer.example.com',
            agent_count: 2,
            property_count: 4,
            collection_count: 1,
            format_count: 3,
            placement_count: 6,
            changed_fields: ['authorized_agents', 'formats', 'placements', 'properties'],
            source: 'catalog_crawl',
            discovery_method: 'direct',
            manager_domain: null
          },
          actor: 'pipeline:catalog_crawl',
          created_at: '2026-03-31T10:03:00.000Z'
        }
      ],
      cursor: '019539a0-1234-7000-8000-000000000013',
      has_more: false,
      freshness: {
        generated_at: '2026-03-31T10:03:15.000Z',
        latest_event_created_at: '2026-03-31T10:03:00.000Z',
        lag_seconds: 15,
        retention_days: 90
      }
    },
    'Registry feed response validates typed property, collection, authorization, and compliance events'
  );
  await testSchemaValidation(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000014',
      event_type: 'publisher.adagents_changed',
      entity_type: 'publisher',
      entity_id: 'streamer.example.com',
      payload: {
        publisher_domain: 'streamer.example.com',
        agent_count: 2,
        property_count: 4,
        collection_count: 1,
        format_count: 3,
        placement_count: 6,
        changed_fields: ['formats']
      },
      actor: 'pipeline:catalog_crawl',
      created_at: '2026-03-31T10:04:00.000Z'
    },
    'Registry publisher change event accepts formats-only section observability'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000005',
      event_type: 'authorization.granted',
      entity_type: 'authorization',
      entity_id: 'https://ads.agency.example.com:streamer.example.com',
      payload: {
        agent_url: 'https://ads.agency.example.com'
      },
      actor: 'pipeline:crawler',
      created_at: '2026-03-31T10:03:00.000Z'
    },
    'Registry authorization events reject missing publisher_domain'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000006',
      event_type: 'agent.compliance_changed',
      entity_type: 'publisher',
      entity_id: 'https://ads.agency.example.com',
      payload: {
        agent_url: 'https://ads.agency.example.com',
        previous_status: 'passing',
        current_status: 'degraded',
        tracks: { core: 'pass' },
        storyboards_passing: 1,
        storyboards_total: 2
      },
      actor: 'pipeline:compliance-heartbeat',
      created_at: '2026-03-31T10:04:00.000Z'
    },
    'Registry event discriminator rejects mismatched entity_type'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000016',
      event_type: 'collection.created',
      entity_type: 'collection',
      entity_id: '019539a0-b1c2-7000-8000-000000000016',
      payload: {
        collection_rid: '019539a0-b1c2-7000-8000-000000000016',
        publisher_domain: 'streamer.example.com',
        collection_id: 'empty_identifiers',
        source: 'authoritative',
        status: 'active'
      },
      actor: 'pipeline:catalog_crawl',
      created_at: '2026-03-31T10:05:00.000Z'
    },
    'Registry collection.created rejects missing identifiers'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000017',
      event_type: 'collection.created',
      entity_type: 'property',
      entity_id: '019539a0-b1c2-7000-8000-000000000017',
      payload: {
        collection_rid: '019539a0-b1c2-7000-8000-000000000017',
        publisher_domain: 'streamer.example.com',
        collection_id: 'wrong_entity',
        source: 'authoritative',
        status: 'active',
        identifiers: [{ publisher_domain: 'youtube.com', type: 'youtube_channel_id', value: 'UCK5Fn7Z6-iFMdxEye2FsKXg' }]
      },
      actor: 'pipeline:catalog_crawl',
      created_at: '2026-03-31T10:06:00.000Z'
    },
    'Registry collection events reject mismatched entity_type'
  );
  await testSchemaRejection(
    '/schemas/core/registry-event.json',
    {
      event_id: '019539a0-1234-7000-8000-000000000018',
      event_type: 'collection.removed',
      entity_type: 'collection',
      entity_id: '019539a0-b1c2-7000-8000-000000000018',
      payload: {
        collection_rid: '019539a0-b1c2-7000-8000-000000000018',
        publisher_domain: 'streamer.example.com',
        collection_id: 'not_removed',
        source: 'authoritative',
        status: 'active',
        identifiers: []
      },
      actor: 'pipeline:catalog_crawl',
      created_at: '2026-03-31T10:07:00.000Z'
    },
    'Registry collection.removed rejects active status'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-request.json',
    {
      signal_refs: [
        {
          scope: 'data_provider',
          data_provider_domain: 'signals.example.com',
          signal_id: 'likely_ev_buyers'
        }
      ],
      fields: ['taxonomy', 'modeling', 'data_subject_rights']
    },
    'get_signals request accepts requested inline signal fields'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-response.json',
    {
      status: 'completed',
      signals: [
        {
          signal_ref: {
            scope: 'signal_source',
            signal_source_url: 'https://signals.example.com/mcp',
            signal_id: 'private-likely-ev-buyers'
          },
          signal_agent_segment_id: 'seg-private-ev-001',
          name: 'Private likely EV buyers',
          description: 'Private source-native modeled EV intent signal.',
          signal_type: 'custom',
          deployments: [
            {
              type: 'platform',
              platform: 'dv360',
              account: '123456',
              is_live: true
            }
          ],
          taxonomy: {
            ref: 'https://taxonomy.example.com/audience/v1',
            values: [{ id: 'auto.ev_intenders' }]
          },
          data_subject_rights: {
            channels: [
              {
                rights: ['access'],
                email: 'privacy@example.com'
              }
            ],
            response_sla_days: 30
          }
        }
      ],
      cache_scope: 'account'
    },
    'get_signals response accepts typed inline enrichment fields for source-native signals'
  );
  await testSchemaRejection(
    '/schemas/signals/get-signals-request.json',
    {
      signal_spec: 'EV intenders',
      fields: ['everything']
    },
    'get_signals request rejects unknown signal fields'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-async-response-submitted.json',
    {
      status: 'submitted',
      task_id: 'task_signal_discovery_001',
      message: 'Provider discovery queued'
    },
    'get_signals submitted async envelope validates'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-async-response-working.json',
    {
      percentage: 40,
      current_step: 'querying_providers',
      step_number: 2,
      total_steps: 5
    },
    'get_signals working async progress validates'
  );
  await testSchemaValidation(
    '/schemas/signals/get-signals-response.json',
    {
      status: 'failed',
      errors: [
        {
          code: 'PROVIDER_UNAVAILABLE',
          message: 'Signal provider did not respond before the task deadline'
        }
      ]
    },
    'get_signals failed completion does not require signals or cache_scope'
  );
  await testSchemaValidation(
    '/schemas/media-buy/get-products-response.json',
    {
      status: 'failed',
      errors: [
        {
          code: 'INVENTORY_UNAVAILABLE',
          message: 'Inventory provider did not respond before the task deadline'
        }
      ]
    },
    'get_products failed completion does not require products or cache_scope'
  );
  log('');

  // Product `publisher_properties` rejects `publisher_domains[]` compact form (#4508):
  //
  // What's being exercised: the rejection comes from the `allOf` clause in
  // `core/product.json` (`{ not: { required: ['publisher_domains'] } }`),
  // NOT from the selector schema's XOR. The selector itself accepts both
  // singular and plural; product-side wraps the selector to forbid plural.
  // If a future regression removes that `allOf+not` clause, these tests
  // turn red — the compact form would silently pass through products.
  log('product.publisher_properties rejects compact `publisher_domains[]` form (#4508):', 'info');
  await testSchemaValidation(
    '/schemas/core/product.json',
    {
      product_id: 'singular_ok',
      name: 'Singular OK',
      description: 'Test',
      publisher_properties: [
        { publisher_domain: 'example.com', selection_type: 'all' }
      ],
      format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
      delivery_type: 'guaranteed',
      delivery_measurement: { provider: 'Test' },
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions'],
        date_range_support: 'date_range'
      }
    },
    'Product with singular publisher_domain accepted'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      product_id: 'compact_rejected',
      name: 'Compact rejected',
      description: 'Test',
      publisher_properties: [
        { publisher_domains: ['example.com', 'other.example'], selection_type: 'by_tag', property_tags: ['t'] }
      ],
      format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
      delivery_type: 'guaranteed',
      delivery_measurement: { provider: 'Test' },
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions'],
        date_range_support: 'date_range'
      }
    },
    'Product with compact publisher_domains[] form rejected'
  );
  await testSchemaRejection(
    '/schemas/core/product.json',
    {
      product_id: 'compact_rejected_all',
      name: 'Compact rejected on all',
      description: 'Test',
      publisher_properties: [
        { publisher_domains: ['example.com'], selection_type: 'all' }
      ],
      format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
      delivery_type: 'guaranteed',
      delivery_measurement: { provider: 'Test' },
      pricing_options: [{ pricing_option_id: 'cpm', pricing_model: 'cpm', rate: 10, currency: 'USD', is_fixed: true }],
      reporting_capabilities: {
        available_reporting_frequencies: ['daily'],
        expected_delay_minutes: 240,
        timezone: 'UTC',
        supports_webhooks: false,
        available_metrics: ['impressions'],
        date_range_support: 'date_range'
      }
    },
    'Product with compact form on `all` selector rejected'
  );
  log('');

  // Signal definition enrichment: taxonomy is metadata on the signal
  // definition, not a fourth value_type or package-targeting expression branch.
  log('Signal Definition enrichment:', 'info');
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'likely_ev_buyers',
      name: 'Likely EV buyers',
      description: 'Modeled audience for likely electric-vehicle purchase intent.',
      value_type: 'binary',
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        version: '1.0',
        values: [
          { id: 'auto.ev_intenders', path: 'Automotive > EV intenders' }
        ],
        parent_match_behavior: 'descendants_supported'
      },
      data_sources: ['web_usage', 'online_ecommerce'],
      methodology: 'modeled',
      audience_expansion: true,
      countries: ['US'],
      consent_basis: ['consent'],
      modeling: {
        method: 'lookalike',
        seed_source: {
          type: 'first_party_crm',
          provider_signed: true
        },
        training_data_jurisdictions: ['US'],
        ai_act_risk_class: 'limited',
        disclosure: {
          required: true,
          jurisdictions: [
            {
              country: 'US',
              region: 'CA',
              regulation: 'state_ai_disclosure',
              disclosure_text: 'Modeled audience segment.',
              audience: 'buyer'
            }
          ]
        }
      },
      data_subject_rights: {
        upstream_source_domain: 'signals.example.com',
        channels: [
          {
            rights: ['access', 'erasure', 'objection'],
            url: 'https://privacy.signals.example.com/requests',
            languages: ['en-US'],
            countries: ['US']
          }
        ],
        response_sla_days: 30,
        ccpa_opt_out_url: 'https://privacy.signals.example.com/opt-out'
      }
    },
    'Binary signal accepts taxonomy metadata, modeling disclosure, and channel-based DSR routing'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'panel_derived_households',
      name: 'Panel-derived households',
      description: 'Panel-derived TV audience signal where panel recruitment is part of the measurement methodology.',
      value_type: 'binary',
      data_sources: ['panel', 'tv_ott_or_stb_device'],
      methodology: 'derived',
      subject_type: 'household',
      resolution_method: 'mixed'
    },
    'Panel-derived signal accepts panel as a data source'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'legacy_categorical_without_values',
      name: 'Legacy categorical without values',
      value_type: 'categorical'
    },
    'Categorical signal can omit allowed_values for backwards-compatible minor release'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'legacy_numeric_without_range',
      name: 'Legacy numeric without range',
      value_type: 'numeric'
    },
    'Numeric signal can omit range for backwards-compatible minor release'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'vehicle_ownership',
      name: 'Current vehicle ownership',
      value_type: 'categorical',
      allowed_values: ['luxury_ev', 'luxury_non_ev', 'mid_range', 'economy', 'none'],
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        version: '1.0',
        values: [
          { id: 'auto.vehicle_ownership', path: 'Automotive > Vehicle ownership' }
        ],
        value_mappings: [
          {
            value: 'luxury_ev',
            taxonomy_value_id: 'auto.vehicle_ownership.luxury_ev',
            path: 'Automotive > Vehicle ownership > Luxury EV'
          },
          {
            value: 'luxury_non_ev',
            taxonomy_value_id: 'auto.vehicle_ownership.luxury_non_ev',
            path: 'Automotive > Vehicle ownership > Luxury non-EV'
          }
        ],
        parent_match_behavior: 'exact_only'
      }
    },
    'Categorical signal accepts taxonomy value mappings for allowed_values'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'taxonomy_as_type_rejected',
      name: 'Taxonomy as value type rejected',
      value_type: 'taxonomy',
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        values: [{ id: 'auto' }]
      }
    },
    'Rejects taxonomy as value_type; taxonomy belongs in signal-definition metadata'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'modeled_missing_block',
      name: 'Modeled missing block',
      value_type: 'binary',
      methodology: 'modeled'
    },
    'Rejects modeled methodology without modeling block'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'modeled_empty_training_jurisdictions',
      name: 'Modeled empty training jurisdictions',
      value_type: 'binary',
      methodology: 'modeled',
      modeling: {
        method: 'lookalike',
        seed_source: {
          type: 'first_party_crm',
          provider_signed: true
        },
        training_data_jurisdictions: [],
        ai_act_risk_class: 'limited'
      }
    },
    'Rejects modeled signal with empty training_data_jurisdictions'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'modeled_disclosure_missing_jurisdictions',
      name: 'Modeled disclosure missing jurisdictions',
      value_type: 'binary',
      methodology: 'modeled',
      modeling: {
        method: 'lookalike',
        seed_source: {
          type: 'first_party_crm',
          provider_signed: true
        },
        training_data_jurisdictions: ['US'],
        ai_act_risk_class: 'limited',
        disclosure: {
          required: true
        }
      }
    },
    'Rejects required modeling disclosure without jurisdictions'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'categorical_taxonomy_missing_mapping',
      name: 'Categorical taxonomy missing mapping',
      value_type: 'categorical',
      allowed_values: ['luxury_ev'],
      taxonomy: {
        ref: 'https://taxonomy.example.com/audience/v1',
        values: [{ id: 'auto.vehicle_ownership' }]
      }
    },
    'Rejects categorical taxonomy metadata without value_mappings'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'offline_missing_onboarder',
      name: 'Offline missing onboarder',
      value_type: 'binary',
      data_sources: ['offline_transaction']
    },
    'Rejects offline/public-record data source without onboarder disclosure'
  );
  await testSchemaValidation(
    '/schemas/core/signal-definition.json',
    {
      id: 'dsr_email_access_channel',
      name: 'DSR email access channel',
      value_type: 'binary',
      data_subject_rights: {
        channels: [
          {
            rights: ['access'],
            email: 'privacy@example.com'
          }
        ]
      }
    },
    'Accepts DSR routing with an email-only access channel'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'dsr_no_core_right',
      name: 'DSR without core right',
      value_type: 'binary',
      data_subject_rights: {
        channels: [
          {
            rights: ['portability'],
            email: 'privacy@example.com'
          }
        ]
      }
    },
    'Rejects DSR routing that declares no access, erasure, or objection channel'
  );
  await testSchemaRejection(
    '/schemas/core/signal-definition.json',
    {
      id: 'dsr_gpc_not_signal_level',
      name: 'DSR with signal-level GPC rejected',
      value_type: 'binary',
      data_subject_rights: {
        channels: [
          {
            rights: ['access'],
            email: 'privacy@example.com'
          }
        ],
        gpc_honored: true
      }
    },
    'Rejects signal-level gpc_honored in DSR routing'
  );
  log('');

  // cancellation_fee: rate/amount required by fee type (money-path integrity)
  log('Cancellation Policy Schema (fee-type conditionals):', 'info');
  await testSchemaValidation(
    '/schemas/core/cancellation-policy.json',
    {
      notice_period: { interval: 30, unit: 'days' },
      cancellation_fee: { type: 'percent_remaining', rate: 0.5 }
    },
    'Accepts percent_remaining fee carrying rate'
  );
  await testSchemaRejection(
    '/schemas/core/cancellation-policy.json',
    {
      notice_period: { interval: 30, unit: 'days' },
      cancellation_fee: { type: 'percent_remaining' }
    },
    'Rejects percent_remaining fee missing rate'
  );
  await testSchemaValidation(
    '/schemas/core/cancellation-policy.json',
    {
      notice_period: { interval: 30, unit: 'days' },
      cancellation_fee: { type: 'fixed_fee', amount: 2500 }
    },
    'Accepts fixed_fee carrying amount'
  );
  await testSchemaRejection(
    '/schemas/core/cancellation-policy.json',
    {
      notice_period: { interval: 30, unit: 'days' },
      cancellation_fee: { type: 'fixed_fee' }
    },
    'Rejects fixed_fee missing amount'
  );
  await testSchemaValidation(
    '/schemas/core/cancellation-policy.json',
    {
      notice_period: { interval: 30, unit: 'days' },
      cancellation_fee: { type: 'none' }
    },
    'Accepts none fee with neither rate nor amount'
  );
  log('');

  // daily_budget_cap follows the aggregate/package budget hierarchy (#5983)
  log('Daily budget cap hierarchy:', 'info');
  await testSchemaValidation(
    '/schemas/media-buy/package-request.json',
    {
      product_id: 'prod_ctv_sports',
      pricing_option_id: 'po_cpm_fixed',
      budget: 50000,
      pacing: 'asap',
      daily_budget_cap: 2500
    },
    'Accepts a subordinate package daily cap with asap pacing'
  );
  await testSchemaRejection(
    '/schemas/media-buy/package-request.json',
    {
      product_id: 'prod_ctv_sports',
      pricing_option_id: 'po_cpm_fixed',
      budget: 50000,
      daily_budget_cap: -100
    },
    'Rejects negative daily_budget_cap'
  );
  await testSchemaRejection(
    '/schemas/media-buy/package-request.json',
    {
      product_id: 'prod_ctv_sports',
      pricing_option_id: 'po_cpm_fixed',
      budget: 50000,
      budget_cap_timezone: 'America/Chicago'
    },
    'Rejects package-specific cap timezone overrides'
  );
  await testSchemaValidation(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_001',
      daily_budget_cap: null
    },
    'Accepts removing a package daily cap'
  );
  await testSchemaValidation(
    '/schemas/core/package.json',
    {
      package_id: 'pkg_001',
      product_id: 'prod_ctv_sports',
      budget: 50000,
      daily_budget_cap: 2500
    },
    'Package readback carries the subordinate daily cap without its own timezone'
  );
  await testSchemaValidation(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'daily-cap-create-0001',
      account: { account_id: 'acc_daily_cap' },
      brand: { domain: 'example.com' },
      packages: [{
        product_id: 'prod_ctv_sports',
        pricing_option_id: 'po_cpm_fixed',
        budget: 50000,
        daily_budget_cap: 2500
      }],
      daily_budget_cap: 4000,
      budget_cap_timezone: 'America/Chicago',
      start_time: '2099-08-01T00:00:00Z',
      end_time: '2099-08-31T23:59:59Z'
    },
    'Accepts aggregate and subordinate package daily caps with one shared timezone'
  );
  await testSchemaRejection(
    '/schemas/media-buy/create-media-buy-request.json',
    {
      idempotency_key: 'daily-cap-create-0002',
      account: { account_id: 'acc_daily_cap' },
      brand: { domain: 'example.com' },
      packages: [{
        product_id: 'prod_ctv_sports',
        pricing_option_id: 'po_cpm_fixed',
        budget: 50000
      }],
      daily_budget_cap: -1,
      start_time: '2099-08-01T00:00:00Z',
      end_time: '2099-08-31T23:59:59Z'
    },
    'Rejects a negative aggregate daily cap'
  );
  await testSchemaValidation(
    '/schemas/media-buy/update-media-buy-request.json',
    {
      idempotency_key: 'daily-cap-update-0001',
      account: { account_id: 'acc_daily_cap' },
      media_buy_id: 'mb_daily_cap',
      daily_budget_cap: null,
      budget_cap_timezone: null
    },
    'Accepts removing the aggregate cap and timezone override'
  );
  await testSchemaValidation(
    '/schemas/media-buy/buy-products-request.json',
    {
      idempotency_key: 'daily-cap-buy-products-0001',
      account: { account_id: 'acc_daily_cap' },
      brand: { domain: 'example.com' },
      feed_version: 'feed-daily-cap-1',
      purchases: [{
        product_id: 'prod_ctv_sports',
        pricing_option_id: 'po_cpm_fixed',
        budget: 50000,
        daily_budget_cap: 2500
      }],
      daily_budget_cap: 4000,
      budget_cap_timezone: 'America/Chicago',
      start_time: 'asap',
      end_time: '2099-08-31T23:59:59Z'
    },
    'Compact direct purchase carries aggregate and purchase daily caps'
  );
  await testSchemaValidation(
    '/schemas/media-buy/control-media-buy-request.json',
    {
      idempotency_key: 'daily-cap-control-0001',
      account: { account_id: 'acc_daily_cap' },
      media_buy_id: 'mb_daily_cap',
      revision: 4,
      daily_budget_cap: null,
      budget_cap_timezone: null,
      packages: [{ package_id: 'pkg_001', daily_budget_cap: null }]
    },
    'Compact control removes aggregate and package caps atomically'
  );
  await testSchemaValidation(
    '/schemas/media-buy/accept-proposal-request.json',
    {
      idempotency_key: 'daily-cap-accept-0001',
      account: { account_id: 'acc_daily_cap' },
      proposal_id: 'proposal_daily_cap',
      proposal_terms_digest: 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      daily_budget_cap: 4000,
      budget_cap_timezone: 'America/Chicago'
    },
    'Compact proposal acceptance can set the aggregate execution cap'
  );
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      status: 'completed',
      adcp: {
        major_versions: [3],
        idempotency: { supported: false }
      },
      supported_protocols: ['media_buy'],
      media_buy: {
        budget_capping: {
          supported_scopes: ['media_buy', 'package'],
          supported_periods: ['day'],
          timezone_basis: 'account',
          buyer_timezone_override: true
        }
      }
    },
    'Accepts hard daily-cap capabilities based on each account timezone'
  );
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      status: 'completed',
      adcp: {
        major_versions: [3],
        idempotency: { supported: false }
      },
      supported_protocols: ['media_buy'],
      media_buy: {
        budget_capping: {
          supported_scopes: ['media_buy'],
          supported_periods: ['day'],
          timezone_basis: 'fixed',
          fixed_timezone: 'UTC'
        }
      }
    },
    'Accepts a seller-fixed daily-cap timezone such as UTC'
  );
  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      status: 'completed',
      adcp: {
        major_versions: [3],
        idempotency: { supported: false }
      },
      supported_protocols: ['media_buy'],
      media_buy: {
        budget_capping: {
          supported_scopes: ['media_buy'],
          supported_periods: ['day'],
          timezone_basis: 'fixed'
        }
      }
    },
    'Rejects a fixed daily-cap basis without fixed_timezone'
  );
  await testSchemaRejection(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    {
      status: 'completed',
      adcp: {
        major_versions: [3],
        idempotency: { supported: false }
      },
      supported_protocols: ['media_buy'],
      media_buy: {
        budget_capping: {
          supported_scopes: ['media_buy'],
          supported_periods: ['day'],
          timezone_basis: 'account',
          fixed_timezone: 'UTC'
        }
      }
    },
    'Rejects fixed_timezone when daily caps use the account timezone'
  );
  log('');

  // Test 7: Bundled schemas (no $ref resolution needed)
  // Only test against latest/ — versioned dirs in dist/ may be from a prior release
  // and are not updated on every source change.
  const BUNDLED_DIR = path.join(__dirname, '../dist/schemas');
  const latestBundledPath = path.join(BUNDLED_DIR, 'latest', 'bundled');
  const bundledPath = fs.existsSync(latestBundledPath) ? latestBundledPath : null;

  if (bundledPath && fs.existsSync(bundledPath)) {
      log('Bundled Schemas (no $ref resolution needed):', 'info');

      // Test bundled schema validation WITHOUT custom loadSchema
      // This proves bundled schemas are truly self-contained
      await testBundledSchemaValidation(
        path.join(bundledPath, 'media-buy/create-media-buy-request.json'),
        {
          idempotency_key: '550e8400-e29b-41d4-a716-446655440042',
          account: { account_id: 'acc_test_001' },
          packages: [
            {
              product_id: 'ctv_premium',
              budget: 50000,
              pricing_option_id: 'cpm_standard'
            }
          ],
          brand: {
            domain: 'acmecorp.com'
          },
          start_time: 'asap',
          end_time: '2024-12-31T23:59:59Z'
        },
        'Bundled create-media-buy-request (no ref resolution)'
      );

      // Regression for #2648: bundled schemas that carry local `#/$defs/...`
      // pointers (format.json, policy-entry.json, artifact.json) must compile
      // with a vanilla Ajv — i.e. the bundler must hoist nested `$defs` to
      // the document root.
      await testBundledSchemaCompile(
        path.join(bundledPath, 'media-buy/list-creative-formats-response.json'),
        'Bundled list-creative-formats-response (media-buy) compiles — #2648'
      );
      await testBundledSchemaCompile(
        path.join(bundledPath, 'creative/list-creative-formats-response.json'),
        'Bundled list-creative-formats-response (creative) compiles — #2648'
      );
      await testBundledSchemaCompile(
        path.join(bundledPath, 'content-standards/list-content-standards-response.json'),
        'Bundled list-content-standards-response compiles — #2648'
      );

      // Every bundled schema must be self-contained and compile standalone.
      await testAllBundledSchemasCompile(bundledPath);

      await testBundledDeliveryMetricSchemaTitles(BUNDLED_DIR);

      // Test a response schema to verify nested refs are resolved
      await testBundledSchemaValidation(
        path.join(bundledPath, 'media-buy/get-products-response.json'),
        {
          status: 'completed',
          cache_scope: 'public',
          products: [
            {
              product_id: 'test_product',
              name: 'Test Product',
              description: 'A test product',
              publisher_properties: [
                {
                  publisher_domain: 'example.com',
                  selection_type: 'all'
                }
              ],
              format_ids: [{ agent_url: 'https://creative.example.com', id: 'video_30s' }],
              delivery_type: 'guaranteed',
              delivery_measurement: {
                provider: 'Google Ad Manager'
              },
              pricing_options: [
                {
                  pricing_option_id: 'cpm_standard',
                  pricing_model: 'cpm',
                  rate: 25.0,
                  currency: 'USD',
                  is_fixed: true
                }
              ],
              reporting_capabilities: {
                available_reporting_frequencies: ['daily'],
                expected_delay_minutes: 240,
                timezone: 'UTC',
                supports_webhooks: false,
                available_metrics: ['impressions', 'spend', 'clicks'],
                date_range_support: 'date_range'
              }
            }
          ]
        },
        'Bundled get-products-response (no ref resolution)'
      );

      log('');
  } else {
    log('');
    log('Bundled Schemas:', 'warning');
    log('  (skipped - run npm run build:schemas first to generate bundled schemas)', 'warning');
    log('');
  }

  log('Native Creative Localization Schemas:', 'info');
  const localizedCreative = {
    creative_id: 'summer_image_localized',
    name: 'Summer image — localized',
    format_kind: 'image',
    assets: {
      image: {
        asset_type: 'image',
        url: 'https://cdn.nova.example/summer-en.jpg',
        width: 1080,
        height: 1080
      },
      headline: {
        asset_type: 'text',
        content: 'Summer starts here',
        language: 'en-US'
      }
    },
    localization: {
      source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
      target_variants: [
        {
          locale_variant_id: 'loc_es_es',
          locale: 'es-ES',
          assets: {
            headline: {
              asset_type: 'text',
              content: 'El verano empieza aquí',
              language: 'es-ES'
            }
          }
        }
      ],
      locale_fallbacks: [
        { language_range: 'es', locale_variant_id: 'loc_es_es' }
      ],
      default_locale_variant_id: 'loc_en_us',
      unmatched_locale_action: 'do_not_serve'
    }
  };
  const localizedSyncRequest = (creative) => ({
    idempotency_key: '550e8400-e29b-41d4-a716-446655440099',
    account: { account_id: 'acct_nova_localization' },
    creatives: [creative]
  });

  await testSchemaValidation(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest(localizedCreative),
    'sync_creatives accepts explicit buyer-supplied locale variants'
  );

  const frenchSourceOnlyCreative = {
    ...structuredClone(localizedCreative),
    creative_id: 'quebec_image_fr_ca',
    name: 'Québec image — French',
    assets: {
      ...structuredClone(localizedCreative.assets),
      headline: {
        asset_type: 'text',
        content: 'L’été commence ici',
        language: 'fr-CA'
      }
    },
    localization: {
      source: { locale_variant_id: 'loc_fr_ca', locale: 'fr-CA' },
      target_variants: [],
      default_locale_variant_id: 'loc_fr_ca',
      unmatched_locale_action: 'serve_default'
    }
  };
  await testSchemaValidation(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest(frenchSourceOnlyCreative),
    'sync_creatives accepts source-only locale topology for a monolingual creative'
  );
  testSemanticValidation(
    validateLocalizationRequestSemantics(
      frenchSourceOnlyCreative.localization,
      frenchSourceOnlyCreative.assets
    ),
    undefined,
    'Source-only localization semantic verifier accepts an empty target set'
  );

  testValidationAnnotation(
    '/schemas/core/locale-tag.json',
    {
      well_formed: 'rfc5646',
      semantic_scope: 'language_identity_only',
      canonical_wire_profile: 'adcp_bcp47_casing',
      rfc5646_comparison: 'case_insensitive',
      non_profile: 'reject'
    },
    'Locale tags expose the stricter AdCP canonical wire profile'
  );

  await testSchemaValidation(
    '/schemas/core/locale-tag.json',
    'x-private',
    'Locale tag schema accepts canonical private-use tags'
  );
  for (const invalidLocale of ['EN-us', 'en-us', 'en-a']) {
    await testSchemaRejection(
      '/schemas/core/locale-tag.json',
      invalidLocale,
      `Locale tag schema rejects non-canonical or malformed ${invalidLocale}`
    );
  }

  testValidationAnnotation(
    '/schemas/core/localized-creative-asset.json',
    {
      language_asset_types: ['text', 'markdown'],
      language_when_present: {
        schema: '/schemas/core/locale-tag.json',
        must_equal: 'enclosing_variant.locale'
      },
      language_omitted: 'no_asset_language_claim'
    },
    'Localized assets expose contextual text and markdown language rules'
  );
  await testSchemaValidation(
    '/schemas/core/localized-creative-asset.json',
    {
      asset_type: 'markdown',
      content: '**Bonjour**',
      language: 'fr-CA'
    },
    'Localized markdown accepts an AdCP-profile language tag'
  );
  await testSchemaRejection(
    '/schemas/core/localized-creative-asset.json',
    {
      asset_type: 'text',
      content: 'Bonjour',
      language: 'fr_CA'
    },
    'Localized text rejects a legacy underscore language key'
  );

  const nonCanonicalFallbackRange = structuredClone(localizedCreative);
  nonCanonicalFallbackRange.localization.locale_fallbacks[0].language_range = 'ES';
  await testSchemaRejection(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest(nonCanonicalFallbackRange),
    'Localization fallback rejects a non-canonical language range'
  );

  await testSchemaRejection(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest({
      ...localizedCreative,
      localization: {
        source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
        target_variants: [
          {
            locale_variant_id: 'loc_fr_fr',
            locale: 'fr-FR',
            translation_mode: 'provider_generated',
            assets: localizedCreative.localization.target_variants[0].assets
          }
        ],
        default_locale_variant_id: 'loc_en_us',
        unmatched_locale_action: 'serve_default'
      }
    }),
    'sync_creatives rejects provider-generated translation requests'
  );

  testValidationAnnotation(
    '/schemas/core/creative-localization.json',
    {
      unique_target_properties: ['locale_variant_id', 'locale'],
      target_properties_disjoint_from_source: ['locale_variant_id', 'locale'],
      default_locale_variant_id: 'must_reference_exactly_one_source_or_target_variant',
      locale_matching: 'rfc4647_lookup',
      locale_match_comparison: 'canonical_tag_equality_after_requested_range_truncation',
      delivery_locale_preferences: 'ordered_external_input_not_defined_by_adcp',
      unique_locale_fallback_properties: ['language_range'],
      locale_fallback_variant_ids: 'must_reference_exactly_one_source_or_target_variant',
      selection_order:
        'for_each_preference_strict_lookup_then_most_specific_explicit_fallback_then_next_preference_then_unmatched_action',
      localized_asset_language: {
        asset_types: ['text', 'markdown'],
        when_present: 'must_equal_enclosing_variant.locale',
        omitted: 'no_asset_language_claim'
      },
      replacement_atomicity: 'all_or_prior_state_unchanged',
      request_sync_list_round_trip: {
        source_match: { role: 'source' },
        source_equal_properties: ['locale_variant_id', 'locale'],
        target_match_key: 'locale_variant_id',
        target_set: 'exact',
        target_equal_properties: ['locale'],
        localization_equal_properties: [
          'default_locale_variant_id',
          'unmatched_locale_action',
          'locale_fallbacks'
        ]
      }
    },
    'Localization request exposes machine-readable locale and identity uniqueness rules'
  );

  testNestedValidationAnnotation(
    '/schemas/creative/sync-creatives-request.json',
    ['properties', 'creatives', 'items'],
    {
      localization_capability_gate: {
        required_capability: 'creative.localization',
        target_count_ceiling: 'creative.localization.max_target_variants_or_50',
        locale_format_account_support: 'validate_request_before_mutation',
        on_violation: 'reject_before_mutation'
      },
      existing_localized_source_upsert: {
        localization_omitted: 'top_level_assets_must_equal_prior_source_assets',
        source_assets_changed: 'require_non_null_localization_or_null_removal',
        on_violation: 'reject_before_mutation'
      },
      localization_replacement: {
        scope: 'top_level_assets_and_complete_localization',
        on_failure: 'prior_state_unchanged',
        orphan_locale_variants: 'must_not_be_visible'
      }
    },
    'sync_creatives exposes machine-readable fail-closed localized source upsert rules'
  );
  testNestedValidationAnnotation(
    '/schemas/creative/sync-creatives-request.json',
    ['properties', 'assignments', 'items'],
    {
      product_format_locale_policy: {
        scope:
          'every_effective_product_and_placement_format_option_where_assignment_may_serve',
        range_matching: 'rfc4647_basic_filtering',
        eligible_variant_set: 'filter_before_buyer_lookup_fallback_or_default',
        minimum_eligible_variants_per_scope: 1,
        serve_default: 'default_locale_variant_id_must_be_eligible',
        policy_lifecycle: 'snapshot_effective_policy_at_assignment_acceptance',
        on_violation: 'CREATIVE_LOCALE_NOT_ACCEPTED'
      }
    },
    'sync_creatives assignments expose per-placement locale eligibility rules'
  );

  testSemanticValidation(
    validateLocalizationRequestSemantics(localizedCreative.localization, localizedCreative.assets),
    undefined,
    'Localization request semantic verifier accepts unique source and target identities'
  );

  const mismatchedTargetAssetLanguage = structuredClone(localizedCreative);
  mismatchedTargetAssetLanguage.localization.target_variants[0].assets.headline.language = 'es-MX';
  await testSchemaValidation(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest(mismatchedTargetAssetLanguage),
    'Localized sync schema accepts a well-formed asset tag for semantic comparison'
  );
  testSemanticValidation(
    validateLocalizationRequestSemantics(
      mismatchedTargetAssetLanguage.localization,
      mismatchedTargetAssetLanguage.assets
    ),
    'asset headline language must equal enclosing variant locale',
    'Localization verifier rejects asset language that contradicts its variant locale'
  );

  const nonProfileSourceAssetLanguage = structuredClone(localizedCreative);
  nonProfileSourceAssetLanguage.assets.headline.language = 'en_US';
  await testSchemaValidation(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest(nonProfileSourceAssetLanguage),
    'Legacy top-level text schema remains backwards compatible'
  );
  testSemanticValidation(
    validateLocalizationRequestSemantics(
      nonProfileSourceAssetLanguage.localization,
      nonProfileSourceAssetLanguage.assets
    ),
    'asset headline language must use the AdCP canonical wire profile',
    'Localized source verifier rejects a legacy underscore asset language key'
  );

  for (const [property, duplicateValue] of [
    ['locale', 'es-ES'],
    ['locale_variant_id', 'loc_es_es']
  ]) {
    const duplicateTargets = structuredClone(localizedCreative.localization);
    duplicateTargets.target_variants.push({
      locale_variant_id: 'loc_fr_fr',
      locale: 'fr-FR',
      assets: localizedCreative.localization.target_variants[0].assets,
      [property]: duplicateValue
    });
    testSemanticValidation(
      validateLocalizationRequestSemantics(duplicateTargets),
      `target ${property} values must be unique`,
      `Localization request semantic verifier rejects duplicate target ${property}`
    );
  }

  for (const property of ['locale', 'locale_variant_id']) {
    const sourceCollision = structuredClone(localizedCreative.localization);
    sourceCollision.target_variants[0][property] = sourceCollision.source[property];
    testSemanticValidation(
      validateLocalizationRequestSemantics(sourceCollision),
      `target ${property} must differ from source ${property}`,
      `Localization request semantic verifier rejects source/target ${property} reuse`
    );
  }

  const duplicateFallbackRange = structuredClone(localizedCreative.localization);
  duplicateFallbackRange.locale_fallbacks.push({
    language_range: 'es',
    locale_variant_id: 'loc_en_us'
  });
  testSemanticValidation(
    validateLocalizationRequestSemantics(duplicateFallbackRange),
    'locale fallback language_range values must be unique',
    'Localization request verifier rejects duplicate fallback language ranges'
  );

  const danglingFallback = structuredClone(localizedCreative.localization);
  danglingFallback.locale_fallbacks[0].locale_variant_id = 'loc_missing';
  testSemanticValidation(
    validateLocalizationRequestSemantics(danglingFallback),
    'locale fallback must reference a source or target variant',
    'Localization request verifier rejects a dangling fallback variant ID'
  );

  await testSchemaRejection(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest({
      ...localizedCreative,
      localization: {
        source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
        target_variants: [
          {
            locale_variant_id: 'loc_es_es',
            locale: 'es-ES'
          }
        ],
        default_locale_variant_id: 'loc_en_us',
        unmatched_locale_action: 'serve_default'
      }
    }),
    'Materialized target without overrides is rejected'
  );

  await testSchemaRejection(
    '/schemas/creative/sync-creatives-request.json',
    localizedSyncRequest({
      ...localizedCreative,
      localization: {
        source: { locale_variant_id: 'loc_en_us', locale: 'en-US' },
        target_variants: [
          {
            locale_variant_id: 'loc_es_es',
            locale: 'es-ES',
            translation_mode: 'provider_generated',
            assets: {
              headline: {
                asset_type: 'text',
                content: 'Ambiguous supplied copy'
              }
            }
          }
        ],
        default_locale_variant_id: 'loc_en_us',
        unmatched_locale_action: 'serve_default'
      }
    }),
    'Legacy provider-generated mode is rejected even when assets are present'
  );

  await testSchemaRejection(
    '/schemas/media-buy/package-request.json',
    {
      product_id: 'social_reach',
      budget: 1000,
      pricing_option_id: 'cpm_standard',
      creatives: [localizedCreative]
    },
    'create_media_buy inline creatives reject localization requests'
  );

  await testSchemaRejection(
    '/schemas/media-buy/package-update.json',
    {
      package_id: 'pkg_social_reach',
      creatives: [localizedCreative]
    },
    'update_media_buy inline creatives reject localization requests'
  );

  const localizationReadback = {
    default_locale_variant_id: 'loc_en_us',
    unmatched_locale_action: 'do_not_serve',
    locale_matching: 'rfc4647_lookup',
    locale_fallbacks: [
      { language_range: 'es', locale_variant_id: 'loc_es_es' }
    ],
    variants: [
      {
        locale_variant_id: 'loc_en_us',
        locale: 'en-US',
        role: 'source',
        assets: localizedCreative.assets
      },
      {
        locale_variant_id: 'loc_es_es',
        locale: 'es-ES',
        role: 'target',
        assets: {
          ...localizedCreative.assets,
          headline: {
            asset_type: 'text',
            content: 'El verano empieza aquí',
            language: 'es-ES'
          }
        }
      }
    ]
  };

  await testSchemaValidation(
    '/schemas/core/creative-localization-readback.json',
    localizationReadback,
    'Exact source and target localization readback validates'
  );

  const frenchSourceOnlyReadback = {
    default_locale_variant_id: 'loc_fr_ca',
    unmatched_locale_action: 'serve_default',
    locale_matching: 'rfc4647_lookup',
    variants: [
      {
        locale_variant_id: 'loc_fr_ca',
        locale: 'fr-CA',
        role: 'source',
        assets: frenchSourceOnlyCreative.assets
      }
    ]
  };
  await testSchemaValidation(
    '/schemas/core/creative-localization-readback.json',
    frenchSourceOnlyReadback,
    'Localization readback accepts one source-only monolingual variant'
  );
  testSemanticValidation(
    validateLocalizationReadbackSemantics(
      frenchSourceOnlyReadback,
      frenchSourceOnlyCreative.assets
    ),
    undefined,
    'Source-only localization readback verifier accepts one source role'
  );
  const frenchLocalePolicy = { accepted_language_ranges: ['fr'] };
  testSemanticValidation(
    validateLocalePolicyAssignment(frenchSourceOnlyReadback, frenchLocalePolicy),
    undefined,
    'French-only format accepts a source-only fr-CA creative'
  );
  testSemanticValidation(
    validateLocalePolicyAssignment(localizationReadback, frenchLocalePolicy),
    'at least one materialized variant must match accepted language ranges',
    'French-only format rejects a creative with no French variant'
  );
  const spanishLocalePolicy = { accepted_language_ranges: ['es'] };
  testSemanticValidation(
    validateLocalePolicyAssignment(localizationReadback, spanishLocalePolicy),
    undefined,
    'Spanish-only format accepts a mixed creative with an eligible Spanish variant'
  );
  const ineligibleDefaultReadback = {
    ...structuredClone(localizationReadback),
    unmatched_locale_action: 'serve_default'
  };
  testSemanticValidation(
    validateLocalePolicyAssignment(ineligibleDefaultReadback, spanishLocalePolicy),
    'serve_default must reference a seller-eligible locale variant',
    'Locale-constrained format rejects serve_default outside its eligible variant set'
  );
  testSemanticValidation(
    selectLocalizedVariant(
      localizationReadback,
      ['en-US', 'es-ES'],
      spanishLocalePolicy
    ) === 'loc_es_es'
      ? []
      : ['Seller locale policy did not mask the ineligible English variant'],
    undefined,
    'Seller locale policy filters variants before buyer locale selection'
  );
  const fallbackOutsideSellerPolicy = structuredClone(localizationReadback);
  fallbackOutsideSellerPolicy.locale_fallbacks[0].locale_variant_id = 'loc_en_us';
  testSemanticValidation(
    selectLocalizedVariant(
      fallbackOutsideSellerPolicy,
      ['es-MX'],
      spanishLocalePolicy
    ) === undefined
      ? []
      : ['Buyer fallback escaped the seller-eligible variant set'],
    undefined,
    'Buyer locale fallback cannot select a seller-ineligible variant'
  );

  testValidationAnnotation(
    '/schemas/core/creative-localization-readback.json',
    {
      unique_variant_properties: ['locale_variant_id', 'locale'],
      exact_role_counts: { source: 1 },
      default_locale_variant_id: 'must_reference_exactly_one_variant',
      source_assets: 'must_equal_enclosing_creative.assets',
      locale_matching: 'rfc4647_lookup',
      locale_match_comparison: 'canonical_tag_equality_after_requested_range_truncation',
      delivery_locale_preferences: 'ordered_external_input_not_defined_by_adcp',
      unique_locale_fallback_properties: ['language_range'],
      locale_fallback_variant_ids: 'must_reference_exactly_one_variant',
      selection_order:
        'for_each_preference_strict_lookup_then_most_specific_explicit_fallback_then_next_preference_then_unmatched_action',
      localized_asset_language: {
        asset_types: ['text', 'markdown'],
        when_present: 'must_equal_enclosing_variant.locale',
        omitted: 'no_asset_language_claim'
      }
    },
    'Localization readback exposes machine-readable exactness rules'
  );

  testTypedDiscriminatedUnion(
    '/schemas/core/creative-localization-readback.json',
    ['properties', 'variants', 'items'],
    'role',
    [
      { role: 'source' },
      { role: 'target' }
    ],
    'Localization readback emits typed source/target union arms'
  );

  const syncRoundTripConstraints = {
    lifecycle_source: 'enclosing_creative.status',
    source_assets: 'must_equal_request_creative.assets'
  };
  testNestedValidationAnnotation(
    '/schemas/creative/sync-creatives-response.json',
    ['oneOf', 0, 'properties', 'creatives', 'items', 'properties', 'localization'],
    syncRoundTripConstraints,
    'Sync response exposes machine-readable creative-wide localization rules'
  );
  testNestedValidationAnnotation(
    '/schemas/creative/list-creatives-response.json',
    ['properties', 'creatives', 'items', 'properties', 'localization'],
    {
      lifecycle_source: 'enclosing_creative.status',
      source_assets: 'must_equal_enclosing_creative.assets'
    },
    'List response exposes machine-readable creative-wide localization rules'
  );

  testSemanticValidation(
    validateLocalizationReadbackSemantics(localizationReadback, localizedCreative.assets),
    undefined,
    'Localization readback verifier accepts exact roles, identities, default, and source assets'
  );

  const mismatchedReadbackAssetLanguage = structuredClone(localizationReadback);
  mismatchedReadbackAssetLanguage.variants[1].assets.headline.language = 'es-MX';
  testSemanticValidation(
    validateLocalizationReadbackSemantics(
      mismatchedReadbackAssetLanguage,
      localizedCreative.assets
    ),
    'asset headline language must equal enclosing variant locale',
    'Localization readback verifier rejects contradictory asset language metadata'
  );

  for (const role of ['target', 'source']) {
    const invalidRoles = structuredClone(localizationReadback);
    invalidRoles.variants = invalidRoles.variants.map((variant) => ({ ...variant, role }));
    testSemanticValidation(
      validateLocalizationReadbackSemantics(invalidRoles),
      'exactly one source variant',
      `Localization readback verifier rejects ${role === 'target' ? 'zero' : 'multiple'} source roles`
    );
  }

  for (const property of ['locale_variant_id', 'locale']) {
    const duplicateReadback = structuredClone(localizationReadback);
    duplicateReadback.variants[1][property] = duplicateReadback.variants[0][property];
    testSemanticValidation(
      validateLocalizationReadbackSemantics(duplicateReadback),
      `variant ${property} values must be unique`,
      `Localization readback verifier rejects duplicate ${property}`
    );
  }

  const missingDefault = structuredClone(localizationReadback);
  missingDefault.default_locale_variant_id = 'loc_missing';
  testSemanticValidation(
    validateLocalizationReadbackSemantics(missingDefault, localizedCreative.assets),
    'default_locale_variant_id must reference exactly one variant',
    'Localization verifier rejects a dangling default locale variant'
  );

  const danglingReadbackFallback = structuredClone(localizationReadback);
  danglingReadbackFallback.locale_fallbacks[0].locale_variant_id = 'loc_missing';
  testSemanticValidation(
    validateLocalizationReadbackSemantics(danglingReadbackFallback, localizedCreative.assets),
    'locale fallback must reference exactly one variant',
    'Localization readback verifier rejects a dangling fallback variant ID'
  );

  const driftedSourceAssets = structuredClone(localizationReadback);
  driftedSourceAssets.variants[0].assets.headline.content = 'Drifted source';
  testSemanticValidation(
    validateLocalizationReadbackSemantics(driftedSourceAssets, localizedCreative.assets),
    'source localization assets must equal enclosing creative assets',
    'Localization verifier rejects source asset drift'
  );

  testSemanticValidation(
    selectLocalizedVariant(localizationReadback, ['es-ES']) === 'loc_es_es'
      ? []
      : ['RFC 4647 Lookup did not select the equal es-ES tag'],
    undefined,
    'RFC 4647 Lookup selects an equal available target'
  );
  testSemanticValidation(
    rfc4647Lookup(['es-MX'], localizationReadback.variants) === undefined
      ? []
      : ['RFC 4647 Lookup prefix-matched sibling es-ES'],
    undefined,
    'RFC 4647 Lookup does not prefix-match a sibling regional locale'
  );
  const mexicanSpanishFallback = structuredClone(localizationReadback);
  mexicanSpanishFallback.variants[1].locale_variant_id = 'loc_es_mx';
  mexicanSpanishFallback.variants[1].locale = 'es-MX';
  mexicanSpanishFallback.locale_fallbacks[0].locale_variant_id = 'loc_es_mx';
  testSemanticValidation(
    selectLocalizedVariant(mexicanSpanishFallback, ['es-ES']) === 'loc_es_mx'
      ? []
      : ['Explicit es fallback did not select loc_es_mx'],
    undefined,
    'Explicit language-family fallback allows es-ES to use es-MX'
  );
  testSemanticValidation(
    selectLocalizedVariant(localizationReadback, ['es-MX', 'en-US']) === 'loc_es_es'
      ? []
      : ['Lower-priority exact English match bypassed higher-priority Spanish fallback'],
    undefined,
    'Explicit fallback for a preferred locale wins before the next locale preference'
  );

  const noFamilyFallback = structuredClone(localizationReadback);
  delete noFamilyFallback.locale_fallbacks;
  testSemanticValidation(
    selectLocalizedVariant(noFamilyFallback, ['es-MX']) === undefined
      ? []
      : ['Regional substitution occurred without an explicit fallback rule'],
    undefined,
    'Sibling regional locales are not substituted without an explicit fallback rule'
  );

  const fallbackReadback = { ...localizationReadback, unmatched_locale_action: 'serve_default' };
  testSemanticValidation(
    selectLocalizedVariant(fallbackReadback, ['fr-CA']) === 'loc_en_us'
      ? []
      : ['serve_default did not select default_locale_variant_id'],
    undefined,
    'Unmatched serve_default selects the explicit default rather than source implicitly'
  );
  testSemanticValidation(
    selectLocalizedVariant(localizationReadback, ['fr-CA']) === undefined
      ? []
      : ['do_not_serve returned a locale variant'],
    undefined,
    'Unmatched do_not_serve returns no eligible locale variant'
  );

  const localizedSyncItem = {
    creative_id: localizedCreative.creative_id,
    action: 'created',
    status: 'pending_review',
    localization: localizationReadback
  };
  const localizedListItem = {
    creative_id: localizedCreative.creative_id,
    name: localizedCreative.name,
    format_id: {
      agent_url: 'https://creative.example.com',
      id: 'localized_image'
    },
    status: 'pending_review',
    created_date: '2026-07-19T10:00:00Z',
    updated_date: '2026-07-19T10:00:00Z',
    assets: localizedCreative.assets,
    localization: localizationReadback
  };

  testSemanticValidation(
    validateLocalizationRoundTrip(
      localizedCreative.localization,
      localizedSyncItem,
      localizedListItem
    ),
    undefined,
    'Localization verifier accepts exact request to sync to list round trip'
  );

  for (const [surface, mutate, expectedError] of [
    [
      'sync source identity',
      (syncItem) => {
        syncItem.localization.variants[0].locale_variant_id = 'loc_en_gb';
      },
      'sync source locale_variant_id must equal request'
    ],
    [
      'list source locale',
      (_syncItem, listItem) => {
        listItem.localization.variants[0].locale = 'en-GB';
      },
      'list source locale must equal request'
    ],
    [
      'sync target identity set',
      (syncItem) => {
        syncItem.localization.variants[1].locale_variant_id = 'loc_fr_fr';
      },
      'sync target locale_variant_id set must exactly equal request'
    ],
    [
      'list target locale',
      (_syncItem, listItem) => {
        listItem.localization.variants[1].locale = 'es-MX';
      },
      'list target locale must equal request'
    ],
    [
      'sync default locale',
      (syncItem) => {
        syncItem.localization.default_locale_variant_id = 'loc_es_es';
      },
      'sync default_locale_variant_id must equal request'
    ],
    [
      'list fallback mapping',
      (_syncItem, listItem) => {
        listItem.localization.locale_fallbacks[0].locale_variant_id = 'loc_en_us';
      },
      'list locale_fallbacks must exactly equal request'
    ]
  ]) {
    const syncItem = structuredClone(localizedSyncItem);
    const listItem = structuredClone(localizedListItem);
    mutate(syncItem, listItem);
    testSemanticValidation(
      validateLocalizationRoundTrip(localizedCreative.localization, syncItem, listItem),
      expectedError,
      `Localization verifier rejects ${surface} drift`
    );
  }

  await testSchemaValidation(
    '/schemas/creative/sync-creatives-response.json',
    { status: 'completed', creatives: [localizedSyncItem] },
    'Accepted localized sync result includes creative status and complete readback'
  );

  const localizedSyncWithoutStatus = structuredClone(localizedSyncItem);
  delete localizedSyncWithoutStatus.status;
  await testSchemaRejection(
    '/schemas/creative/sync-creatives-response.json',
    { status: 'completed', creatives: [localizedSyncWithoutStatus] },
    'Accepted localized sync result without creative status is rejected'
  );

  for (const action of ['failed', 'deleted']) {
    await testSchemaRejection(
      '/schemas/creative/sync-creatives-response.json',
      {
        status: 'completed',
        creatives: [
          {
            creative_id: localizedCreative.creative_id,
            action,
            localization: localizationReadback
          }
        ]
      },
      `${action} sync result cannot leak localization readback`
    );
  }

  await testSchemaValidation(
    '/schemas/creative/list-creatives-response.json',
    {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [localizedListItem]
    },
    'list_creatives returns complete localized state using buyer-assigned identities'
  );

  const unavailableLocalizedListItem = structuredClone(localizedListItem);
  delete unavailableLocalizedListItem.localization;
  unavailableLocalizedListItem.localization_unavailable = {
    errors: [{ code: 'LOCALIZATION_READBACK_UNAVAILABLE', message: 'Variant mapping is incomplete' }],
    retryable: true
  };
  await testSchemaValidation(
    '/schemas/creative/list-creatives-response.json',
    {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [unavailableLocalizedListItem]
    },
    'list_creatives preserves a localized item with explicit fail-closed unavailable state'
  );

  const ambiguousLocalizedListItem = structuredClone(localizedListItem);
  ambiguousLocalizedListItem.localization_unavailable = unavailableLocalizedListItem.localization_unavailable;
  await testSchemaRejection(
    '/schemas/creative/list-creatives-response.json',
    {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [ambiguousLocalizedListItem]
    },
    'list_creatives rejects simultaneous localization and localization_unavailable'
  );

  await testSchemaValidation(
    '/schemas/core/creative-variant.json',
    { variant_id: 'served_4821', locale_variant_id: 'loc_es_es' },
    'Served variants can attribute the localized assets that served'
  );
  testValidationAnnotation(
    '/schemas/core/creative-variant.json',
    {
      localized_parent: {
        required_field: 'locale_variant_id',
        member_of: 'accepted_source_revision.localization.variants[].locale_variant_id',
        current_list_localization_not_required: true,
        applies_to_default_fallback: true
      }
    },
    'Served variants expose machine-readable historical localization attribution rules'
  );

  const localizedCanonicalListItem = structuredClone(localizedListItem);
  delete localizedCanonicalListItem.format_id;
  localizedCanonicalListItem.format_kind = 'image';
  await testSchemaValidation(
    '/schemas/creative/list-creatives-response.json',
    {
      status: 'completed',
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [localizedCanonicalListItem]
    },
    'Localized list readback composes with canonical format identity'
  );

  testSemanticValidation(
    validateLocalizedSourceUpsert(localizationReadback, {
      ...localizedCreative,
      localization: localizedCreative.localization
    }),
    undefined,
    'Explicit full localization field may replace existing topology'
  );

  const unchangedLocalizedSource = structuredClone(localizedCreative);
  delete unchangedLocalizedSource.localization;
  testSemanticValidation(
    validateLocalizedSourceUpsert(localizationReadback, unchangedLocalizedSource),
    undefined,
    'Localization omission preserves topology when source assets are exactly unchanged'
  );

  const changedLocalizedSource = structuredClone(unchangedLocalizedSource);
  changedLocalizedSource.assets.headline.content = 'A changed source headline';
  testSemanticValidation(
    validateLocalizedSourceUpsert(localizationReadback, changedLocalizedSource),
    'localization omission requires top-level assets to equal prior localized source assets',
    'Localization omission rejects a source asset change'
  );

  testSemanticValidation(
    validateLocalizedSourceUpsert(localizationReadback, {
      ...changedLocalizedSource,
      localization: localizedCreative.localization
    }),
    undefined,
    'Changed source assets are accepted with an explicit full localization topology'
  );

  testSemanticValidation(
    validateLocalizedSourceUpsert(localizationReadback, {
      ...changedLocalizedSource,
      localization: null
    }),
    undefined,
    'Changed source assets are accepted with explicit localization removal'
  );

  const localizedCapabilitiesResponse = {
    adcp_version: '3.1',
    status: 'completed',
    adcp: {
      major_versions: [3],
      idempotency: { supported: true, replay_ttl_seconds: 86400 }
    },
    supported_protocols: ['creative'],
    creative: {
      has_creative_library: true,
      localization: {
        max_target_variants: 10,
        locale_matching: 'rfc4647_lookup'
      }
    }
  };
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    localizedCapabilitiesResponse,
    'Capabilities advertise coarse materialized localization support'
  );
  const sourceOnlyCapabilities = structuredClone(localizedCapabilitiesResponse);
  sourceOnlyCapabilities.creative.localization.max_target_variants = 0;
  await testSchemaValidation(
    '/schemas/protocol/get-adcp-capabilities-response.json',
    sourceOnlyCapabilities,
    'Localization capability can advertise source-only topology'
  );

  for (const [libraryValue, description] of [
    [undefined, 'Localization capability requires an explicit creative library capability'],
    [false, 'Localization capability rejects has_creative_library false']
  ]) {
    const invalidCapabilities = structuredClone(localizedCapabilitiesResponse);
    if (libraryValue === undefined) {
      delete invalidCapabilities.creative.has_creative_library;
    } else {
      invalidCapabilities.creative.has_creative_library = libraryValue;
    }
    await testSchemaRejection(
      '/schemas/protocol/get-adcp-capabilities-response.json',
      invalidCapabilities,
      description
    );
  }
  log('');

  // Print results
  log('====================================================');
  log(`Tests completed: ${totalTests}`);
  log(`\u2713 Passed: ${passedTests}`, passedTests === totalTests ? 'success' : 'info');
  if (failedTests > 0) {
    log(`\u2717 Failed: ${failedTests}`, 'error');
  }

  if (failedTests > 0) {
    log('');
    log('FAILURE: Composed schema validation tests failed.', 'error');
    log('This likely indicates an allOf + additionalProperties: false conflict.', 'error');
    log('See: https://github.com/adcontextprotocol/adcp/issues/275', 'error');
    process.exit(1);
  } else {
    log('');
    log('All composed schema validation tests passed!', 'success');
  }
}

/**
 * Test bundled schema validation WITHOUT custom loadSchema
 * This proves bundled schemas are truly self-contained with no $ref dependencies
 */
async function testBundledSchemaValidation(schemaPath, testData, description) {
  totalTests++;
  try {
    // Create AJV WITHOUT loadSchema - bundled schemas should work standalone
    const ajv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true
      // Note: NO loadSchema - bundled schemas must be self-contained
    });
    addFormats(ajv);

    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const validate = ajv.compile(schema);
    const valid = validate(testData);

    if (valid) {
      log(`  \u2713 ${description}`, 'success');
      passedTests++;
      return true;
    } else {
      log(`  \u2717 ${description}`, 'error');
      log(`    Errors:`, 'error');
      for (const err of validate.errors) {
        log(`      ${err.instancePath || 'root'}: ${err.message} (${err.schemaPath})`, 'error');
      }
      failedTests++;
      return false;
    }
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

/**
 * Compile a bundled schema with a vanilla Ajv (no loadSchema). Does not
 * validate data — just asserts the schema itself is resolvable.
 */
async function testBundledSchemaCompile(schemaPath, description) {
  totalTests++;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    ajv.compile(schema);
    log(`  \u2713 ${description}`, 'success');
    passedTests++;
    return true;
  } catch (error) {
    log(`  \u2717 ${description}: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

async function testBundledDeliveryMetricSchemaTitles(bundledDir) {
  totalTests++;
  try {
    const latestDir = path.join(bundledDir, 'latest');
    const coreSchemas = [
      ['core/missing-metric.json', 'Missing Metric'],
      ['core/catalog-item-delivery-metrics.json', 'Catalog Item Delivery Metrics'],
      ['core/creative-delivery-metrics.json', 'Creative Delivery Metrics'],
      ['core/keyword-delivery-metrics.json', 'Keyword Delivery Metrics'],
      ['core/geo-delivery-metrics.json', 'Geo Delivery Metrics']
    ];

    const missing = [];
    for (const [relPath, expectedTitle] of coreSchemas) {
      const schemaPath = path.join(latestDir, relPath);
      const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      if (schema.title !== expectedTitle) {
        missing.push(`${relPath} title=${JSON.stringify(schema.title)} expected ${JSON.stringify(expectedTitle)}`);
      }
    }

    const deliverySchema = JSON.parse(fs.readFileSync(
      path.join(latestDir, 'bundled/media-buy/get-media-buy-delivery-response.json'),
      'utf8'
    ));
    const packageItems = deliverySchema.properties.media_buy_deliveries.items.properties.by_package.items;
    const packageBreakdowns = packageItems.allOf[1].properties;
    const bundledTitles = [
      [packageBreakdowns.missing_metrics.items, 'Missing Metric', 'by_package.missing_metrics.items'],
      [packageBreakdowns.by_catalog_item.items, 'Catalog Item Delivery Metrics', 'by_package.by_catalog_item.items'],
      [packageBreakdowns.by_creative.items, 'Creative Delivery Metrics', 'by_package.by_creative.items'],
      [packageBreakdowns.by_keyword.items, 'Keyword Delivery Metrics', 'by_package.by_keyword.items'],
      [packageBreakdowns.by_geo.items, 'Geo Delivery Metrics', 'by_package.by_geo.items']
    ];

    for (const [schema, expectedTitle, label] of bundledTitles) {
      if (!schema || schema.title !== expectedTitle) {
        missing.push(`${label} title=${JSON.stringify(schema && schema.title)} expected ${JSON.stringify(expectedTitle)}`);
      }
    }

    if (missing.length === 0) {
      log(`  \u2713 Bundled delivery metric schemas preserve named titles`, 'success');
      passedTests++;
      return true;
    }

    log(`  \u2717 Bundled delivery metric schemas preserve named titles`, 'error');
    for (const issue of missing) log(`      ${issue}`, 'error');
    failedTests++;
    return false;
  } catch (error) {
    log(`  \u2717 Bundled delivery metric schemas preserve named titles: ${error.message}`, 'error');
    failedTests++;
    return false;
  }
}

/**
 * Walk the entire bundled/ tree and assert every schema compiles standalone.
 * This is the real guarantee bundled/ is supposed to provide: a consumer can
 * `new Ajv().compile(require('bundled/.../foo.json'))` without any loader.
 */
async function testAllBundledSchemasCompile(bundledPath) {
  totalTests++;
  const failures = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.json')) {
        try {
          const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
          addFormats(ajv);
          ajv.compile(JSON.parse(fs.readFileSync(p, 'utf8')));
        } catch (error) {
          failures.push(`${path.relative(bundledPath, p)}: ${error.message}`);
        }
      }
    }
  };
  walk(bundledPath);

  if (failures.length === 0) {
    log(`  \u2713 All bundled schemas compile standalone (no loadSchema)`, 'success');
    passedTests++;
    return true;
  }
  log(`  \u2717 ${failures.length} bundled schema(s) failed to compile:`, 'error');
  for (const f of failures) log(`      ${f}`, 'error');
  failedTests++;
  return false;
}

runTests().catch(error => {
  log(`Test execution failed: ${error.message}`, 'error');
  process.exit(1);
});
