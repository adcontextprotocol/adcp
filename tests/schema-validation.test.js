#!/usr/bin/env node
/**
 * JSON Schema validation test suite
 * Validates that all schemas are syntactically correct and cross-references resolve
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/v1');

// Initialize AJV with formats and custom loader
const ajv = new Ajv({ 
  allErrors: true,
  verbose: true,
  strict: false, // Allow some flexibility for our schema structure
  loadSchema: loadExternalSchema
});
addFormats(ajv);

// Schema loader for resolving $ref
async function loadExternalSchema(uri) {
  if (uri.startsWith('/schemas/v1/')) {
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/v1/', ''));
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
  if (!schema.$id.startsWith('/schemas/v1/')) {
    return `Invalid $id format: ${schema.$id} (should start with /schemas/v1/)`;
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
      'product.json': ['product_id', 'name', 'description', 'formats', 'delivery_type', 'is_fixed_price'],
      'media-buy.json': ['media_buy_id', 'status', 'promoted_offering', 'total_budget', 'packages'],
      'package.json': ['package_id', 'status'],
      'creative-asset.json': ['creative_id', 'name', 'format'],
      'error.json': ['code', 'message'],
      'budget.json': ['total', 'currency']
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