#!/usr/bin/env node
/**
 * Simple example data validation tests
 * Validates that basic example data from documentation matches the schemas
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.join(__dirname, '../static/schemas/source');

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
    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
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
      schema: '/schemas/core/error.json',
      description: 'Error example'
    },
    {
      data: { "message": "Operation completed successfully" },
      schema: '/schemas/core/response.json',
      description: 'Response example'
    },
    {
      data: { "format_id": {"agent_url": "https://creatives.adcontextprotocol.org", "id": "video_standard_30s"}, "name": "Standard Video - 30 seconds", "type": "video" },
      schema: '/schemas/core/format.json',
      description: 'Format example'
    },
    {
      data: { 
        "type": "incremental_sales_lift",
        "attribution": "deterministic_purchase", 
        "reporting": "weekly_dashboard"
      },
      schema: '/schemas/core/measurement.json',
      description: 'Measurement example'
    },
    {
      data: {
        "co_branding": "optional",
        "landing_page": "any",
        "templates_available": true
      },
      schema: '/schemas/core/creative-policy.json',
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
      "buying_mode": "brief",
      "account": { "brand": { "domain": "nikeinc.com", "brand_id": "nike" }, "operator": "nikeinc.com" },
      "brand": {
        "domain": "nikeinc.com",
        "brand_id": "nike"
      },
      "brief": "Premium video inventory"
    },
    '/schemas/media-buy/get-products-request.json',
    'get_products request'
  );

  await validateExample(
    {
      "signal_spec": "High-income households",
      "destinations": [
        {
          "type": "platform",
          "platform": "the-trade-desk"
        }
      ],
      "countries": ["US"]
    },
    '/schemas/signals/get-signals-request.json',
    'get_signals request'
  );

  // Conversion tracking examples
  await validateExample(
    {
      "account": { "account_id": "acct_12345" },
      "event_sources": [
        {
          "event_source_id": "website_pixel",
          "name": "Main Website Pixel",
          "event_types": ["purchase", "lead", "add_to_cart", "page_view"],
          "allowed_domains": ["www.example.com", "shop.example.com"]
        },
        {
          "event_source_id": "crm_import",
          "name": "CRM Offline Events",
          "event_types": ["purchase", "qualify_lead", "close_convert_lead"]
        }
      ]
    },
    '/schemas/media-buy/sync-event-sources-request.json',
    'sync_event_sources request'
  );

  await validateExample(
    {
      "event_sources": [
        {
          "event_source_id": "website_pixel",
          "name": "Main Website Pixel",
          "seller_id": "px_abc123",
          "event_types": ["purchase", "lead", "add_to_cart", "page_view"],
          "managed_by": "buyer",
          "action": "created",
          "setup": {
            "snippet_type": "javascript",
            "snippet": "<script>/* pixel code */</script>",
            "instructions": "Place in the <head> of all pages."
          }
        },
        {
          "event_source_id": "amazon_attribution",
          "name": "Amazon Sales Attribution",
          "seller_id": "amz_attr_001",
          "managed_by": "seller",
          "action": "unchanged"
        }
      ]
    },
    '/schemas/media-buy/sync-event-sources-response.json',
    'sync_event_sources response (success)'
  );

  await validateExample(
    {
      "errors": [
        { "code": "AUTHENTICATION_FAILED", "message": "Invalid or expired credentials" }
      ]
    },
    '/schemas/media-buy/sync-event-sources-response.json',
    'sync_event_sources response (error)'
  );

  await validateExample(
    {
      "event_source_id": "website_pixel",
      "events": [
        {
          "event_id": "evt_purchase_12345",
          "event_type": "purchase",
          "event_time": "2026-01-15T14:30:00Z",
          "action_source": "website",
          "event_source_url": "https://www.example.com/checkout/confirm",
          "user_match": {
            "hashed_email": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            "click_id": "abc123def456",
            "click_id_type": "gclid"
          },
          "custom_data": {
            "value": 149.99,
            "currency": "USD",
            "order_id": "order_98765",
            "num_items": 3,
            "contents": [
              { "id": "SKU-1234", "quantity": 2, "price": 49.99 },
              { "id": "SKU-5678", "quantity": 1, "price": 50.01 }
            ]
          }
        },
        {
          "event_id": "evt_lead_67890",
          "event_type": "lead",
          "event_time": "2026-01-15T15:00:00Z",
          "action_source": "website",
          "user_match": {
            "uids": [{ "type": "uid2", "value": "AbC123XyZ..." }]
          }
        },
        {
          "event_id": "evt_refund_001",
          "event_type": "refund",
          "event_time": "2026-01-16T10:00:00Z",
          "action_source": "system_generated",
          "user_match": {
            "hashed_phone": "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3"
          },
          "custom_data": {
            "value": 49.99,
            "currency": "USD",
            "order_id": "order_98765"
          }
        }
      ]
    },
    '/schemas/media-buy/log-event-request.json',
    'log_event request (batch with purchase, lead, refund)'
  );

  await validateExample(
    {
      "events_received": 3,
      "events_processed": 2,
      "partial_failures": [
        {
          "event_id": "evt_refund_001",
          "code": "INVALID_EVENT_TIME",
          "message": "Event time is outside the attribution window"
        }
      ],
      "warnings": ["Low match quality on 1 event — consider adding hashed_email or UIDs"],
      "match_quality": 0.67
    },
    '/schemas/media-buy/log-event-response.json',
    'log_event response (success with partial failure)'
  );

  await validateExample(
    {
      "errors": [
        { "code": "EVENT_SOURCE_NOT_FOUND", "message": "Event source 'unknown_pixel' not found on this account" }
      ]
    },
    '/schemas/media-buy/log-event-response.json',
    'log_event response (error)'
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
