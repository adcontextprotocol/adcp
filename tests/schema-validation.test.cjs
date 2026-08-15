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
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', '').split('#', 1)[0]);
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

function findDuplicateAgentUrls(manifest) {
  const seen = new Set();
  const duplicates = new Set();

  for (const agent of manifest.agents || []) {
    if (!agent || typeof agent.url !== 'string') {
      continue;
    }
    if (seen.has(agent.url)) {
      duplicates.add(agent.url);
    }
    seen.add(agent.url);
  }

  return [...duplicates];
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
  const schemasById = new Map(schemas.map(([_, schema]) => [schema.$id, schema]));
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

      const hashIndex = ref.indexOf('#');
      const schemaId = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : ref.slice(hashIndex + 1);
      const referencedSchema = schemasById.get(schemaId);
      if (!referencedSchema) {
        missingRefs.push({ schema: schemaPath, ref });
        continue;
      }
      if (fragment) {
        if (!fragment.startsWith('/')) {
          missingRefs.push({ schema: schemaPath, ref });
          continue;
        }
        const resolved = fragment
          .slice(1)
          .split('/')
          .map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
          .reduce((current, segment) => (
            current && typeof current === 'object' ? current[segment] : undefined
          ), referencedSchema);
        if (resolved === undefined) missingRefs.push({ schema: schemaPath, ref });
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

  const requiredDiscoverableSchemas = [
    '/schemas/enums/logo-slot.json'
  ];
  const missingRegistryRefs = requiredDiscoverableSchemas.filter(ref => !registryRefs.has(ref));
  if (missingRegistryRefs.length > 0) {
    return `Required schemas missing from registry: ${missingRegistryRefs.join(', ')}`;
  }
  
  return true;
}

function collectKeywordOccurrences(value, keyword, location, occurrences = []) {
  if (!value || typeof value !== 'object') {
    return occurrences;
  }

  if (Object.prototype.hasOwnProperty.call(value, keyword)) {
    occurrences.push({
      location,
      value: value[keyword]
    });
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectKeywordOccurrences(item, keyword, `${location}/${index}`, occurrences);
    });
  } else {
    for (const [key, child] of Object.entries(value)) {
      collectKeywordOccurrences(child, keyword, `${location}/${key}`, occurrences);
    }
  }

  return occurrences;
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

  // Test 4A: Validate brand.json permits same-type agents for scoped endpoints
  await test('brand.json permits more than 20 same-type agents with distinct urls', async () => {
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validateBrand = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'brand.json')));
    const manifest = {
      $schema: '/schemas/brand.json',
      version: '1.0',
      agents: Array.from({ length: 25 }, (_, index) => {
        const tenant = `tenant_${index + 1}`;
        return {
          type: 'sales',
          url: `https://seller.example/mcp/${tenant}`,
          id: `sales_${tenant}`,
          jwks_uri: `https://seller.example/.well-known/jwks/${tenant}.json`
        };
      })
    };

    if (!validateBrand(manifest)) {
      return validateBrand.errors.map(err => `${err.instancePath} ${err.message}`).join('; ');
    }

    const duplicateUrls = findDuplicateAgentUrls(manifest);
    if (duplicateUrls.length > 0) {
      return `Expected tenant-scoped agents to have distinct urls, found duplicates: ${duplicateUrls.join(', ')}`;
    }

    return true;
  });

  await test('brand property schemas accept every canonical property type', async () => {
    const compile = async relativePath => {
      const testAjv = new Ajv({
        allErrors: true,
        verbose: true,
        strict: false,
        discriminator: true,
        loadSchema: loadExternalSchema
      });
      addFormats(testAjv);
      return testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, relativePath)));
    };

    const validators = [
      {
        name: 'brand.json',
        validate: await compile('brand.json'),
        document: propertyType => ({
          id: 'canonical_property_types',
          names: [{ en: 'Canonical property types' }],
          properties: [{ type: propertyType, identifier: 'property-id' }]
        })
      },
      {
        name: 'verify-brand-claim-request.json',
        validate: await compile('brand/verify-brand-claim-request.json'),
        document: propertyType => ({
          claim_type: 'property',
          claim: { property: { type: propertyType, identifier: 'property-id' } }
        })
      },
      {
        name: 'verify-brand-claims-request.json',
        validate: await compile('brand/verify-brand-claims-request.json'),
        document: propertyType => ({
          claims: [{
            claim_type: 'property',
            claim: { property: { type: propertyType, identifier: 'property-id' } }
          }]
        })
      }
    ];

    const canonicalPropertyTypes = loadSchema(
      path.join(SCHEMA_BASE_DIR, 'enums/property-type.json')
    ).enum;
    for (const { name, validate, document } of validators) {
      for (const propertyType of canonicalPropertyTypes) {
        if (!validate(document(propertyType))) {
          const errors = validate.errors
            .map(error => `${error.instancePath} ${error.message}`)
            .join('; ');
          return `${name} rejected canonical property type ${propertyType}: ${errors}`;
        }
      }
      if (validate(document('not_a_property_type'))) {
        return `${name} accepted a non-canonical property type`;
      }
    }

    return true;
  });

  // Test 4B: Validate brand.json verifier ambiguity invariant
  await test('brand.json duplicate agent urls are verifier-ambiguous', () => {
    const manifest = {
      $schema: '/schemas/brand.json',
      version: '1.0',
      agents: [
        {
          type: 'sales',
          url: 'https://seller.example/mcp/tenant_1',
          id: 'sales_tenant_1',
          jwks_uri: 'https://seller.example/.well-known/jwks/tenant_1.json'
        },
        {
          type: 'sales',
          url: 'https://seller.example/mcp/tenant_1',
          id: 'sales_tenant_1_duplicate',
          jwks_uri: 'https://seller.example/.well-known/jwks/tenant_1_duplicate.json'
        }
      ]
    };

    const duplicateUrls = findDuplicateAgentUrls(manifest);
    if (duplicateUrls.length !== 1 || duplicateUrls[0] !== 'https://seller.example/mcp/tenant_1') {
      return `Expected duplicate agent url to be detected, got: ${duplicateUrls.join(', ') || '(none)'}`;
    }

    return true;
  });

  // Test 4C: Validate ADCP open-payload annotations
  await test('x-adcp-open-payload annotations use currently supported values', () => {
    for (const [schemaPath, schema] of schemas) {
      const occurrences = collectKeywordOccurrences(schema, 'x-adcp-open-payload', path.basename(schemaPath));
      for (const occurrence of occurrences) {
        if (occurrence.value !== true) {
          return `${occurrence.location}: x-adcp-open-payload must be true; false is reserved and omission means unclassified`;
        }
      }
    }
    return true;
  });

  await test('governed commitment annotations match the cross-role capability task enum', () => {
    const annotatedTasks = schemas
      .filter(([schemaPath, schema]) => schemaPath.endsWith('-request.json') && schema['x-governed-commitment'])
      .map(([schemaPath, schema]) => {
        if (schema['x-mutates-state'] !== true) {
          throw new Error(`${path.basename(schemaPath)} is governed but does not mutate state`);
        }
        const annotation = schema['x-governed-commitment'];
        if (!['always', 'conditional'].includes(annotation.scope)) {
          throw new Error(`${path.basename(schemaPath)} has invalid governed commitment scope`);
        }
        if (annotation.scope === 'conditional' && (!annotation.triggers?.length || !annotation.exemptions?.length)) {
          throw new Error(`${path.basename(schemaPath)} conditional governance needs triggers and exemptions`);
        }
        return path.basename(schemaPath, '-request.json').replaceAll('-', '_');
      })
      .sort();
    const capabilities = loadSchema(path.join(SCHEMA_BASE_DIR, 'protocol/get-adcp-capabilities-response.json'));
    const taskBranches = capabilities.properties.adcp.properties.governance_enforcement
      .properties.tasks.items.oneOf;
    const declaredTasks = taskBranches.flatMap(branch => {
      const task = branch.properties.task;
      return task.const ? [task.const] : task.enum;
    }).sort();

    if (JSON.stringify(annotatedTasks) !== JSON.stringify(declaredTasks)) {
      return `x-governed-commitment tasks (${annotatedTasks.join(', ')}) do not match capability enum (${declaredTasks.join(', ')})`;
    }
    const enforcementSchema = capabilities.properties.adcp.properties.governance_enforcement;
    const validateEnforcement = new Ajv({ strict: false }).compile(enforcementSchema);
    if (!validateEnforcement({ tasks: [{ task: 'create_media_buy', modes: ['signed_context', 'online_execution_check'] }] })) {
      return 'valid media-buy online enforcement claim was rejected';
    }
    if (validateEnforcement({ tasks: [{ task: 'create_media_buy', modes: ['online_execution_check'] }] })) {
      return 'online execution must imply signed_context';
    }
    if (validateEnforcement({ tasks: [{ task: 'activate_signal', modes: ['signed_context', 'online_execution_check'] }] })) {
      return 'non-media tasks must not claim online execution without a prepared-result contract';
    }
    return true;
  });

  await test('governance checks separate intent negotiation from execution authorization', async () => {
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);
    const validateRequest = await testAjv.compileAsync(
      loadSchema(path.join(SCHEMA_BASE_DIR, 'governance/check-governance-request.json'))
    );
    const validateResponse = await testAjv.compileAsync(
      loadSchema(path.join(SCHEMA_BASE_DIR, 'governance/check-governance-response.json'))
    );
    const validateOutcome = await testAjv.compileAsync(
      loadSchema(path.join(SCHEMA_BASE_DIR, 'governance/report-plan-outcome-request.json'))
    );
    const validatePlannedDelivery = testAjv.getSchema('/schemas/core/planned-delivery.json');
    if (!validatePlannedDelivery) {
      return 'planned-delivery schema was not loaded with the governance request';
    }

    const intent = {
      caller: 'https://buyer.example',
      plan_id: 'plan_123',
      target_agent: 'https://seller.example',
      tool: 'create_media_buy',
      payload: { total_budget: 1000 }
    };
    const execution = {
      caller: 'https://seller.example',
      governance_context: 'signed.context.token',
      planned_delivery: {
        media_buy_id: 'mb_123',
        start_time: '2026-08-10T00:00:00Z',
        end_time: '2026-08-20T00:00:00Z',
        total_budget: 1000,
        currency: 'USD'
      }
    };
    if (!validateRequest(intent) || !validateRequest(execution)) {
      return `valid governance request rejected: ${testAjv.errorsText(validateRequest.errors)}`;
    }
    const purchaseBeforeId = {
      caller: 'https://seller.example',
      governance_context: 'signed.context.token',
      phase: 'purchase',
      planned_delivery: { total_budget: 1000, currency: 'USD' }
    };
    if (!validateRequest(purchaseBeforeId)) {
      return `purchase prepare without media_buy_id rejected: ${testAjv.errorsText(validateRequest.errors)}`;
    }
    if (validateRequest({ ...purchaseBeforeId, phase: 'modification' })) {
      return 'modification execution must require planned_delivery.media_buy_id';
    }
    if (validateRequest({ ...execution, ...intent })) {
      return 'a request must not mix intent and execution fields';
    }
    if (validateRequest({ ...execution, proposed_commitment: { amount: 1000, currency: 'USD' } })) {
      return 'proposed_commitment must be intent-only';
    }
    for (const tool of ['acquire_rights', 'update_rights', 'activate_signal', 'build_creative']) {
      const indirectIntent = {
        caller: 'https://buyer.example',
        plan_id: 'plan_123',
        target_agent: 'https://service.example',
        tool,
        payload: { pricing_option_id: 'standard_monthly' }
      };
      if (validateRequest(indirectIntent)) {
        return `${tool} intent must require proposed_commitment`;
      }
      if (!validateRequest({ ...indirectIntent, proposed_commitment: { amount: 0, currency: 'USD' } })) {
        return `explicit zero-cost ${tool} intent rejected: ${testAjv.errorsText(validateRequest.errors)}`;
      }
    }
    if (validateRequest({
      caller: 'https://seller.example',
      governance_context: 'signed.context.token',
      planned_delivery: { total_budget: 1000 }
    })) {
      return 'planned_delivery.total_budget must require currency';
    }
    if (!validatePlannedDelivery({ total_budget: 1000 })) {
      return 'stable core planned_delivery must continue to allow total_budget without currency';
    }

    const approved = {
      check_id: 'check_1',
      check_type: 'intent',
      verdict: 'approved',
      explanation: 'Allowed',
      expires_at: '2026-08-04T12:00:00Z',
      governance_context: 'signed.context.token'
    };
    const conditions = {
      check_id: 'check_2',
      check_type: 'intent',
      verdict: 'conditions',
      explanation: 'Reduce spend',
      consultation_context: 'consult_123',
      conditions: [{ field: 'payload.total_budget', reason: 'Above authority' }]
    };
    if (!validateResponse(approved) || !validateResponse(conditions)) {
      return `valid governance response rejected: ${testAjv.errorsText(validateResponse.errors)}`;
    }
    const legacyConditions = {
      check_id: 'legacy_check',
      plan_id: 'legacy_plan',
      verdict: 'conditions',
      explanation: 'Legacy conditional response',
      expires_at: '2026-08-04T12:00:00Z',
      governance_context: 'legacy.context.token',
      conditions: [{ field: 'payload.total_budget', reason: 'Reduce spend' }]
    };
    if (!validateResponse(legacyConditions)) {
      return `legacy 3.x governance response rejected: ${testAjv.errorsText(validateResponse.errors)}`;
    }
    if (validateResponse({ ...conditions, governance_context: 'signed.context.token' })) {
      return 'conditions must not carry authorization context';
    }
    if (validateResponse({ ...conditions, check_type: 'execution' })) {
      return 'execution checks must not return conditions';
    }
    if (validateResponse({ check_id: 'check_3', check_type: 'intent', verdict: 'approved', explanation: 'Allowed' })) {
      return 'approved must carry expires_at and governance_context';
    }
    if (validateResponse({ ...approved, conditions: [{ field: 'payload.total_budget', reason: 'Adjust' }] })) {
      return 'approved must not carry unresolved conditions';
    }
    const denied = {
      check_id: 'check_4',
      check_type: 'execution',
      verdict: 'denied',
      explanation: 'Blocked',
      findings: [{ category_id: 'budget', severity: 'critical', explanation: 'Above authority' }]
    };
    if (!validateResponse(denied) || validateResponse({ ...denied, expires_at: '2026-08-04T12:00:00Z' })) {
      return 'denied must validate without, and reject, authorization expiry';
    }

    const legacyDelivery = {
      plan_id: 'plan_123',
      idempotency_key: 'delivery-vector-0001',
      outcome: 'delivery',
      delivery: { reporting_period: { start: '2026-08-01T00:00:00Z', end: '2026-08-02T00:00:00Z' } }
    };
    if (!validateOutcome(legacyDelivery)) {
      return `legacy plan-owner delivery snapshot rejected: ${testAjv.errorsText(validateOutcome.errors)}`;
    }
    if (!validateOutcome({
      ...legacyDelivery,
      check_id: 'check_1',
      governance_context: 'signed.context.token'
    })) {
      return `exact-tuple delivery snapshot rejected: ${testAjv.errorsText(validateOutcome.errors)}`;
    }
    if (validateOutcome({ ...legacyDelivery, check_id: 'check_1' })
      || validateOutcome({ ...legacyDelivery, governance_context: 'signed.context.token' })) {
      return 'delivery snapshots must provide check_id and governance_context together or omit both';
    }
    if (validateOutcome({
      plan_id: 'plan_123',
      check_id: 'check_1',
      idempotency_key: 'completed-vector-0001',
      outcome: 'completed',
      seller_response: {}
    })) {
      return 'completed outcomes must require governance_context with check_id';
    }
    return true;
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
      'media-buy.json': ['media_buy_id', 'status', 'confirmed_at', 'revision', 'total_budget', 'packages'],
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
      const hasNamedFormatBranch = anyOf.some((branch) => (branch.required || []).includes('format_ids'));
      const hasCanonicalFormatBranch = anyOf.some((branch) => (branch.required || []).includes('format_options'));
      if (!hasNamedFormatBranch || !hasCanonicalFormatBranch) {
        return `product.json: must have an anyOf with a named-format branch (required: ["format_ids"]) and canonical-format branch (required: ["format_options"]); found named-format=${hasNamedFormatBranch}, canonical-format=${hasCanonicalFormatBranch}`;
      }
      // No-not invariant: branches MUST NOT carry `not` clauses excluding the other branch — that would
      // be the old oneOf behavior. anyOf with no negative constraints lets dual-emission products validate.
      const hasForbiddenNotClause = anyOf.some((branch) => branch.not && branch.not.required);
      if (hasForbiddenNotClause) {
        return `product.json: anyOf branches must not carry 'not: required' clauses — dual emission of format_ids + format_options is legal during migration. See #3765.`;
      }
    }

    // creative-asset.json: assert named format (format_id) OR canonical format (format_kind) is required via oneOf
    const creativeAssetEntry = coreSchemas.find(([p]) => path.basename(p) === 'creative-asset.json');
    if (creativeAssetEntry) {
      const [, creativeAssetSchema] = creativeAssetEntry;
      const oneOf = creativeAssetSchema.oneOf || [];
      const hasNamedFormatBranch = oneOf.some((branch) => (branch.required || []).includes('format_id'));
      const hasCanonicalFormatBranch = oneOf.some((branch) => (branch.required || []).includes('format_kind'));
      if (!hasNamedFormatBranch || !hasCanonicalFormatBranch) {
        return `creative-asset.json: must have a oneOf with a named-format branch (required: ["format_id"]) and canonical-format branch (required: ["format_kind"]); found named-format=${hasNamedFormatBranch}, canonical-format=${hasCanonicalFormatBranch}`;
      }
    }

    return true;
  });

  await test('list_creatives projections preserve required metadata and exactly one format identity', async () => {
    const responseSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'creative/list-creatives-response.json'));
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
      query_summary: { total_matching: 1, returned: 1 },
      pagination: { has_more: false },
      creatives: [
        {
          creative_id: 'creative_1',
          name: 'Canonical image',
          status: 'approved',
          created_date: '2026-07-27T00:00:00Z',
          updated_date: '2026-07-27T00:00:00Z'
        }
      ]
    };
    const creative = baseResponse.creatives[0];
    const legacyIdentity = {
      format_id: {
        agent_url: 'https://creative.example',
        id: 'display_image'
      }
    };
    const canonicalIdentity = { format_kind: 'image' };

    for (const identity of [legacyIdentity, canonicalIdentity]) {
      if (!validate({ ...baseResponse, creatives: [{ ...creative, ...identity }] })) {
        return `valid creative identity was rejected: ${testAjv.errorsText(validate.errors)}`;
      }
    }

    for (const identity of [{}, { ...legacyIdentity, ...canonicalIdentity }]) {
      if (validate({ ...baseResponse, creatives: [{ ...creative, ...identity }] })) {
        return 'creative identity must contain exactly one of format_id or format_kind';
      }
    }

    const { status, ...missingStatus } = creative;
    if (validate({
      ...baseResponse,
      creatives: [{ ...missingStatus, ...canonicalIdentity }]
    })) {
      return 'projected creative must retain the released required metadata fields';
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
        quality_used: 'production',
        previews: [preview]
      },
      {
        status: 'completed',
        response_type: 'batch',
        results: [
          {
            success: true,
            creative_id: 'creative_static',
            quality_used: 'draft',
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
    if (validate({ ...cases[0], quality_used: 'ultra' })) {
      return 'preview_creative quality_used must use the creative-quality enum';
    }
    return true;
  });

  // Test 8: Validate list_creative_formats supported_macros permits universal and custom macro strings
  await test('list_creative_formats supported_macros accepts universal and custom macro names', async () => {
    const responseSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'creative/list-creative-formats-response.json'));
    const formatSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/format.json'));
    const supportedMacrosItems = formatSchema.properties?.supported_macros?.items;
    const macroBranches = supportedMacrosItems?.anyOf || [];
    if (supportedMacrosItems?.oneOf) {
      return 'supported_macros.items must use anyOf, not oneOf';
    }
    if (!macroBranches.some(branch => branch.$ref === '/schemas/enums/universal-macro.json')) {
      return 'supported_macros.items is missing the UniversalMacro enum branch';
    }
    if (!macroBranches.some(branch => branch.type === 'string')) {
      return 'supported_macros.items is missing the custom string branch';
    }

    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validate = await testAjv.compileAsync(responseSchema);
    const response = {
      status: 'completed',
      formats: [
        {
          format_id: {
            agent_url: 'https://creative-agent.example.com',
            id: 'display_standard'
          },
          name: 'Display standard',
          supported_macros: [
            'MEDIA_BUY_ID',
            'CREATIVE_ID',
            'CACHEBUSTER',
            'CLICK_URL',
            'PUBLISHER_CUSTOM_ID'
          ]
        }
      ]
    };

    if (!validate(response)) {
      return validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ');
    }
    return true;
  });

  // Test 9: Validate media-buy available_actions SLAWindow wire shape
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
        confirmed_at: '2026-05-27T09:00:00Z',
        revision: 1,
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

  // Test 10: Validate provisional media-buy confirmation guards
  await test('provisional media buys cannot be active or carry committed_metrics', async () => {
    const createSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/create-media-buy-response.json'));
    const getSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/get-media-buys-response.json'));
    const coreSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/media-buy.json'));
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validateCreate = await testAjv.compileAsync(createSchema);
    const validateGet = await testAjv.compileAsync(getSchema);
    const validateCore = await testAjv.compileAsync(coreSchema);
    const committedMetric = {
      scope: 'standard',
      metric_id: 'impressions',
      committed_at: '2026-05-27T09:00:00Z'
    };

    const provisionalCreate = {
      status: 'completed',
      media_buy_id: 'mb_provisional',
      media_buy_status: 'pending_start',
      confirmed_at: null,
      revision: 1,
      packages: [{ package_id: 'pkg_1' }]
    };
    if (!validateCreate(provisionalCreate)) {
      return `Provisional create response unexpectedly failed validation: ${validateCreate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const committedCreate = structuredClone(provisionalCreate);
    committedCreate.media_buy_status = 'active';
    committedCreate.confirmed_at = '2026-05-27T09:00:00Z';
    committedCreate.packages[0].committed_metrics = [committedMetric];
    if (!validateCreate(committedCreate)) {
      return `Committed create response unexpectedly failed validation: ${validateCreate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const activeProvisionalCreate = structuredClone(provisionalCreate);
    activeProvisionalCreate.media_buy_status = 'active';
    if (validateCreate(activeProvisionalCreate)) {
      return 'create_media_buy accepted active media_buy_status with confirmed_at: null';
    }

    const legacyActiveProvisionalCreate = structuredClone(provisionalCreate);
    delete legacyActiveProvisionalCreate.media_buy_status;
    legacyActiveProvisionalCreate.status = 'active';
    if (validateCreate(legacyActiveProvisionalCreate)) {
      return 'create_media_buy accepted deprecated active status with confirmed_at: null';
    }

    const metricsProvisionalCreate = structuredClone(provisionalCreate);
    metricsProvisionalCreate.packages[0].committed_metrics = [committedMetric];
    if (validateCreate(metricsProvisionalCreate)) {
      return 'create_media_buy accepted committed_metrics with confirmed_at: null';
    }

    const provisionalGet = {
      status: 'completed',
      media_buys: [{
        media_buy_id: 'mb_provisional',
        status: 'pending_start',
        currency: 'USD',
        total_budget: 1000,
        confirmed_at: null,
        revision: 1,
        packages: [{ package_id: 'pkg_1' }]
      }]
    };
    if (!validateGet(provisionalGet)) {
      return `Provisional get_media_buys response unexpectedly failed validation: ${validateGet.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const activeProvisionalGet = structuredClone(provisionalGet);
    activeProvisionalGet.media_buys[0].status = 'active';
    if (validateGet(activeProvisionalGet)) {
      return 'get_media_buys accepted active status with confirmed_at: null';
    }

    const metricsProvisionalGet = structuredClone(provisionalGet);
    metricsProvisionalGet.media_buys[0].packages[0].committed_metrics = [committedMetric];
    if (validateGet(metricsProvisionalGet)) {
      return 'get_media_buys accepted committed_metrics with confirmed_at: null';
    }

    const activeCore = {
      media_buy_id: 'mb_core',
      status: 'active',
      confirmed_at: null,
      revision: 1,
      total_budget: 1000,
      packages: [{ package_id: 'pkg_1' }]
    };
    if (validateCore(activeCore)) {
      return 'core media-buy accepted active status with confirmed_at: null';
    }

    return true;
  });

  // Test 11: Validate comply_test_controller accepts the JCS non-finite error code
  await test('Comply controller response accepts JCS non-finite controller error', async () => {
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validateComplyResponse = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'compliance/comply-test-controller-response.json')));
    const response = {
      status: 'completed',
      success: false,
      error: 'JCS_NON_FINITE_NUMBER',
      error_detail: 'Digest-mode upstream traffic could not be JCS-canonicalized because the parsed JSON-like value tree contained a non-finite numeric value.'
    };

    if (!validateComplyResponse(response)) {
      return `JCS_NON_FINITE_NUMBER response unexpectedly failed validation: ${validateComplyResponse.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    return true;
  });

  // Test 11B: Validate comply_test_controller scenario strings are open for extension
  await test('Compliance scenario fields accept custom scenario strings', async () => {
    const complyRequestSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'compliance/comply-test-controller-request.json'));
    const complyResponseSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'compliance/comply-test-controller-response.json'));
    const capabilitiesSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'protocol/get-adcp-capabilities-response.json'));

    if (complyRequestSchema.properties?.scenario?.enum) {
      return 'comply_test_controller request scenario must remain an open string, not a closed enum';
    }
    if (complyRequestSchema.properties?.scenario?.type !== 'string') {
      return 'comply_test_controller request scenario must remain typed as string';
    }
    const listScenariosResponse = complyResponseSchema.oneOf?.find(branch => branch.title === 'ListScenariosSuccess');
    if (!listScenariosResponse) {
      return 'ListScenariosSuccess branch missing from comply_test_controller response schema; selector is out of date';
    }
    const listScenariosResponseItems = listScenariosResponse?.properties?.scenarios?.items;
    if (listScenariosResponseItems?.enum) {
      return 'comply_test_controller list_scenarios response items must remain open strings, not a closed enum';
    }
    if (listScenariosResponseItems?.type !== 'string') {
      return 'comply_test_controller list_scenarios response items must remain typed as string';
    }
    const capabilityScenarioItems = capabilitiesSchema.properties?.compliance_testing?.properties?.scenarios?.items;
    if (capabilityScenarioItems?.enum) {
      return 'compliance_testing.scenarios items must remain open strings, not a closed enum';
    }
    if (capabilityScenarioItems?.type !== 'string') {
      return 'compliance_testing.scenarios items must remain typed as string';
    }

    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validateComplyRequest = await testAjv.compileAsync(complyRequestSchema);
    const customScenarioRequest = {
      scenario: 'seller_custom_fixture_reset',
      params: {
        fixture_scope: 'all'
      },
      account: {
        sandbox: true
      }
    };
    if (!validateComplyRequest(customScenarioRequest)) {
      return `custom comply_test_controller scenario unexpectedly failed validation: ${validateComplyRequest.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const validateComplyResponse = await testAjv.compileAsync(complyResponseSchema);
    const customScenarioResponse = {
      status: 'completed',
      success: true,
      scenarios: ['force_creative_status', 'seller_custom_fixture_reset']
    };
    if (!validateComplyResponse(customScenarioResponse)) {
      return `custom list_scenarios response unexpectedly failed validation: ${validateComplyResponse.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const validateCapabilities = await testAjv.compileAsync(capabilitiesSchema);
    const customScenarioCapabilities = {
      status: 'completed',
      adcp: {
        major_versions: [3],
        idempotency: {
          supported: false
        }
      },
      supported_protocols: ['media_buy'],
      compliance_testing: {
        scenarios: ['force_creative_status', 'seller_custom_fixture_reset']
      }
    };
    if (!validateCapabilities(customScenarioCapabilities)) {
      return `custom compliance_testing scenario unexpectedly failed validation: ${validateCapabilities.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    return true;
  });

  // Test 11C: Validate native postal systems and deprecated legacy aliases across geo surfaces
  await test('Postal systems support native country-local form and deprecated legacy aliases', async () => {
    const postalSystemSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'enums/postal-system.json'));
    if (!postalSystemSchema.enum?.includes('postal_code') || !postalSystemSchema.enum?.includes('zip')) {
      return 'postal-system enum must include native country-local systems such as postal_code and zip';
    }

    if (!postalSystemSchema.enum?.includes('us_zip')) {
      return 'postal-system enum must retain legacy country-fused systems for 3.x additive enum compatibility';
    }

    const legacyPostalSystemSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'enums/legacy-postal-system.json'));
    if (!legacyPostalSystemSchema.enum?.includes('us_zip')) {
      return 'legacy-postal-system enum must retain deprecated fused aliases such as us_zip';
    }

    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validateTargeting = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/targeting.json')));
    const validateProductFilters = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/product-filters.json')));
    const validateCapabilities = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'protocol/get-adcp-capabilities-response.json')));
    const validateDimensions = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/forecast-point-dimensions.json')));
    const validateGeoBreakdownSupport = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/geo-breakdown-support.json')));
    const validateDeliveryRequest = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/get-media-buy-delivery-request.json')));
    const validateGeoDeliveryMetrics = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/geo-delivery-metrics.json')));

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

    let result = assertValid(
      validateTargeting,
      {
        geo_postal_areas: [{ country: 'ZA', system: 'postal_code', values: ['2196'] }],
        geo_postal_areas_exclude: [{ country: 'US', system: 'zip', values: ['10001'] }]
      },
      'targeting overlay with native postal areas'
    );
    if (result !== true) return result;

    result = assertValid(
      validateTargeting,
      {
        geo_postal_areas: [{ system: 'us_zip', values: ['10001'] }]
      },
      'targeting overlay with deprecated legacy postal system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateTargeting,
      {
        geo_postal_areas: [{ system: 'postal_code', values: ['2196'] }]
      },
      'targeting overlay with native postal system but no country'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateTargeting,
      {
        geo_postal_areas: [{ country: 'GB', system: 'zip', values: ['SW1A'] }]
      },
      'targeting overlay with wrong country-local postal system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateTargeting,
      {
        geo_postal_areas: [{ country: 'US', system: 'plz', values: ['10001'] }]
      },
      'targeting overlay with another country postal system'
    );
    if (result !== true) return result;

    result = assertValid(
      validateProductFilters,
      {
        required_geo_targeting: [
          { level: 'postal_area', country: 'US', system: 'zip' }
        ],
        postal_areas: [
          { country: 'ZA', system: 'postal_code', values: ['2196'] }
        ]
      },
      'product filters with native postal systems'
    );
    if (result !== true) return result;

    result = assertValid(
      validateProductFilters,
      {
        required_geo_targeting: [
          { level: 'postal_area', system: 'us_zip' }
        ],
        postal_areas: [
          { system: 'us_zip', values: ['10001'] }
        ]
      },
      'product filters with deprecated legacy postal systems'
    );
    if (result !== true) return result;

    result = assertValid(
      validateProductFilters,
      {
        required_geo_targeting: [
          { level: 'metro' },
          { level: 'postal_area' }
        ]
      },
      'product filters preserve level-only geo targeting requests'
    );
    if (result !== true) return result;

    result = assertValid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: {
                us_zip: true,
                US: ['zip', 'zip_plus_four'],
                ZA: ['postal_code']
              }
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with native postal areas'
    );
    if (result !== true) return result;

    result = assertValid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: { us_zip: true }
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with deprecated legacy postal areas'
    );
    if (result !== true) return result;

    result = assertValid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: {}
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with empty postal support map'
    );
    if (result !== true) return result;

    result = assertValid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: { NG: ['postal_code'] }
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with unknown-country fallback postal system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: { GB: ['zip'] }
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with wrong country-local postal system'
    );
    if (result !== true) return result;

    result = assertValid(
      validateDimensions,
      [{ kind: 'geo', geo_level: 'postal_area', country: 'ZA', system: 'postal_code', geo_code: '2196' }],
      'forecast geo dimension with native postal system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateDimensions,
      [{ kind: 'geo', geo_level: 'postal_area', country: 'GB', system: 'zip', geo_code: 'SW1A' }],
      'forecast geo dimension with wrong country-local postal system'
    );
    if (result !== true) return result;

    result = assertValid(
      validateGeoBreakdownSupport,
      { postal_area: { us_zip: true, US: ['zip', 'zip_plus_four'], ZA: ['postal_code'] } },
      'geo breakdown support with native postal systems'
    );
    if (result !== true) return result;

    result = assertValid(
      validateGeoBreakdownSupport,
      { postal_area: {} },
      'geo breakdown support with empty postal support map'
    );
    if (result !== true) return result;

    result = assertValid(
      validateGeoBreakdownSupport,
      { postal_area: { NG: ['postal_code'] } },
      'geo breakdown support with unknown-country fallback postal system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateGeoBreakdownSupport,
      { postal_area: { GB: ['zip'] } },
      'geo breakdown support with wrong country-local postal system'
    );
    if (result !== true) return result;

    result = assertValid(
      validateDeliveryRequest,
      { reporting_dimensions: { geo: { geo_level: 'postal_area', country: 'US', system: 'zip' } } },
      'delivery reporting request with native postal system'
    );
    if (result !== true) return result;

    result = assertValid(
      validateDeliveryRequest,
      { reporting_dimensions: { geo: { geo_level: 'postal_area' } } },
      'delivery reporting request preserves level-only postal requests'
    );
    if (result !== true) return result;

    result = assertValid(
      validateDeliveryRequest,
      { reporting_dimensions: { geo: { geo_level: 'metro' } } },
      'delivery reporting request preserves level-only metro requests'
    );
    if (result !== true) return result;

    result = assertValid(
      validateGeoDeliveryMetrics,
      { geo_level: 'postal_area', country: 'US', system: 'zip', geo_code: '10001', impressions: 1000, spend: 12.5 },
      'geo delivery metrics with native postal system'
    );
    if (result !== true) return result;

    result = assertValid(
      validateGeoDeliveryMetrics,
      { geo_level: 'postal_area', system: 'us_zip', geo_code: '10001', impressions: 1000, spend: 12.5 },
      'geo delivery metrics with deprecated legacy postal system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateGeoDeliveryMetrics,
      { geo_level: 'postal_area', system: 'zip', geo_code: '10001', impressions: 1000, spend: 12.5 },
      'geo delivery metrics with native postal system but no country'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateGeoDeliveryMetrics,
      { geo_level: 'metro', country: 'US', system: 'nielsen_dma', geo_code: '501', impressions: 1000, spend: 12.5 },
      'geo delivery metrics with country on metro row'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: { za_postcode: true }
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with unregistered legacy-like postal key'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: { ZA: ['za_postcode'] }
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with registered country invalid postal system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateCapabilities,
      {
        status: 'completed',
        adcp: {
          major_versions: [3],
          idempotency: { supported: false }
        },
        supported_protocols: ['media_buy'],
        media_buy: {
          execution: {
            targeting: {
              geo_postal_areas: { NG: ['zip'] }
            }
          }
        }
      },
      'get_adcp_capabilities targeting declaration with unknown-country invalid postal system'
    );
    if (result !== true) return result;

    return true;
  });

  // Test 11D: Validate identifier-based place targeting across execution, discovery, and capabilities
  await test('Geo place targeting uses stable identifiers and declares discoverable support', async () => {
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validateTargeting = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/targeting.json')));
    const validateCapabilities = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'protocol/get-adcp-capabilities-response.json')));
    const validateForecastGeo = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/forecast-dimension-geo.json')));
    const validateResolutionRequest = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/get-geo-place-resolution-request.json')));
    const validateResolutionResponse = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'core/get-geo-place-resolution-response.json')));

    const assertValid = (validate, value, label) => {
      if (!validate(value)) {
        return `${label} unexpectedly failed validation: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
      }
      return true;
    };
    const assertInvalid = (validate, value, label) => validate(value)
      ? `${label} unexpectedly passed validation`
      : true;

    let result = assertValid(
      validateTargeting,
      {
        geo_places: [{
          country: 'NL',
          system: 'geonames',
          system_version: '2026-05',
          place_type: 'city',
          values: ['2759794', '2747373'],
          value_labels: {
            '2759794': 'Amsterdam, North Holland, Netherlands',
            '2747373': 'The Hague, South Holland, Netherlands'
          }
        }],
        geo_places_exclude: [{
          country: 'US',
          system: 'https://seller.example/geo/catalogs/places',
          place_type: 'city',
          values: ['san-jose-ca-001']
        }]
      },
      'targeting overlay with place inclusion and exclusion'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateTargeting,
      { geo_places: [{ country: 'NL', system: 'geoname', place_type: 'city', values: ['2759794'] }] },
      'misspelled registered place system'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateTargeting,
      { geo_places: [{ country: 'NL', system: 'geonames', place_type: 'municipalit', values: ['2759794'] }] },
      'misspelled registered place type'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateTargeting,
      { geo_places: [{ country: 'NL', system: 'geonames', place_type: 'city', values: ['Amsterdam'] }] },
      'GeoNames display name used as a targeting identifier'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateTargeting,
      { geo_places: [{ country: 'NL', system: 'geonames', values: ['2759794'] }] },
      'place target without place_type'
    );
    if (result !== true) return result;

    const capabilityBase = {
      status: 'completed',
      adcp: { major_versions: [3], idempotency: { supported: false } },
      supported_protocols: ['media_buy'],
      media_buy: { execution: { targeting: {} } }
    };
    capabilityBase.media_buy.execution.targeting.geo_places = {
      geonames: {
        countries: {
          US: ['city', 'county'],
          NL: ['city', 'municipality'],
          GB: ['city', 'post_town']
        },
        catalog: {
          source: 'https://seller.example/data-sources/geonames-mirror',
          current_version: '2026-05',
          supported_versions: ['2026-05', '2026-04'],
          resolver: {
            url: 'https://seller.example/adcp/geo/resolve/geonames',
            auth: 'seller_credentials',
            protocol: 'adcp_geo_place_resolver_v1'
          }
        }
      },
      'https://seller.example/geo/catalogs/places': {
        countries: { NL: ['city'] },
        catalog: {
          current_version: '2026-q2',
          supported_versions: ['2026-q2'],
          resolver: {
            url: 'https://seller.example/adcp/geo/resolve/private',
            auth: 'seller_credentials',
            protocol: 'adcp_geo_place_resolver_v1'
          }
        }
      }
    };
    result = assertValid(validateCapabilities, capabilityBase, 'place targeting capability declaration');
    if (result !== true) return result;

    const legacyCartesianCapabilities = JSON.parse(JSON.stringify(capabilityBase));
    legacyCartesianCapabilities.media_buy.execution.targeting.geo_places.geonames = {
      countries: ['US', 'NL'],
      place_types: ['city', 'municipality'],
      supports_system_version: true
    };
    result = assertInvalid(validateCapabilities, legacyCartesianCapabilities, 'legacy Cartesian place support declaration');
    if (result !== true) return result;

    const typoCapabilities = JSON.parse(JSON.stringify(capabilityBase));
    typoCapabilities.media_buy.execution.targeting.geo_places.geoname =
      typoCapabilities.media_buy.execution.targeting.geo_places.geonames;
    delete typoCapabilities.media_buy.execution.targeting.geo_places.geonames;
    result = assertInvalid(validateCapabilities, typoCapabilities, 'misspelled capability system key');
    if (result !== true) return result;

    const invalidCapabilities = JSON.parse(JSON.stringify(capabilityBase));
    delete invalidCapabilities.media_buy.execution.targeting.geo_places.geonames.countries.NL;
    invalidCapabilities.media_buy.execution.targeting.geo_places.geonames.countries.NL = [];
    result = assertInvalid(validateCapabilities, invalidCapabilities, 'place support with an empty country type list');
    if (result !== true) return result;

    const catalogCapabilitySchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/geo-place-catalog-capability.json'));
    const membershipRule = catalogCapabilitySchema['x-adcp-validation']?.member_of;
    if (membershipRule?.field !== 'current_version' || membershipRule?.array_field !== 'supported_versions') {
      return 'geo-place-catalog-capability must declare current_version membership validation';
    }
    const geonamesCatalog = capabilityBase.media_buy.execution.targeting.geo_places.geonames.catalog;
    if (!geonamesCatalog.supported_versions.includes(geonamesCatalog.current_version)) {
      return 'valid capability fixture current_version must be in supported_versions';
    }
    const invalidCatalogMembership = {
      current_version: '2026-03',
      supported_versions: ['2026-05', '2026-04']
    };
    if (invalidCatalogMembership.supported_versions.includes(invalidCatalogMembership.current_version)) {
      return 'semantic catalog membership validation must reject an undeclared current_version';
    }

    const areaSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/geo-place-area.json'));
    const labelRule = areaSchema['x-adcp-validation']?.map_keys_subset_of_array;
    if (labelRule?.map_field !== 'value_labels' || labelRule?.array_field !== 'values') {
      return 'geo-place-area must declare value_labels key membership validation';
    }
    const labelsAreSubset = (area) => Object.keys(area.value_labels || {}).every(value => area.values.includes(value));
    if (labelsAreSubset({ values: ['2759794'], value_labels: { '999999': 'Wrong place' } })) {
      return 'semantic value_labels validation must reject labels for absent values';
    }

    const targetingSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/targeting.json'));
    const disjointRule = targetingSchema['x-adcp-validation']?.disjoint_place_fields;
    if (disjointRule?.include !== 'geo_places' || disjointRule?.exclude !== 'geo_places_exclude') {
      return 'targeting schema must declare geo place include/exclude disjointness validation';
    }
    if (JSON.stringify(disjointRule.identity) !== JSON.stringify(['country', 'system', 'place_type', 'value'])) {
      return 'geo place include/exclude identity must exclude catalog version';
    }
    const placeIdentitySet = (areas) => new Set((areas || []).flatMap(area =>
      area.values.map(value => [area.country, area.system, area.place_type, value].join('\u0000'))));
    const hasPlaceOverlap = overlay => {
      const included = placeIdentitySet(overlay.geo_places);
      return [...placeIdentitySet(overlay.geo_places_exclude)].some(identity => included.has(identity));
    };
    if (!hasPlaceOverlap({
      geo_places: [{ country: 'NL', system: 'geonames', system_version: '2026-05', place_type: 'city', values: ['2759794'] }],
      geo_places_exclude: [{ country: 'NL', system: 'geonames', system_version: '2026-04', place_type: 'city', values: ['2759794'] }]
    })) {
      return 'semantic place overlap validation must reject cross-version overlap';
    }

    result = assertValid(
      validateResolutionRequest,
      { q: 'Amsterdam', country: 'NL', subdivision: 'NL-NH', place_type: 'city', locale: 'nl-NL', limit: 20 },
      'place resolution request with disambiguation context'
    );
    if (result !== true) return result;

    result = assertValid(
      validateResolutionRequest,
      { value: '2759794', country: 'NL', place_type: 'city', system_version: '2026-05' },
      'place identifier lifecycle refresh request'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateResolutionRequest,
      { q: 'Amsterdam', value: '2759794', country: 'NL' },
      'place resolution request containing both name and identifier'
    );
    if (result !== true) return result;

    const resolutionResponse = {
        request: {
          q: 'Amsterdam',
          country: 'NL',
          subdivision: 'NL-NH',
          place_type: 'city',
          system_version: '2026-05'
        },
        system: 'geonames',
        system_version: '2026-05',
        matches: [{
          value: '2759794',
          country: 'NL',
          subdivision: 'NL-NH',
          place_type: 'city',
          label: 'Amsterdam',
          canonical_name: 'Amsterdam, North Holland, Netherlands',
          parent_labels: ['North Holland', 'Netherlands'],
          status: 'active'
        }, {
          value: '9999999',
          country: 'NL',
          subdivision: 'NL-NH',
          place_type: 'city',
          label: 'Old Amsterdam target',
          canonical_name: 'Old Amsterdam target, Netherlands',
          parent_labels: ['Netherlands'],
          status: 'deprecated',
          replaced_by_values: ['2759794']
        }]
      };
    result = assertValid(
      validateResolutionResponse,
      resolutionResponse,
      'place resolution response with lifecycle replacement metadata'
    );
    if (result !== true) return result;

    const bindingRule = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/get-geo-place-resolution-response.json'))['x-adcp-validation']?.resolver_response_binding;
    if (bindingRule?.system !== 'capability_key' || !bindingRule?.match_fields?.includes('subdivision')) {
      return 'place resolution response must declare capability/request binding semantics';
    }
    const responseMatchesResolverContract = (response, capabilitySystem, currentVersion) => {
      const request = response.request;
      const expectedVersion = request.system_version || currentVersion;
      return response.system === capabilitySystem
        && response.system_version === expectedVersion
        && response.matches.every(match => match.country === request.country
          && (!request.subdivision || match.subdivision === request.subdivision)
          && (!request.place_type || match.place_type === request.place_type));
    };
    if (!responseMatchesResolverContract(resolutionResponse, 'geonames', '2026-05')) {
      return 'valid resolver response fixture must bind to capability and normalized request';
    }
    const mismatchedResolverResponse = JSON.parse(JSON.stringify(resolutionResponse));
    mismatchedResolverResponse.matches[0].subdivision = 'NL-ZH';
    if (responseMatchesResolverContract(mismatchedResolverResponse, 'geonames', '2026-05')) {
      return 'resolver response binding must reject a match outside the requested subdivision';
    }

    const rawNameResponse = JSON.parse(JSON.stringify(resolutionResponse));
    rawNameResponse.matches[0].value = 'Amsterdam';
    result = assertInvalid(
      validateResolutionResponse,
      rawNameResponse,
      'registered-system resolver response containing a raw name'
    );
    if (result !== true) return result;

    const missingDisambiguationResponse = JSON.parse(JSON.stringify(resolutionResponse));
    delete missingDisambiguationResponse.matches[0].canonical_name;
    result = assertInvalid(
      validateResolutionResponse,
      missingDisambiguationResponse,
      'resolver response without required canonical disambiguation name'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateResolutionRequest,
      { q: 'Springfield' },
      'place resolution request without country disambiguation'
    );
    if (result !== true) return result;

    result = assertInvalid(
      validateForecastGeo,
      { kind: 'geo', geo_level: 'place', country: 'NL', system: 'geonames', geo_code: '2759794' },
      'place reporting row before reporting support is standardized'
    );
    if (result !== true) return result;

    return true;
  });

  // Test 12: Validate ForecastPoint dimension and viewability compatibility gates
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
      [[{ kind: 'geo', geo_level: 'postal_area', system: 'us_zip', geo_code: '10001' }], 'postal dimension with deprecated legacy postal-system'],
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
      [[{ kind: 'geo', geo_level: 'metro', system: 'us_zip', geo_code: '10001' }], 'metro dimension with deprecated legacy postal-system'],
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

    let result;
    for (const [value, label] of [
      [{ metrics: { coverage_rate: { mid: 1.2 } } }, 'coverage_rate mid above 1.0'],
      [{ metrics: { coverage_rate: { low: 1.5, high: 2.0 } } }, 'coverage_rate low/high above 1.0'],
      [{ metrics: { coverage_rate: { low: 0.2, high: 1.5 } } }, 'coverage_rate high above 1.0']
    ]) {
      result = assertInvalid(validateForecastPoint, value, label);
      if (result !== true) return result;
    }

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

    result = assertValid(
      validateSignalCoverageForecast,
      {
        ...signalCoverageForecast,
        points: [
          {
            label: 'present',
            dimensions: [
              { kind: 'signal', signal_ref: { scope: 'data_provider', data_provider_domain: 'pinnacle-data.example', signal_id: 'weather' }, presence: 'present' }
            ],
            metrics: {
              impressions: { mid: 720000 },
              coverage_rate: { mid: 0.72 }
            }
          }
        ]
      },
      'signal coverage forecast present bucket without signal_value'
    );
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
      for (const key of ['low', 'mid', 'high']) {
        const values = forecast.points.map(point => point.metrics?.coverage_rate?.[key]);
        if (values.every(value => value === undefined)) continue;
        if (values.some(value => typeof value !== 'number')) return false;
        if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) >= 0.000001) return false;
      }
      return true;
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

    if (!completeExclusiveCoverageRatesPartition({
      ...signalCoverageForecast,
      bucket_completeness: 'complete',
      points: [
        {
          ...signalCoverageForecast.points[0],
          metrics: { coverage_rate: { low: 0.25, mid: 0.28, high: 0.3 } }
        },
        {
          ...signalCoverageForecast.points[1],
          label: 'present',
          metrics: { coverage_rate: { low: 0.75, mid: 0.72, high: 0.7 } }
        }
      ]
    })) {
      return 'complete exclusive coverage partition with low/mid/high rates summing to 1 was incorrectly flagged';
    }

    if (completeExclusiveCoverageRatesPartition({
      ...signalCoverageForecast,
      bucket_completeness: 'complete',
      points: [
        {
          ...signalCoverageForecast.points[0],
          metrics: { coverage_rate: { low: 0.25, mid: 0.28, high: 0.3 } }
        },
        {
          ...signalCoverageForecast.points[1],
          label: 'present',
          metrics: { coverage_rate: { low: 0.7, mid: 0.72, high: 0.7 } }
        }
      ]
    })) {
      return 'complete exclusive coverage partition must have coverage_rate low values summing to 1 when lows are supplied';
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
            coverage_forecast: signalCoverageForecast,
            deployments: []
          }
        ]
      },
      'get_signals response with coverage_forecast and no legacy coverage_percentage'
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

  // Test 12B: VAST/DAAST tag URLs accept unsubstituted ad-server macros
  await test('VAST and DAAST tag URLs accept [MACRO] and ${MACRO} placeholders', async () => {
    // Real-world IAS-wrapped CTV tag: [OMIDPARTNER]-style VAST macros and
    // ${GDPR_CONSENT}-style privacy macros are illegal in strict RFC 3986 URIs
    // but valid RFC 6570 templates. format: "uri" rejected these; the tag
    // asset URLs must use format: "uri-template" (same convention as url-asset).
    const macroUrl = 'https://unified.adsafeprotected.com/v2/2816045/94180721?mon=94180722&omidPartner=[OMIDPARTNER]&apiframeworks=[APIFRAMEWORKS]&bundleId=[BUNDLEID]&blockedAdTracking=${DC_BLOCKED_AD}&ias_dts=atw&ias_xappb=[ctv_appid]&originalVast=https://vast.extremereach.io/v/16115077?us_privacy=${US_PRIVACY}&gdpr=${GDPR}&gdpr_consent=${GDPR_CONSENT_1002}&gpp=${GPP_STRING_1002}&gpp_sid=${GPP_SID}&er_did=[INSERT_DEVICE_ID_HERE]&ba_cb=[INSERT_CACHEBREAKER_HERE]';

    const cases = [
      ['core/assets/vast-asset.json', { asset_type: 'vast', delivery_type: 'url', url: macroUrl }],
      ['core/assets/daast-asset.json', { asset_type: 'daast', delivery_type: 'url', url: macroUrl }]
    ];

    for (const [schemaFile, asset] of cases) {
      const assetSchema = loadSchema(path.join(SCHEMA_BASE_DIR, schemaFile));
      const testAjv = new Ajv({
        allErrors: true,
        verbose: true,
        strict: false,
        discriminator: true,
        loadSchema: loadExternalSchema
      });
      addFormats(testAjv);

      const validate = await testAjv.compileAsync(assetSchema);
      if (!validate(asset)) {
        const errors = validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ');
        return `${schemaFile}: macro-laden tag URL must validate: ${errors}`;
      }

      const malformed = { ...asset, url: 'not a valid uri template' };
      if (validate(malformed)) {
        return `${schemaFile}: url with raw spaces must still be rejected`;
      }
    }
    return true;
  });

  // Test 12C: Revenue-share pricing is contingent and formula-verifiable
  await test('Revenue-share pricing validates its contingent billing contract', async () => {
    const testAjv = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
      discriminator: true,
      loadSchema: loadExternalSchema
    });
    addFormats(testAjv);

    const validatePricing = await testAjv.compileAsync(
      loadSchema(path.join(SCHEMA_BASE_DIR, 'core/pricing-option.json'))
    );
    const base = {
      pricing_option_id: 'affiliate_purchase_4pct',
      pricing_model: 'revenue_share',
      event_type: 'purchase',
      event_source_id: 'affiliate_attribution',
      commission_rate: 0.04,
      currency: 'USD',
      commission_basis_description: 'Net merchandise value after discounts; returns removed before commission lock.'
    };

    if (!validatePricing(base)) {
      return `valid revenue-share option failed: ${validatePricing.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const invalidCases = [
      [{ ...base, commission_rate: 0 }, 'zero commission rate'],
      [{ ...base, commission_rate: 1.01 }, 'commission rate above one'],
      [{ ...base, event_source_id: undefined }, 'missing event source'],
      [{ ...base, commission_basis_description: undefined }, 'missing commission basis'],
      [{ ...base, fixed_price: 4 }, 'fixed_price on contingent pricing'],
      [{ ...base, floor_price: 1 }, 'floor_price on contingent pricing'],
      [{ ...base, custom_event_name: 'purchase_complete' }, 'custom event name on non-custom event'],
      [{ ...base, event_type: 'custom' }, 'custom event without custom_event_name']
    ];
    for (const [value, label] of invalidCases) {
      if (validatePricing(value)) return `${label} unexpectedly validated`;
    }

    const custom = { ...base, event_type: 'custom', custom_event_name: 'qualified_purchase' };
    if (!validatePricing(custom)) {
      return `custom revenue-share event failed: ${validatePricing.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const validateFilters = await testAjv.compileAsync(
      loadSchema(path.join(SCHEMA_BASE_DIR, 'core/product-filters.json'))
    );
    if (!validateFilters({ pricing_structures: ['contingent'] })) {
      return `contingent pricing filter failed: ${validateFilters.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    if (validateFilters({ pricing_structures: ['variable'] })) {
      return 'unknown pricing structure unexpectedly validated';
    }

    const availableMetric = loadSchema(path.join(SCHEMA_BASE_DIR, 'enums/available-metric.json'));
    if (!availableMetric.enum.includes('commissionable_value')) {
      return 'commissionable_value is missing from available-metric enum';
    }

    const validateUsage = await testAjv.compileAsync(
      loadSchema(path.join(SCHEMA_BASE_DIR, 'account/report-usage-request.json'))
    );
    const usage = {
      idempotency_key: '3c1f7987-b2dc-4ee9-a391-2f761d8aca4c',
      reporting_period: {
        start: '2026-07-01T00:00:00Z',
        end: '2026-07-31T23:59:59Z'
      },
      usage: [{
        account: { account_id: 'acct_affiliate' },
        media_buy_id: 'mb_affiliate',
        pricing_option_id: 'affiliate_purchase_4pct',
        conversions: 320,
        conversion_value: 125000,
        commissionable_value: 112500,
        vendor_cost: 4500,
        currency: 'USD'
      }]
    };
    if (!validateUsage(usage)) {
      return `revenue-share usage failed: ${validateUsage.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    return true;
  });

  await test('build_creative accepts canonical capability selectors and rejects mixed legacy selectors', async () => {
    const requestSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'media-buy/build-creative-request.json'));
    const testAjv = new Ajv({ allErrors: true, verbose: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(testAjv);
    const validate = await testAjv.compileAsync(requestSchema);

    const canonical = {
      idempotency_key: '8c4ec74d-8f7f-4d06-a4f3-bbe463631d9a',
      target_capability_id: 'streamhaus_vertical_video',
      message: 'Create a concise vertical video.'
    };
    if (!validate(canonical)) {
      return `canonical selector rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const mixed = {
      ...canonical,
      target_format_id: { agent_url: 'https://legacy-creative.example/mcp', id: 'vertical_video' }
    };
    if (validate(mixed)) {
      return 'request mixing target_capability_id and target_format_id must be rejected';
    }

    const noTarget = {
      idempotency_key: 'd1c52370-3cd7-4fd2-a637-76620b1d5f87',
      message: 'This request has no output route.'
    };
    if (validate(noTarget)) {
      return 'non-refinement build without a target selector must be rejected';
    }

    const refinement = {
      idempotency_key: 'd4751ca7-5e64-4b74-b421-19e853b8a341',
      refine_from_build_variant_id: 'variant_parent_1',
      message: 'Make the headline shorter.'
    };
    if (!validate(refinement)) {
      return `refinement with inherited target rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    if (validate({ ...refinement, target_capability_id: 'streamhaus_vertical_video' })) {
      return 'refinement must reject a conflicting explicit target selector';
    }
    if (validate({ ...refinement, transformer_id: 'different_transformer' })) {
      return 'refinement must reject a conflicting explicit transformer selector';
    }

    const legacy = {
      idempotency_key: '41f9eb33-bd37-4d46-bc76-a6de1e29f3bc',
      target_format_id: { agent_url: 'https://legacy-creative.example/mcp', id: 'vertical_video' },
      message: 'Legacy compatibility build.'
    };
    if (!validate(legacy)) {
      return `deprecated selector compatibility rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    return true;
  });

  await test('preview_creative routes canonical preview capabilities without mixing legacy selectors', async () => {
    const requestSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'creative/preview-creative-request.json'));
    const testAjv = new Ajv({ allErrors: true, verbose: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(testAjv);
    const validate = await testAjv.compileAsync(requestSchema);
    const manifest = {
      format_kind: 'image',
      assets: {
        image_main: { asset_type: 'image', url: 'https://cdn.acme.example/banner.png', width: 300, height: 250 }
      }
    };

    const canonical = {
      request_type: 'single',
      creative_manifest: manifest,
      target_capability_id: 'image_preview'
    };
    if (!validate(canonical)) {
      return `canonical preview selector rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    const legacy = {
      request_type: 'single',
      creative_manifest: manifest,
      format_id: { agent_url: 'https://legacy-creative.example/mcp', id: 'display_300x250' }
    };
    if (!validate(legacy)) {
      return `legacy preview route rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    if (validate({ ...canonical, format_id: legacy.format_id })) {
      return 'preview request mixing target_capability_id and format_id must be rejected';
    }

    const libraryCreative = {
      request_type: 'single',
      creative_id: 'stored_image_creative',
      target_capability_id: 'image_preview'
    };
    if (!validate(libraryCreative)) {
      return `single library creative preview rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    if (validate({ ...canonical, creative_id: 'conflicting_library_creative' })) {
      return 'single preview must select exactly one of creative_manifest or creative_id';
    }

    const batch = {
      request_type: 'batch',
      target_capability_id: 'default_preview',
      requests: [
        { creative_manifest: manifest },
        { creative_id: 'stored_square_creative', target_capability_id: 'square_preview' }
      ]
    };
    if (!validate(batch)) {
      return `canonical batch preview selectors rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    if (validate({
      request_type: 'batch',
      requests: [{ creative_manifest: manifest, creative_id: 'conflicting_library_creative' }]
    })) {
      return 'batch preview items must select exactly one of creative_manifest or creative_id';
    }
    if (validate({
      request_type: 'batch',
      target_capability_id: 'default_preview',
      requests: [{ creative_manifest: manifest, format_id: legacy.format_id }]
    })) {
      return 'batch preview must not mix a canonical default with a legacy item route';
    }
    return true;
  });

  await test('validate_input accepts agent-local capability targets and echoes them in results', async () => {
    const testAjv = new Ajv({ allErrors: true, verbose: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(testAjv);
    const validateRequest = await testAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'creative/validate-input-request.json')));
    const request = {
      manifest: { format_kind: 'image', assets: {} },
      targets: [{ kind: 'capability', id: 'publisher_image_validator' }]
    };
    if (!validateRequest(request)) {
      return `capability validation target rejected: ${validateRequest.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    if (validateRequest({ ...request, targets: [{ kind: 'capability', id: 'invalid capability id' }] })) {
      return 'malformed capability validation target must be rejected';
    }

    const resultAjv = new Ajv({ allErrors: true, verbose: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(resultAjv);
    const validateResult = await resultAjv.compileAsync(loadSchema(path.join(SCHEMA_BASE_DIR, 'creative/validate-input-result.json')));
    if (!validateResult({ target: { kind: 'capability', id: 'publisher_image_validator' }, result_kind: 'validated_pass' })) {
      return `capability validation result rejected: ${validateResult.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    if (validateResult({ target: { kind: 'capability', id: 'invalid capability id' }, result_kind: 'validated_pass' })) {
      return 'malformed capability validation result target must be rejected';
    }
    return true;
  });

  await test('creative capability catalogs preserve 3.x compatibility while supporting canonical routes', async () => {
    const schema = loadSchema(path.join(SCHEMA_BASE_DIR, 'protocol/get-adcp-capabilities-response.json'));
    const testAjv = new Ajv({ allErrors: true, verbose: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(testAjv);
    const validate = await testAjv.compileAsync(schema);
    const base = {
      status: 'completed',
      adcp: { major_versions: [3], idempotency: { supported: false } },
      supported_protocols: ['creative']
    };

    if (!validate({ ...base, creative: { supports_generation: true } })) {
      return `legacy build flag without supported_formats rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    if (!validate({ ...base, creative: { has_creative_library: true, supported_formats: [] } })) {
      return `stateful library without build operations rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    if (!validate({
      ...base,
      creative: {
        supports_generation: true,
        supported_formats: [{
          capability_id: 'image_preview',
          operations: ['preview'],
          format: { format_kind: 'image', params: {} }
        }]
      }
    })) {
      return `legacy build flag with preview-only catalog rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    if (!validate({
      ...base,
      creative: { supported_formats: [{ format: { format_kind: 'image', params: {} } }] }
    })) return `legacy catalog entry without capability metadata rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;

    const canonical = {
      ...base,
      creative: {
        supports_generation: true,
        supported_formats: [{
          capability_id: 'image_builder',
          operations: ['build'],
          format: { format_kind: 'image', params: {} }
        }]
      }
    };
    if (!validate(canonical)) {
      return `creative operation catalog rejected: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }

    if (!validate({ ...base, creative: { supports_compliance: true } })) {
      return `non-operation creative capability unexpectedly requires supported_formats: ${validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ')}`;
    }
    return true;
  });

  await test('canonical transformer outputs reference creative capability IDs', async () => {
    const transformerSchema = loadSchema(path.join(SCHEMA_BASE_DIR, 'core/transformer.json'));
    const testAjv = new Ajv({ allErrors: true, verbose: true, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(testAjv);
    const validate = await testAjv.compileAsync(transformerSchema);
    const transformer = {
      transformer_id: 'vertical_video_builder',
      name: 'Vertical video builder',
      output_capability_ids: ['streamhaus_vertical_video'],
      params: []
    };
    if (!validate(transformer)) {
      return validate.errors.map(err => `${err.instancePath} ${err.message}`).join('; ');
    }
    return true;
  });

  // Test 13: Validate schema examples against their schemas
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
