#!/usr/bin/env node
/**
 * Extension schema validation test suite
 * Tests that the typed extension infrastructure is properly configured
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');
const EXTENSIONS_DIR = path.join(SCHEMA_BASE_DIR, 'extensions');

// Initialize AJV with formats and custom loader
const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: false,
  loadSchema: loadExternalSchema
});
addFormats(ajv);

// Schema loader for resolving $ref
async function loadExternalSchema(uri) {
  let relativePath;
  if (uri.startsWith('/schemas/latest/')) {
    relativePath = uri.replace('/schemas/latest/', '');
  } else if (uri.startsWith('/schemas/')) {
    relativePath = uri.replace('/schemas/', '');
  } else {
    throw new Error(`Cannot load external schema: ${uri}`);
  }

  const schemaPath = path.join(SCHEMA_BASE_DIR, relativePath);
  try {
    const content = fs.readFileSync(schemaPath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to load referenced schema ${uri}: ${error.message}`);
  }
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
    if (error.errors) {
      console.error('Validation errors:', JSON.stringify(error.errors, null, 2));
    }
    failedTests++;
  }
}

// Cache for compiled schemas
const schemaCache = new Map();

async function loadAndCompileSchema(schemaPath) {
  if (schemaCache.has(schemaPath)) {
    return schemaCache.get(schemaPath);
  }

  const schemaContent = fs.readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(schemaContent);
  const validate = await ajv.compileAsync(schema);

  schemaCache.set(schemaPath, validate);
  return validate;
}

// Discover extension files (excluding index.json and extension-meta.json)
function discoverExtensionFiles() {
  if (!fs.existsSync(EXTENSIONS_DIR)) {
    return [];
  }

  return fs.readdirSync(EXTENSIONS_DIR)
    .filter(file =>
      file.endsWith('.json') &&
      file !== 'index.json' &&
      file !== 'extension-meta.json'
    )
    .map(file => path.join(EXTENSIONS_DIR, file));
}

async function runTests() {
  log('🧪 Starting Extension Schema Validation Tests');
  log('==============================================');

  // Test 1: Extension directory exists
  await test('Extension directory exists', async () => {
    if (!fs.existsSync(EXTENSIONS_DIR)) {
      throw new Error(`Extension directory not found: ${EXTENSIONS_DIR}`);
    }
    return true;
  });

  // Test 2: Extension index exists and is valid JSON
  await test('Extension index exists and is valid JSON', async () => {
    const indexPath = path.join(EXTENSIONS_DIR, 'index.json');
    if (!fs.existsSync(indexPath)) {
      throw new Error('Extension index.json not found');
    }
    const content = fs.readFileSync(indexPath, 'utf8');
    JSON.parse(content); // Will throw if invalid JSON
    return true;
  });

  // Test 3: Extension index has proper structure
  await test('Extension index has proper structure', async () => {
    const indexPath = path.join(EXTENSIONS_DIR, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    if (!index.$schema) {
      throw new Error('Extension index missing $schema');
    }
    if (!index.$id) {
      throw new Error('Extension index missing $id');
    }
    if (!index.title) {
      throw new Error('Extension index missing title');
    }
    if (typeof index.extensions !== 'object') {
      throw new Error('Extension index missing extensions object');
    }
    if (!index._generated) {
      throw new Error('Extension index should have _generated: true marker');
    }
    return true;
  });

  // Test 4: Extension meta schema exists and is valid
  await test('Extension meta schema exists and is valid', async () => {
    const metaPath = path.join(EXTENSIONS_DIR, 'extension-meta.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error('Extension extension-meta.json not found');
    }
    const content = fs.readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(content);

    // Verify it's a proper schema
    if (!meta.$schema) {
      throw new Error('Extension meta schema missing $schema');
    }
    if (!meta.$id) {
      throw new Error('Extension meta schema missing $id');
    }
    if (!meta.properties.valid_from) {
      throw new Error('Extension meta schema missing valid_from property');
    }
    if (!meta.properties.valid_until) {
      throw new Error('Extension meta schema missing valid_until property');
    }
    return true;
  });

  // Test 5: Product can include arbitrary extension data (untyped)
  await test('Product validates with arbitrary extension data', async () => {
    const validate = await loadAndCompileSchema(
      path.join(SCHEMA_BASE_DIR, 'core/product.json')
    );

    const product = {
      product_id: 'test_product',
      name: 'Test Product',
      description: 'Test description',
      publisher_properties: [{
        publisher_domain: 'example.com',
        selection_type: 'all'
      }],
      format_ids: [{
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_300x250'
      }],
      delivery_type: 'guaranteed',
      delivery_measurement: {
        provider: 'Test Provider'
      },
      pricing_options: [{
        is_fixed: true,
        pricing_option_id: 'fixed_cpm',
        pricing_model: 'cpm',
        rate: 10.00,
        currency: 'USD'
      }],
      ext: {
        custom_vendor: {
          some_field: 'some_value',
          nested: { data: true }
        },
        another_vendor: {
          config: [1, 2, 3]
        }
      }
    };

    const valid = validate(product);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  // Test 6: Extension meta schema validates a sample extension
  await test('Extension meta schema validates sample extension structure', async () => {
    const validate = await loadAndCompileSchema(
      path.join(EXTENSIONS_DIR, 'extension-meta.json')
    );

    const sampleExtension = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/extensions/sustainability.json',
      title: 'Sustainability Extension',
      description: 'Carbon footprint and green certification data',
      valid_from: '2.5',
      docs_url: 'https://docs.adcontextprotocol.org/docs/extensions/sustainability',
      type: 'object',
      properties: {
        carbon_kg_per_impression: { type: 'number' },
        certified_green: { type: 'boolean' }
      }
    };

    const valid = validate(sampleExtension);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  // Test 7: Extension meta schema validates extension with valid_until
  await test('Extension meta schema validates extension with valid_until', async () => {
    const validate = await loadAndCompileSchema(
      path.join(EXTENSIONS_DIR, 'extension-meta.json')
    );

    const sampleExtension = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/extensions/deprecated_feature.json',
      title: 'Deprecated Feature Extension',
      description: 'A feature that was deprecated in version 3.0',
      valid_from: '2.0',
      valid_until: '3.0',
      type: 'object',
      properties: {
        legacy_field: { type: 'string' }
      }
    };

    const valid = validate(sampleExtension);
    if (!valid) {
      throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
    }
    return true;
  });

  // Test 8: Extension meta schema rejects invalid valid_from format
  await test('Extension meta schema rejects invalid valid_from format', async () => {
    const validate = await loadAndCompileSchema(
      path.join(EXTENSIONS_DIR, 'extension-meta.json')
    );

    const invalidExtension = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/extensions/bad_version.json',
      title: 'Bad Version Extension',
      description: 'Has invalid version format',
      valid_from: '2.5.0', // Should be "2.5" not "2.5.0"
      type: 'object',
      properties: {}
    };

    const valid = validate(invalidExtension);
    if (valid) {
      throw new Error('Should have rejected invalid valid_from format (semver patch level not allowed)');
    }
    return true;
  });

  // Test 9: Extension meta schema rejects invalid $id pattern
  await test('Extension meta schema rejects invalid $id pattern', async () => {
    const validate = await loadAndCompileSchema(
      path.join(EXTENSIONS_DIR, 'extension-meta.json')
    );

    const invalidExtension = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/not_an_extension.json', // Wrong path
      title: 'Wrong Path Extension',
      description: 'Has invalid $id path',
      valid_from: '2.5',
      type: 'object',
      properties: {}
    };

    const valid = validate(invalidExtension);
    if (valid) {
      throw new Error('Should have rejected invalid $id pattern');
    }
    return true;
  });

  // Test 10: Reserved namespaces should be rejected by build script validation
  await test('Reserved namespaces are documented', async () => {
    // These namespaces are reserved in scripts/build-schemas.cjs
    const RESERVED_NAMESPACES = ['adcp', 'core', 'protocol', 'schema', 'meta', 'ext', 'context'];

    // Verify none of the reserved namespaces exist as extension files
    for (const reserved of RESERVED_NAMESPACES) {
      const reservedPath = path.join(EXTENSIONS_DIR, `${reserved}.json`);
      if (fs.existsSync(reservedPath)) {
        throw new Error(`Reserved namespace "${reserved}" should not exist as an extension file`);
      }
    }
    return true;
  });

  // Test 11: Discovered extensions validate against meta schema
  const extensionFiles = discoverExtensionFiles();
  if (extensionFiles.length > 0) {
    for (const extensionPath of extensionFiles) {
      const filename = path.basename(extensionPath);
      await test(`Extension file ${filename} validates against meta schema`, async () => {
        const validate = await loadAndCompileSchema(
          path.join(EXTENSIONS_DIR, 'extension-meta.json')
        );

        const content = fs.readFileSync(extensionPath, 'utf8');
        const extension = JSON.parse(content);

        const valid = validate(extension);
        if (!valid) {
          throw new Error(`Validation failed: ${JSON.stringify(validate.errors)}`);
        }
        return true;
      });
    }
  } else {
    await test('No extension files to validate (registry is empty)', async () => {
      log('  ℹ️  No extension files found - this is expected for initial setup', 'warning');
      return true;
    });
  }

  // Summary
  log('');
  log('==============================================');
  log(`Tests completed: ${totalTests}`);
  log(`✅ Passed: ${passedTests}`, 'success');
  if (failedTests > 0) {
    log(`❌ Failed: ${failedTests}`, 'error');
    log('');
    process.exit(1);
  } else {
    log('');
    log('🎉 All extension schema tests passed!', 'success');
    process.exit(0);
  }
}

// Run tests
runTests().catch(error => {
  log(`Fatal error: ${error.message}`, 'error');
  console.error(error);
  process.exit(1);
});
