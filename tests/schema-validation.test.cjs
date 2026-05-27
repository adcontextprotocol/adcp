#!/usr/bin/env node
/**
 * JSON Schema validation test suite
 * Validates that all schemas are syntactically correct and cross-references resolve
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

// Initialize AJV with formats and custom loader
const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: false, // Allow some flexibility for our schema structure
  discriminator: true,
  loadSchema: loadExternalSchema
});
addFormats(ajv);

// Schema loader for resolving $ref
async function loadExternalSchema(uri) {
  if (uri.startsWith('/schemas/')) {
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
    try {
      const content = fs.readFileSync(schemaPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to load referenced schema ${uri}: ${error.message}`);
    }
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

async function test(description, testFn) {
  totalTests++;
  try {
    const result = await testFn();
    if (result === true || result === undefined) {
      log(`✅ ${description}`, 'success');
      passedTests++;
    } else {
      log(`❌ ${description}: ${result}`, 'error');
      failedTests++;
    }
  } catch (error) {
    log(`❌ ${description}: ${error.message}`, 'error');
    failedTests++;
  }
}

function loadSchema(schemaPath) {
  try {
    const content = fs.readFileSync(schemaPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load schema ${schemaPath}: ${error.message}`);
  }
}

function findAllSchemas(dir) {
  const schemas = [];
  
  function traverse(currentDir) {
    const items = fs.readdirSync(currentDir);
    
    for (const item of items) {
      const itemPath = path.join(currentDir, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory()) {
        traverse(itemPath);
      } else if (item.endsWith('.json')) {
        schemas.push(itemPath);
      }
    }
  }
  
  traverse(dir);
  return schemas;
}

function validateSchemaStructure(schemaPath, schema) {
  // Check required top-level fields
  if (!schema.$schema) {
    return 'Missing $schema field';
  }
  
  if (!schema.$id) {
    return 'Missing $id field';
  }
  
  if (!schema.title) {
    return 'Missing title field';
  }
  
  if (!schema.description) {
    return 'Missing description field';
  }
  
  // Validate $schema format
  if (!schema.$schema.startsWith('http://json-schema.org/')) {
    return 'Invalid $schema URL format';
  }
  
  // Validate $id format (should be relative path)
  if (!schema.$id.startsWith('/schemas/')) {
    return `Invalid $id format: ${schema.$id} (should start with /schemas/)`;
  }
  
  return true;
}

function validateCrossReferences(schemas) {
  const schemaIds = new Set(schemas.map(([_, schema]) => schema.$id));
  const missingRefs = [];

  for (const [schemaPath, schema] of schemas) {
    // Find all $ref occurrences
    const refs = JSON.stringify(schema).match(/"\$ref":\s*"([^"]+)"/g) || [];

    for (const refMatch of refs) {
      const ref = refMatch.match(/"\$ref":\s*"([^"]+)"/)[1];

      // Skip external references (http://, https://)
      if (ref.startsWith('http://') || ref.startsWith('https://')) {
        continue;
      }

      // Skip internal references (#/$defs/..., #/properties/..., etc.)
      if (ref.startsWith('#/')) {
        continue;
      }

      // Check if referenced schema exists
      if (!schemaIds.has(ref)) {
        missingRefs.push({ schema: schemaPath, ref });
      }
    }
  }

  if (missingRefs.length > 0) {
    const errorMsg = missingRefs.map(({ schema, ref }) =>
      `${path.basename(schema)} -> ${ref}`
    ).join(', ');
    return `Missing referenced schemas: ${errorMsg}`;
  }

  return true;
}

function validateRegistryConsistency() {
  const registryPath = path.join(SCHEMA_BASE_DIR, 'index.json');
  const registry = loadSchema(registryPath);
  
  // Collect all schema references from the registry
  const registryRefs = new Set();
  
  function collectRefs(obj) {
    if (typeof obj === 'object' && obj !== null) {
      if (obj.$ref) {
        registryRefs.add(obj.$ref);
      }
      for (const value of Object.values(obj)) {
        collectRefs(value);
      }
    }
  }
  
  collectRefs(registry);
  
  // Find all actual schemas
  const actualSchemas = findAllSchemas(SCHEMA_BASE_DIR);
  const actualSchemaIds = actualSchemas
    .map(schemaPath => loadSchema(schemaPath).$id);
  
  // Check that all registry references exist
  const missingSchemas = [];
  for (const ref of registryRefs) {
    if (!actualSchemaIds.includes(ref)) {
      missingSchemas.push(ref);
    }
  }
  
  if (missingSchemas.length > 0) {
    return `Registry references missing schemas: ${missingSchemas.join(', ')}`;
  }
  
  return true;
}

// Main test execution
async function runTests() {
  log('🧪 Starting JSON Schema Validation Tests', 'info');
  log('==========================================');

  // Find and load all schemas
  const schemaPaths = findAllSchemas(SCHEMA_BASE_DIR);
  const schemas = schemaPaths.map(schemaPath => [
    schemaPath,
    loadSchema(schemaPath)
  ]);

  log(`Found ${schemas.length} schemas to validate`);

  // Test 1: Validate each schema structure
  await test('All schemas have required fields and valid structure', () => {
    for (const [schemaPath, schema] of schemas) {
      const result = validateSchemaStructure(schemaPath, schema);
      if (result !== true) {
        return `${path.basename(schemaPath)}: ${result}`;
      }
    }
    return true;
  });

  // Test 2: Validate schema syntax with AJV
  await test('All schemas are syntactically valid JSON Schema', async () => {
    for (const [schemaPath, schema] of schemas) {
      // Create a new AJV instance for each schema to avoid duplicate ID issues
      const testAjv = new Ajv({
        allErrors: true,
        verbose: true,
        strict: false,
        discriminator: true,
        loadSchema: loadExternalSchema
      });
      addFormats(testAjv);

      try {
        await testAjv.compileAsync(schema);
      } catch (error) {
        return `${path.basename(schemaPath)}: ${error.message}`;
      }
    }
    return true;
  });

  // Test 3: Validate cross-references
  await test('All $ref cross-references resolve to existing schemas', () => {
    return validateCrossReferences(schemas);
  });

  // Test 4: Validate registry consistency
  await test('Schema registry is consistent with actual schemas', () => {
    return validateRegistryConsistency();
  });

  // Test 5: Validate enum schemas
  await test('All enum schemas have proper enum values', () => {
    const enumSchemas = schemas.filter(([path]) => path.includes('/enums/'));

    for (const [schemaPath, schema] of enumSchemas) {
      if (!schema.enum || !Array.isArray(schema.enum) || schema.enum.length === 0) {
        return `${path.basename(schemaPath)}: Missing or empty enum values`;
      }
    }
    return true;
  });

  // Test 6: Validate required vs optional fields consistency
  await test('Core schemas have appropriate required fields', () => {
    const coreSchemas = schemas.filter(([path]) => path.includes('/core/'));
    const requiredFieldChecks = {
      // product.json: format_ids OR format_options is required (v1 OR v2 path) — checked separately below
      // creative-asset.json: format_id OR format_kind is required (v1 OR v2 path) — checked separately below
      'product.json': ['product_id', 'name', 'description', 'delivery_type'],
      'media-buy.json': ['media_buy_id', 'status', 'total_budget', 'packages'],
      'package.json': ['package_id'],
      'creative-asset.json': ['creative_id', 'name', 'assets'],
      'error.json': ['code', 'message']
    };

    for (const [schemaPath, schema] of coreSchemas) {
      const filename = path.basename(schemaPath);
      const expectedRequired = requiredFieldChecks[filename];

      if (expectedRequired) {
        const actualRequired = schema.required || [];
        const missing = expectedRequired.filter(field => !actualRequired.includes(field));

        if (missing.length > 0) {
          return `${filename}: Missing required fields: ${missing.join(', ')}`;
        }
      }
    }

    // product.json: assert v1 (format_ids) OR v2 (format_options) is required via anyOf — at-least-one,
    // BOTH allowed during the migration window (per RFC #3305 amendment #3765). The previous oneOf-with-not
    // shape required exactly one and forbade dual emission, which broke the seller migration story.
    const productEntry = coreSchemas.find(([p]) => path.basename(p) === 'product.json');
    if (productEntry) {
      const [, productSchema] = productEntry;
      const anyOf = productSchema.anyOf || [];
      const hasV1Branch = anyOf.some((branch) => (branch.required || []).includes('format_ids'));
      const hasV2Branch = anyOf.some((branch) => (branch.required || []).includes('format_options'));
      if (!hasV1Branch || !hasV2Branch) {
        return `product.json: must have an anyOf with v1 branch (required: ["format_ids"]) and v2 branch (required: ["format_options"]); found v1=${hasV1Branch}, v2=${hasV2Branch}`;
      }
      // No-not invariant: branches MUST NOT carry `not` clauses excluding the other branch — that would
      // be the old oneOf behavior. anyOf with no negative constraints lets dual-emission products validate.
      const hasForbiddenNotClause = anyOf.some((branch) => branch.not && branch.not.required);
      if (hasForbiddenNotClause) {
        return `product.json: anyOf branches must not carry 'not: required' clauses — dual emission of format_ids + format_options is legal during migration. See #3765.`;
      }
    }

    // creative-asset.json: assert v1 (format_id) OR v2 (format_kind) is required via oneOf
    const creativeAssetEntry = coreSchemas.find(([p]) => path.basename(p) === 'creative-asset.json');
    if (creativeAssetEntry) {
      const [, creativeAssetSchema] = creativeAssetEntry;
      const oneOf = creativeAssetSchema.oneOf || [];
      const hasV1Branch = oneOf.some((branch) => (branch.required || []).includes('format_id'));
      const hasV2Branch = oneOf.some((branch) => (branch.required || []).includes('format_kind'));
      if (!hasV1Branch || !hasV2Branch) {
        return `creative-asset.json: must have a oneOf with v1 branch (required: ["format_id"]) and v2 branch (required: ["format_kind"]); found v1=${hasV1Branch}, v2=${hasV2Branch}`;
      }
    }

    return true;
  });

  // Test 7: Validate preview_creative supports non-expiring preview URLs
  await test('preview_creative responses may omit expires_at for non-expiring preview URLs', async () => {
    const previewResponseSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'creative/preview-creative-response.json'));
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validate = await testAjv.compileAsync(previewResponseSchema);
    const render = {
      render_id: 'render_1',
      output_format: 'url',
      preview_url: 'https://creative-agent.example.com/preview/static',
      role: 'primary'
    };
    const preview = {
      preview_id: 'prev_static',
      renders: [render],
      input: { name: 'Default' }
    };
    const cases = [
      {
        status: 'completed',
        response_type: 'single',
        previews: [preview]
      },
      {
        status: 'completed',
        response_type: 'batch',
        results: [
          {
            success: true,
            creative_id: 'creative_static',
            response: { previews: [preview] }
          }
        ]
      }
    ];

    for (const example of cases) {
      if (!validate(example)) {
        return validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ');
      }
    }
    return true;
  });

  // Test 8: Validate media-buy available_actions SLAWindow wire shape
  await test('get_media_buys available_actions uses generated SLAWindow duration shape', async () => {
    const responseSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/get-media-buys-response.json'));
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validate = await testAjv.compileAsync(responseSchema);
    const baseResponse = {
      status: 'completed',
      media_buys: [{
        media_buy_id: 'mb_available_actions',
        status: 'active',
        currency: 'USD',
        total_budget: 10000,
        packages: [],
        available_actions: [{
          action: 'increase_budget',
          mode: 'self_serve',
          sla: {
            response_max: 'PT5M',
            completion_max: 'PT1H'
          }
        }]
      }],
      pagination: { has_more: false }
    };

    if (!validate(baseResponse)) {
      return `Generated SLAWindow shape failed validation: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const legacyResponse = structuredClone(baseResponse);
    legacyResponse.media_buys[0].available_actions[0].sla = {
      unit: 'hours',
      value: 1,
      response_max: 5
    };
    if (validate(legacyResponse)) {
      return 'Legacy { unit, value, response_max:number } SLA shape unexpectedly validated';
    }
    const legacyErrorText = validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ');
    if (!legacyErrorText.includes('/available_actions/0/sla')) {
      return `Legacy SLA rejection did not point at sla: ${legacyErrorText}`;
    }
    return true;
  });

  // Test 9: Validate ForecastPoint dimension and viewability compatibility gates
  await test('ForecastPoint dimension and viewability compatibility gates behave as intended', async () => {
    const dimensionsSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/forecast-point-dimensions.json'));
    const uniqueProps = dimensionsSchema['x-adcp-validation']?.unique_item_properties || [];
    if (!uniqueProps.includes('kind')) {
      return 'forecast-point-dimensions.json must declare x-adcp-validation.unique_item_properties: ["kind"]';
    }

    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validateDimensions = await testAjv.compileAsync(dimensionsSchema);
    const validateForecastPoint = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/forecast-point.json')));
    const validateSignalCoverageForecast = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/signal-coverage-forecast.json')));
    const validateGetSignalsResponse = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'signals/get-signals-response.json')));
    const validateDeliveryMetrics = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/delivery-metrics.json')));
    const validateComplyRequest = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'compliance/comply-test-controller-request.json')));

    const assertValid = (validate, value, label) => {
      if (!validate(value)) {
        return `${label} unexpectedly failed validation: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
      }
      return true;
    };

    const assertInvalid = (validate, value, label) => {
      if (validate(value)) {
        return `${label} unexpectedly passed validation`;
      }
      return true;
    };

    for (const [value, label] of [
      [[{ kind: 'geo', geo_level: 'metro', system: 'nielsen_dma', geo_code: '501' }], 'metro dimension with metro-system'],
      [[{ kind: 'geo', geo_level: 'postal_area', system: 'us_zip', geo_code: '10001' }], 'postal dimension with postal-system'],
      [[{ kind: 'geo', geo_level: 'country', geo_code: 'US' }], 'country dimension without system'],
      [[{ kind: 'placement', placement_ref: { publisher_domain: 'publisher.example', placement_id: 'header_bidding' } }, { kind: 'geo', geo_level: 'country', geo_code: 'US' }], 'placement x country intersection'],
      [[{ kind: 'signal', signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'weather' }, signal_value: 'hot', presence: 'present' }], 'signal value dimension with signal_ref'],
      [[{ kind: 'signal', signal_id: 'weather', signal_value: 'hot', presence: 'present' }], 'signal value dimension with inherited signal_id shorthand'],
      [[{ kind: 'signal', signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'weather' }, signal_value: null, presence: 'absent' }], 'signal not-present dimension']
    ]) {
      const result = assertValid(validateDimensions, value, label);
      if (result !== true) return result;
    }

    for (const [value, label] of [
      [[{ kind: 'geo', geo_level: 'metro', system: 'us_zip', geo_code: '10001' }], 'metro dimension with postal-system'],
      [[{ kind: 'geo', geo_level: 'postal_area', system: 'nielsen_dma', geo_code: '501' }], 'postal dimension with metro-system'],
      [[{ kind: 'geo', geo_level: 'country', system: 'nielsen_dma', geo_code: 'US' }], 'country dimension with system'],
      [[{ kind: 'geo', geo_level: 'country', geo_code: 'USA' }], 'country dimension with non-alpha2 code'],
      [[{ kind: 'signal', signal_id: 'weather', signal_value: 'hot', presence: 'absent' }], 'signal absent dimension with non-null value'],
      [[{ kind: 'signal', signal_id: 'weather', signal_value: null, presence: 'present' }], 'signal present dimension with null value'],
      [[{ kind: 'signal', signal_id: 'weather', presence: 'absent' }], 'signal absent dimension without explicit null value'],
      [[{ kind: 'signal', signal_value: 'hot', presence: 'present' }], 'signal dimension without signal identity']
    ]) {
      const result = assertInvalid(validateDimensions, value, label);
      if (result !== true) return result;
    }

    const coverageRateOutOfRange = {
      metrics: { coverage_rate: { mid: 1.2 } }
    };
    let result = assertInvalid(validateForecastPoint, coverageRateOutOfRange, 'coverage_rate above 1.0');
    if (result !== true) return result;

    const signalCoverageForecast = {
      method: 'estimate',
      forecast_range_unit: 'availability',
      scope: {
        kind: 'inventory',
        label: 'network price-priority inventory',
        line_item_types: ['PRICE_PRIORITY']
      },
      bucket_semantics: 'exclusive',
      bucket_completeness: 'partial',
      points: [
        {
          label: 'not present',
          dimensions: [
            { kind: 'signal', signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'weather' }, signal_value: null, presence: 'absent' }
          ],
          metrics: {
            impressions: { mid: 280000 },
            coverage_rate: { mid: 0.28 }
          }
        },
        {
          label: 'hot',
          dimensions: [
            { kind: 'signal', signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'weather' }, signal_value: 'hot', presence: 'present' }
          ],
          metrics: {
            impressions: { mid: 180000 },
            coverage_rate: { mid: 0.18 }
          }
        }
      ]
    };
    result = assertValid(validateSignalCoverageForecast, signalCoverageForecast, 'signal coverage forecast');
    if (result !== true) return result;

    result = assertInvalid(
      validateSignalCoverageForecast,
      { ...signalCoverageForecast, points: [{ metrics: { coverage_rate: { mid: 0.12 } } }] },
      'signal coverage forecast point without dimensions'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateSignalCoverageForecast,
      {
        ...signalCoverageForecast,
        points: [
          {
            dimensions: [{ kind: 'geo', geo_level: 'country', geo_code: 'US' }],
            metrics: { coverage_rate: { mid: 0.12 } }
          }
        ]
      },
      'signal coverage forecast point without signal dimension'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateSignalCoverageForecast,
      {
        ...signalCoverageForecast,
        points: [
          {
            dimensions: [
              { kind: 'signal', signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'weather' }, presence: 'present' }
            ],
            metrics: { impressions: { mid: 120000 } }
          }
        ]
      },
      'signal coverage forecast point without coverage_rate'
    );
    if (result !== true) return result;

    const signalCoverageForecastWithoutBucketSemantics = { ...signalCoverageForecast };
    delete signalCoverageForecastWithoutBucketSemantics.bucket_semantics;
    result = assertInvalid(
      validateSignalCoverageForecast,
      signalCoverageForecastWithoutBucketSemantics,
      'signal coverage forecast without bucket semantics'
    );
    if (result !== true) return result;

    const signalCoverageForecastWithoutBucketCompleteness = { ...signalCoverageForecast };
    delete signalCoverageForecastWithoutBucketCompleteness.bucket_completeness;
    result = assertInvalid(
      validateSignalCoverageForecast,
      signalCoverageForecastWithoutBucketCompleteness,
      'signal coverage forecast without bucket completeness'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateSignalCoverageForecast,
      { ...signalCoverageForecast, forecast_range_unit: 'spend' },
      'signal coverage forecast with non-availability range unit'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateSignalCoverageForecast,
      { ...signalCoverageForecast, scope: { kind: 'product', label: 'Sports ROS' } },
      'product-scoped signal coverage forecast without product_id'
    );
    if (result !== true) return result;

    const signalDimensionMatchesEnclosingSignal = (signal) => {
      const enclosingRef = signal.signal_ref;
      const enclosingLegacyId = signal.signal_id?.id;
      for (const point of signal.coverage_forecast?.points || []) {
        for (const dimension of point.dimensions || []) {
          if (dimension.kind !== 'signal') continue;
          if (dimension.signal_ref && enclosingRef) {
            if (JSON.stringify(dimension.signal_ref) !== JSON.stringify(enclosingRef)) return false;
          } else if (dimension.signal_ref && !enclosingRef) {
            return false;
          } else if (dimension.signal_id) {
            const enclosingSignalId = enclosingRef?.signal_id || enclosingLegacyId;
            if (dimension.signal_id !== enclosingSignalId) return false;
          }
        }
      }
      return true;
    };

    if (!signalDimensionMatchesEnclosingSignal({
      signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'weather' },
      coverage_forecast: signalCoverageForecast
    })) {
      return 'matching coverage_forecast signal_ref was incorrectly flagged as mismatch';
    }

    if (signalDimensionMatchesEnclosingSignal({
      signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'sports_fans' },
      coverage_forecast: signalCoverageForecast
    })) {
      return 'coverage_forecast signal dimension must resolve to the enclosing signal';
    }

    const completeExclusiveCoverageRatesPartition = (forecast) => {
      if (forecast.bucket_semantics !== 'exclusive' || forecast.bucket_completeness !== 'complete') return true;
      const mids = forecast.points.map(point => point.metrics?.coverage_rate?.mid);
      if (mids.some(value => typeof value !== 'number')) return false;
      return Math.abs(mids.reduce((sum, value) => sum + value, 0) - 1) < 0.000001;
    };

    if (!completeExclusiveCoverageRatesPartition({
      ...signalCoverageForecast,
      bucket_completeness: 'complete',
      points: [
        signalCoverageForecast.points[0],
        {
          ...signalCoverageForecast.points[1],
          label: 'present',
          metrics: { coverage_rate: { mid: 0.72 } }
        }
      ]
    })) {
      return 'complete exclusive coverage partition with rates summing to 1 was incorrectly flagged';
    }

    if (completeExclusiveCoverageRatesPartition({
      ...signalCoverageForecast,
      bucket_completeness: 'complete'
    })) {
      return 'complete exclusive coverage partition must have coverage_rate mid values summing to 1';
    }

    result = assertValid(
      validateGetSignalsResponse,
      {
        status: 'completed',
        cache_scope: 'public',
        signals: [
          {
            signal_ref: {
              scope: 'data_provider',
              data_provider_domain: 'pinnacle-data.example',
              signal_id: 'weather'
            },
            signal_agent_segment_id: 'weather',
            name: 'Weather',
            description: 'Weather context',
            signal_type: 'marketplace',
            coverage_percentage: 72,
            coverage_forecast: signalCoverageForecast,
            deployments: []
          }
        ]
      },
      'get_signals response with coverage_forecast'
    );
    if (result !== true) return result;

    const forecastWithoutStandard = {
      metrics: { impressions: { mid: 10 } },
      viewability: { viewable_rate: { mid: 0.8 } }
    };
    result = assertInvalid(validateForecastPoint, forecastWithoutStandard, 'forecast viewability values without standard');
    if (result !== true) return result;

    const forecastWithStandard = {
      product_id: 'prod_1',
      metrics: { impressions: { mid: 10 } },
      dimensions: [
        { kind: 'placement', placement_ref: { publisher_domain: 'publisher.example', placement_id: 'header_bidding' } },
        { kind: 'geo', geo_level: 'country', geo_code: 'US' }
      ],
      viewability: { viewable_rate: { mid: 0.8 }, standard: 'mrc' }
    };
    result = assertValid(validateForecastPoint, forecastWithStandard, 'forecast viewability values with standard');
    if (result !== true) return result;

    result = assertValid(
      validateDeliveryMetrics,
      { impressions: 10, viewability: { measurable_impressions: 9, viewable_rate: 0.8 } },
      'delivery viewability without standard remains 3.x-compatible'
    );
    if (result !== true) return result;

    result = assertValid(
      validateComplyRequest,
      { scenario: 'simulate_delivery', params: { media_buy_id: 'mb_1', viewability: { viewable_rate: 0.8 } }, account: { sandbox: true } },
      'simulate_delivery viewability without standard remains 3.x-compatible'
    );
    if (result !== true) return result;

    const hasRepeatedKind = (dimensions) => {
      const seen = new Set();
      for (const dimension of dimensions) {
        if (!dimension || typeof dimension.kind !== 'string') continue;
        if (seen.has(dimension.kind)) return true;
        seen.add(dimension.kind);
      }
      return false;
    };

    const placementCountry = [
      { kind: 'placement', placement_ref: { publisher_domain: 'publisher.example', placement_id: 'header_bidding' } },
      { kind: 'geo', geo_level: 'country', geo_code: 'US' }
    ];
    if (hasRepeatedKind(placementCountry)) {
      return 'placement x country intersection was incorrectly flagged as duplicate kind';
    }

    const twoCountries = [
      { kind: 'geo', geo_level: 'country', geo_code: 'US' },
      { kind: 'geo', geo_level: 'country', geo_code: 'CA' }
    ];
    if (!hasRepeatedKind(twoCountries)) {
      return 'two geo rows in one point must be flagged as duplicate kind';
    }

    return true;
  });

  // Test 10: Validate schema examples against their schemas
  await test('Schema examples validate against their own schemas', async () => {
    // Skip schemas that require format-aware validation (creative manifests need format context)
    const FORMAT_AWARE_SCHEMAS = ['sync-creatives-request.json', 'list-creatives-response.json'];

    const schemasWithExamples = schemas.filter(([schemaPath, schema]) => {
      if (!schema.examples || schema.examples.length === 0) return false;
      const filename = path.basename(schemaPath);
      return !FORMAT_AWARE_SCHEMAS.includes(filename);
    });

    for (const [schemaPath, schema] of schemasWithExamples) {
      const filename = path.basename(schemaPath);

      // Compile the schema
      const testAjv = new Ajv({
        allErrors: true,
        verbose: true,
        strict: false,
        discriminator: true,
        loadSchema: loadExternalSchema
      });
      addFormats(testAjv);

      let validate;
      try {
        validate = await testAjv.compileAsync(schema);
      } catch (error) {
        return `${filename}: Failed to compile schema for example validation: ${error.message}`;
      }

      // Validate each example
      for (let i = 0; i < schema.examples.length; i++) {
        const example = schema.examples[i];
        const exampleData = example.data || example;

        const valid = validate(exampleData);
        if (!valid) {
          const errors = validate.errors.map(err =>
            `${err.instancePath} ${err.message}`
          ).join('; ');
          return `${filename}: Example ${i + 1} ${example.description ? `"${example.description}" ` : ''}failed validation: ${errors}`;
        }
      }
    }
    return true;
  });

  // Print results
  log('\n==========================================');
  log(`Tests completed: ${totalTests}`);
  log(`✅ Passed: ${passedTests}`, 'success');
  log(`❌ Failed: ${failedTests}`, failedTests > 0 ? 'error' : 'success');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    log('\n🎉 All schema validation tests passed!', 'success');
  }
}

// Run the tests
runTests().catch(error => {
  log(`Test execution failed: ${error.message}`, 'error');
  process.exit(1);
});
