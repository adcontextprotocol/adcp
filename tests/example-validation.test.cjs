#!/usr/bin/env node
/**
 * Example data validation tests
 * Validates that example data from documentation matches the schemas
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

// Initialize AJV with formats
const ajv = new Ajv({ 
  allErrors: true,
  verbose: true,
  strict: false
});
addFormats(ajv);

// Schema loader for resolving $ref
async function loadExternalSchema(uri) {
  if (uri.startsWith('/schemas/source/')) {
    const schemaPath = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/source/', ''));
    try {
      const content = fs.readFileSync(schemaPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`Failed to load referenced schema ${uri}: ${error.message}`);
    }
  }
  throw new Error(`Cannot load external schema: ${uri}`);
}

// Load all schemas with async compilation
const schemas = {};
async function loadSchemas(dir) {
  const items = fs.readdirSync(dir);
  
  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);
    
    if (stat.isDirectory()) {
      await loadSchemas(itemPath);
    } else if (item.endsWith('.json') && item !== 'index.json') {
      try {
        const schema = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
        if (schema.$id) {
          // Create a fresh AJV instance for each schema to avoid conflicts
          const schemaAjv = new Ajv({ 
            allErrors: true,
            verbose: true,
            strict: false,
            loadSchema: loadExternalSchema
          });
          addFormats(schemaAjv);
          
          schemas[schema.$id] = await schemaAjv.compileAsync(schema);
        }
      } catch (error) {
        console.error(`Failed to load schema ${itemPath}: ${error.message}`);
      }
    }
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

function test(description, testFn) {
  totalTests++;
  try {
    const result = testFn();
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

function validateAgainstSchema(data, schemaId, dataDescription) {
  const validator = schemas[schemaId];
  if (!validator) {
    throw new Error(`Schema not found: ${schemaId}`);
  }
  
  const isValid = validator(data);
  if (!isValid) {
    const errors = validator.errors.map(err => 
      `${err.instancePath || 'root'}: ${err.message}`
    ).join('; ');
    return `${dataDescription} - Validation errors: ${errors}`;
  }
  
  return true;
}

// Example data from documentation
const exampleData = {
  // Core data models
  product: {
    "product_id": "ctv_sports_premium",
    "name": "CTV Sports Premium",
    "description": "Premium CTV inventory on sports content",
    "format_ids": ["video_16x9_30s"],
    "delivery_type": "guaranteed",
    "is_fixed_price": true,
    "cpm": 45.00,
    "min_spend": 10000
  },
  
  mediaBuy: {
    "media_buy_id": "mb_12345",
    "status": "active",
    "promoted_offering": "Nike Air Max 2024 - latest innovation in cushioning",
    "total_budget": 50000,
    "packages": []
  },
  
  package: {
    "package_id": "pkg_ctv_001",
    "status": "active"
  },
  
  creativeAsset: {
    "creative_id": "hero_video_30s",
    "name": "Nike Air Max Hero 30s",
    "format": "video"
  },
  
  targeting: {
    "geo_countries": ["US"],
    "geo_metros_exclude": [
      { "system": "nielsen_dma", "values": ["602"] }
    ]
  },
  
  budget: {
    "total": 50000,
    "currency": "USD",
    "pacing": "even"
  },
  
  frequencyCap: {
    "suppress_minutes": 1440
  },
  
  format: {
    "format_id": "video_standard_30s",
    "name": "Standard Video - 30 seconds"
  },
  
  measurement: {
    "type": "incremental_sales_lift",
    "attribution": "deterministic_purchase",
    "reporting": "weekly_dashboard"
  },
  
  creativePolicy: {
    "co_branding": "optional",
    "landing_page": "any",
    "templates_available": true
  },
  
  error: {
    "code": "INVALID_REQUEST",
    "message": "Missing required field"
  },
  
  response: {
    "message": "Operation completed successfully"
  },
  
  // Request/Response examples
  getProductsRequest: {
    "promoted_offering": "Nike Air Max 2024 - latest innovation in cushioning",
    "brief": "Premium video inventory for sports fans"
  },
  
  getProductsResponse: {
    "products": [
      {
        "product_id": "ctv_sports_premium",
        "name": "CTV Sports Premium",
        "description": "Premium CTV inventory on sports content",
        "format_ids": ["video_16x9_30s"],
        "delivery_type": "guaranteed",
        "is_fixed_price": true,
        "cpm": 45.00,
        "min_spend": 10000
      }
    ]
  },
  
  createMediaBuyRequest: {
    "buyer_ref": "nike_q1_campaign_2024",
    "account_id": "acc_nike_001",
    "packages": [
      {
        "buyer_ref": "nike_ctv_sports_package",
        "products": ["ctv_sports_premium"]
      }
    ],
    "promoted_offering": "Nike Air Max 2024 - latest innovation in cushioning",
    "po_number": "PO-2024-001",
    "start_time": "2024-01-01T00:00:00Z",
    "end_time": "2024-01-31T23:59:59Z",
    "budget": {
      "total": 50000,
      "currency": "USD"
    }
  },
  
  createMediaBuyResponse: {
    "media_buy_id": "mb_12345",
    "buyer_ref": "nike_q1_campaign_2024",
    "packages": [
      {
        "package_id": "pkg_12345_001",
        "buyer_ref": "nike_ctv_sports_package"
      }
    ]
  },

  createMediaBuyRequestNoAccountId: {
    "buyer_ref": "single_account_campaign",
    "packages": [
      {
        "buyer_ref": "display_package",
        "products": ["display_premium_sites"]
      }
    ],
    "start_time": "2024-01-01T00:00:00Z",
    "end_time": "2024-01-31T23:59:59Z",
    "brand": {
      "domain": "acmecorp.com"
    }
  },

  createMediaBuyRequestAsap: {
    "buyer_ref": "acme_flash_sale_campaign",
    "account_id": "acc_acme_001",
    "packages": [
      {
        "buyer_ref": "acme_display_package",
        "products": ["display_premium_sites"],
        "format_ids": ["display_300x250"]
      }
    ],
    "promoted_offering": "Acme Flash Sale - 24-hour limited time offer",
    "start_time": "asap",
    "end_time": "2024-10-03T23:59:59Z",
    "budget": {
      "total": 25000,
      "currency": "USD",
      "pacing": "asap"
    }
  },
  
  // Signals examples
  getSignalsRequest: {
    "signal_spec": "High-income households interested in luxury goods",
    "deliver_to": {
      "platforms": ["the-trade-desk", "amazon-dsp"],
      "countries": ["US"]
    }
  },
  
  getSignalsResponse: {
    "signals": [
      {
        "signal_agent_segment_id": "luxury_auto_intenders",
        "name": "Luxury Automotive Intenders",
        "description": "High-income individuals researching luxury vehicles",
        "signal_type": "marketplace",
        "data_provider": "Experian",
        "coverage_percentage": 12,
        "deployments": [
          {
            "platform": "the-trade-desk",
            "account": null,
            "is_live": true,
            "scope": "platform-wide",
            "decisioning_platform_segment_id": "ttd_exp_lux_auto_123"
          }
        ],
        "pricing": {
          "cpm": 3.50,
          "currency": "USD"
        }
      }
    ]
  },
  
  activateSignalRequest: {
    "signal_agent_segment_id": "luxury_auto_intenders",
    "platform": "the-trade-desk",
    "account": "agency-123-ttd"
  },
  
  activateSignalResponse: {
    "task_id": "activation_789",
    "status": "pending",
    "decisioning_platform_segment_id": "ttd_agency123_lux_auto"
  }
};

// Main test execution
async function runTests() {
  log('🧪 Starting Example Data Validation Tests', 'info');
  log('===========================================');

  // Load all schemas first
  await loadSchemas(SCHEMA_BASE_DIR);

  // Core data model tests
  test('Product example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.product, 
    '/schemas/source/core/product.json', 
    'Product example'
  );
});

test('Media Buy example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.mediaBuy, 
    '/schemas/source/core/media-buy.json', 
    'Media Buy example'
  );
});

test('Package example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.package, 
    '/schemas/source/core/package.json', 
    'Package example'
  );
});

test('Creative Asset example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.creativeAsset, 
    '/schemas/source/core/creative-asset.json', 
    'Creative Asset example'
  );
});

test('Targeting example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.targeting, 
    '/schemas/source/core/targeting.json', 
    'Targeting example'
  );
});

test('Frequency Cap example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.frequencyCap, 
    '/schemas/source/core/frequency-cap.json', 
    'Frequency Cap example'
  );
});

test('Format example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.format, 
    '/schemas/source/core/format.json', 
    'Format example'
  );
});

test('Measurement example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.measurement, 
    '/schemas/source/core/measurement.json', 
    'Measurement example'
  );
});

test('Creative Policy example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.creativePolicy, 
    '/schemas/source/core/creative-policy.json', 
    'Creative Policy example'
  );
});

test('Error example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.error, 
    '/schemas/source/core/error.json', 
    'Error example'
  );
});

test('Response example validates against schema', () => {
  return validateAgainstSchema(
    exampleData.response, 
    '/schemas/source/core/response.json', 
    'Response example'
  );
});

// Request/Response tests
test('get_products request validates against schema', () => {
  return validateAgainstSchema(
    exampleData.getProductsRequest, 
    '/schemas/source/media-buy/get-products-request.json', 
    'get_products request'
  );
});

test('get_products response validates against schema', () => {
  return validateAgainstSchema(
    exampleData.getProductsResponse, 
    '/schemas/source/media-buy/get-products-response.json', 
    'get_products response'
  );
});

test('create_media_buy request validates against schema', () => {
  return validateAgainstSchema(
    exampleData.createMediaBuyRequest, 
    '/schemas/source/media-buy/create-media-buy-request.json', 
    'create_media_buy request'
  );
});

test('create_media_buy response validates against schema', () => {
  return validateAgainstSchema(
    exampleData.createMediaBuyResponse,
    '/schemas/source/media-buy/create-media-buy-response.json',
    'create_media_buy response'
  );
});

test('create_media_buy request without account_id validates against schema', () => {
  return validateAgainstSchema(
    exampleData.createMediaBuyRequestNoAccountId,
    '/schemas/source/media-buy/create-media-buy-request.json',
    'create_media_buy request without account_id'
  );
});

test('create_media_buy request with ASAP start validates against schema', () => {
  return validateAgainstSchema(
    exampleData.createMediaBuyRequestAsap,
    '/schemas/source/media-buy/create-media-buy-request.json',
    'create_media_buy request with ASAP start'
  );
});

test('get_signals request validates against schema', () => {
  return validateAgainstSchema(
    exampleData.getSignalsRequest, 
    '/schemas/source/signals/get-signals-request.json', 
    'get_signals request'
  );
});

test('get_signals response validates against schema', () => {
  return validateAgainstSchema(
    exampleData.getSignalsResponse, 
    '/schemas/source/signals/get-signals-response.json', 
    'get_signals response'
  );
});

test('activate_signal request validates against schema', () => {
  return validateAgainstSchema(
    exampleData.activateSignalRequest, 
    '/schemas/source/signals/activate-signal-request.json', 
    'activate_signal request'
  );
});

test('activate_signal response validates against schema', () => {
  return validateAgainstSchema(
    exampleData.activateSignalResponse, 
    '/schemas/source/signals/activate-signal-response.json', 
    'activate_signal response'
  );
});

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