#!/usr/bin/env node
/**
 * Simple example data validation tests
 * Validates that basic example data from documentation matches the schemas
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/v1');

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

async function validateExample(data, schemaId, description) {
  totalTests++;
  try {
    // Create fresh AJV instance for each validation
    const ajv = new Ajv({ 
      allErrors: true,
      verbose: false,
      strict: false,
      loadSchema: loadExternalSchema
    });
    addFormats(ajv);
    
    // Load the specific schema
    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/v1/', ''));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    
    // Compile and validate
    const validate = await ajv.compileAsync(schema);
    const isValid = validate(data);
    
    if (isValid) {
      log(`✅ ${description}`, 'success');
      passedTests++;
    } else {
      const errors = validate.errors.map(err => 
        `${err.instancePath || 'root'}: ${err.message}`
      ).join('; ');
      log(`❌ ${description}: ${errors}`, 'error');
      failedTests++;
    }
  } catch (error) {
    log(`❌ ${description}: ${error.message}`, 'error');
    failedTests++;
  }
}

async function runTests() {
  log('🧪 Starting Example Data Validation Tests', 'info');
  log('===========================================');

  // Simple examples that don't depend on complex references
  const simpleExamples = [
    {
      data: { "code": "INVALID_REQUEST", "message": "Missing required field" },
      schema: '/schemas/v1/core/error.json',
      description: 'Error example'
    },
    {
      data: { "message": "Operation completed successfully" },
      schema: '/schemas/v1/core/response.json',
      description: 'Response example'
    },
    {
      data: { "format_id": "video_standard_30s", "name": "Standard Video - 30 seconds", "type": "video" },
      schema: '/schemas/v1/core/format.json',
      description: 'Format example'
    },
    {
      data: { 
        "type": "incremental_sales_lift",
        "attribution": "deterministic_purchase", 
        "reporting": "weekly_dashboard"
      },
      schema: '/schemas/v1/core/measurement.json',
      description: 'Measurement example'
    },
    {
      data: {
        "co_branding": "optional",
        "landing_page": "any",
        "templates_available": true
      },
      schema: '/schemas/v1/core/creative-policy.json',
      description: 'Creative Policy example'
    }
  ];

  // Test simple examples
  for (const example of simpleExamples) {
    await validateExample(example.data, example.schema, example.description);
  }

  // Test request/response examples
  await validateExample(
    {
      "promoted_offering": "Nike Air Max 2024",
      "brief": "Premium video inventory"
    },
    '/schemas/v1/media-buy/get-products-request.json',
    'get_products request'
  );

  await validateExample(
    {
      "signal_spec": "High-income households",
      "deliver_to": {
        "platforms": ["the-trade-desk"],
        "countries": ["US"]
      }
    },
    '/schemas/v1/signals/get-signals-request.json',
    'get_signals request'
  );

  // Print results
  log('\n===========================================');
  log(`Tests completed: ${totalTests}`);
  log(`✅ Passed: ${passedTests}`, 'success');
  log(`❌ Failed: ${failedTests}`, failedTests > 0 ? 'error' : 'success');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    log('\n🎉 All example validation tests passed!', 'success');
  }
}

// Run the tests
runTests().catch(error => {
  log(`Test execution failed: ${error.message}`, 'error');
  process.exit(1);
});