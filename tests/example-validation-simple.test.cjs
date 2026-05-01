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
      discriminator: true,
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

async function expectInvalid(data, schemaId, description, errorPatterns) {
  totalTests++;
  try {
    const ajv = new Ajv({ allErrors: true, verbose: false, strict: false, discriminator: true, loadSchema: loadExternalSchema });
    addFormats(ajv);
    const schemaPath = path.join(SCHEMA_BASE_DIR, schemaId.replace('/schemas/', ''));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    const validate = await ajv.compileAsync(schema);
    const isValid = validate(data);
    if (isValid) {
      log(`❌ ${description}: expected schema violation but passed`, 'error');
      failedTests++;
      return;
    }
    const errorText = (validate.errors || []).map(e => `${e.instancePath || ''}: ${e.message} ${JSON.stringify(e.params || {})}`).join(' | ');
    const missing = (errorPatterns || []).filter(p => !(p instanceof RegExp ? p.test(errorText) : errorText.includes(p)));
    if (missing.length > 0) {
      log(`❌ ${description}: invalid as expected, but error text missing expected patterns ${JSON.stringify(missing)} — got: ${errorText}`, 'error');
      failedTests++;
      return;
    }
    log(`✅ ${description}`, 'success');
    passedTests++;
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
      schema: '/schemas/core/outcome-measurement.json',
      description: 'Outcome Measurement example'
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
      "idempotency_key": "d4a8e1b2-0123-489f-0123-45678901234d",
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
      "idempotency_key": "3f9a2d1b-7c4e-4f5a-9b2c-1a3b4c5d6e7f",
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

  // Creative manifest with brief asset and compliance
  await validateExample(
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "display_300x250_generative"
      },
      "assets": {
        "brief": {
          "asset_type": "brief",
          "name": "Holiday Sale 2025",
          "objective": "conversion",
          "compliance": {
            "required_disclosures": [
              { "text": "Terms and conditions apply.", "position": "footer" }
            ]
          }
        }
      }
    },
    '/schemas/core/creative-manifest.json',
    'Creative manifest with brief asset and compliance'
  );

  // Creative manifest with catalog asset
  await validateExample(
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "display_carousel_product"
      },
      "assets": {
        "product_catalog": {
          "asset_type": "catalog",
          "type": "product",
          "catalog_id": "winter-products",
          "tags": ["beverage"]
        },
        "banner_image": {
          "asset_type": "image",
          "url": "https://cdn.example.com/banner.jpg",
          "width": 300,
          "height": 250
        }
      }
    },
    '/schemas/core/creative-manifest.json',
    'Creative manifest with catalog asset and selectors'
  );

  // Creative brief examples
  await validateExample(
    {
      "name": "Summer Campaign 2026"
    },
    '/schemas/core/creative-brief.json',
    'Creative brief (minimal)'
  );

  await validateExample(
    {
      "name": "Retirement Advisory Q1 2026",
      "objective": "consideration",
      "audience": "Pre-retirees aged 50-65",
      "compliance": {
        "required_disclosures": [
          {
            "text": "Past performance is not indicative of future results.",
            "position": "footer",
            "jurisdictions": ["US", "US-NJ"],
            "regulation": "SEC Rule 156"
          },
          {
            "text": "Capital at risk.",
            "position": "prominent",
            "jurisdictions": ["GB", "CA-QC"]
          }
        ],
        "prohibited_claims": [
          "guaranteed returns",
          "risk-free"
        ]
      }
    },
    '/schemas/core/creative-brief.json',
    'Creative brief with compliance fields'
  );

  // Provenance with declared_at and render_guidance
  await validateExample(
    {
      "digital_source_type": "trained_algorithmic_media",
      "declared_by": {
        "agent_url": "https://creative.pinnaclemedia.example.com",
        "role": "agency"
      },
      "declared_at": "2026-02-15T14:35:00Z",
      "created_time": "2026-02-15T14:30:00Z",
      "disclosure": {
        "required": true,
        "jurisdictions": [
          {
            "country": "DE",
            "regulation": "eu_ai_act_article_50",
            "label_text": "KI-generiert",
            "render_guidance": {
              "persistence": "continuous",
              "positions": ["overlay", "subtitle"]
            }
          },
          {
            "country": "CN",
            "regulation": "cn_deep_synthesis",
            "label_text": "AI-generated content",
            "render_guidance": {
              "persistence": "initial",
              "min_duration_ms": 3000,
              "positions": ["overlay", "pre_roll"]
            }
          },
          {
            "country": "US",
            "region": "CA",
            "regulation": "ca_sb_942",
            "label_text": "Created with AI",
            "render_guidance": {
              "persistence": "flexible",
              "positions": ["prominent", "footer"]
            }
          }
        ]
      }
    },
    '/schemas/core/provenance.json',
    'Provenance with declared_at and render_guidance'
  );

  // Format with disclosure_capabilities
  await validateExample(
    {
      "format_id": {
        "agent_url": "https://creative.adcontextprotocol.org",
        "id": "video_15s_hosted"
      },
      "name": "Hosted Video 15s",
      "supported_disclosure_positions": ["overlay", "footer", "subtitle"],
      "disclosure_capabilities": [
        { "position": "overlay", "persistence": ["continuous", "initial"] },
        { "position": "footer", "persistence": ["continuous"] },
        { "position": "subtitle", "persistence": ["continuous", "initial"] }
      ]
    },
    '/schemas/core/format.json',
    'Format with disclosure_capabilities'
  );

  // Creative brief with disclosure persistence
  await validateExample(
    {
      "name": "EU AI Compliance Campaign",
      "compliance": {
        "required_disclosures": [
          {
            "text": "KI-generiert",
            "position": "overlay",
            "persistence": "continuous",
            "jurisdictions": ["DE"],
            "regulation": "eu_ai_act_article_50"
          }
        ]
      }
    },
    '/schemas/core/creative-brief.json',
    'Creative brief with disclosure persistence'
  );

  // list_creative_formats request with disclosure filters
  await validateExample(
    {
      "disclosure_positions": ["overlay"],
      "disclosure_persistence": ["continuous"]
    },
    '/schemas/creative/list-creative-formats-request.json',
    'list_creative_formats request with disclosure filters (creative domain)'
  );

  await validateExample(
    {
      "disclosure_positions": ["overlay", "subtitle"],
      "disclosure_persistence": ["continuous", "initial"]
    },
    '/schemas/media-buy/list-creative-formats-request.json',
    'list_creative_formats request with disclosure filters (media-buy domain)'
  );

  // TMP examples from walkthrough docs

  // Context Match request — web (from index.mdx)
  await validateExample(
    {
      "type": "context_match_request",
      "request_id": "ctx-8f3a2b",
      "property_rid": "01916f3a-9c4e-7000-8000-000000000010",
      "property_type": "website",
      "placement_id": "article-sidebar",
      "artifact_refs": [
        { "type": "url", "value": "https://streamhaus.example/articles/hiking-gear-2026" }
      ]
    },
    '/schemas/tmp/context-match-request.json',
    'TMP Context Match request — web (overview walkthrough)'
  );

  // Context Match response — web (from index.mdx)
  await validateExample(
    {
      "type": "context_match_response",
      "request_id": "ctx-8f3a2b",
      "offers": [
        {
          "package_id": "pkg-outdoor-display"
        }
      ]
    },
    '/schemas/tmp/context-match-response.json',
    'TMP Context Match response — web (overview walkthrough)'
  );

  // Identity Match request — web (from index.mdx)
  await validateExample(
    {
      "type": "identity_match_request",
      "request_id": "id-7c9e1d",
      "identities": [
        { "user_token": "opaque-streamhaus-token-abc123", "uid_type": "uid2" },
        { "user_token": "ID5*zP3wK...", "uid_type": "id5" }
      ],
      "package_ids": [
        "pkg-outdoor-display",
        "pkg-outdoor-ctv",
        "pkg-outdoor-audio"
      ]
    },
    '/schemas/tmp/identity-match-request.json',
    'TMP Identity Match request — web (overview walkthrough)'
  );

  // Identity Match response — web (from index.mdx)
  await validateExample(
    {
      "type": "identity_match_response",
      "request_id": "id-7c9e1d",
      "eligible_package_ids": ["pkg-outdoor-audio"],
      "ttl_sec": 60
    },
    '/schemas/tmp/identity-match-response.json',
    'TMP Identity Match response — web (overview walkthrough)'
  );

  // Context Match request — AI assistant (from ai-mediation.mdx)
  await validateExample(
    {
      "type": "context_match_request",
      "request_id": "ctx-trail-shoes-01",
      "property_rid": "01916f3a-f8cb-7000-8000-000000000051",
      "property_type": "ai_assistant",
      "placement_id": "chat-inline-recommendation",
      "context_signals": {
        "topics": ["596", "477"],
        "taxonomy_source": "iab",
        "taxonomy_id": 7,
        "sentiment": "positive",
        "keywords": ["trail shoes", "rocky terrain", "ankle support"],
        "language": "en",
        "summary": "User seeking trail shoe recommendations for rocky terrain with ankle support"
      }
    },
    '/schemas/tmp/context-match-request.json',
    'TMP Context Match request — AI assistant (ai-mediation walkthrough)'
  );

  // Context Match response — AI assistant with creative manifest (from ai-mediation.mdx)
  await validateExample(
    {
      "type": "context_match_response",
      "request_id": "ctx-trail-shoes-01",
      "offers": [
        {
          "package_id": "pkg-outdoor-display",
          "brand": { "domain": "acmeoutdoor.example" },
          "summary": "Trail Pro 3000 — ankle-height trail runner with rock plate, relevant to user's terrain needs",
          "creative_manifest": {
            "format_id": { "agent_url": "https://streamhaus.example", "id": "sponsored_recommendation" },
            "assets": {
              "headline": { "asset_type": "text", "content": "Built for rocky trails" },
              "body": { "asset_type": "text", "content": "The Trail Pro 3000 has a full rock plate and ankle-height collar for technical terrain. Vibram outsole with 4mm lugs." }
            }
          }
        }
      ]
    },
    '/schemas/tmp/context-match-response.json',
    'TMP Context Match response — AI assistant with creative manifest (ai-mediation walkthrough)'
  );

  // Identity Match request with consent (from context-and-identity.mdx)
  await validateExample(
    {
      "type": "identity_match_request",
      "request_id": "id-9b2c",
      "identities": [
        { "user_token": "tok_hk82mfp1", "uid_type": "uid2" },
        { "user_token": "ID5*aB3xY...", "uid_type": "id5" },
        { "user_token": "a1b2c3d4e5f6...", "uid_type": "hashed_email" }
      ],
      "consent": {
        "gdpr": true,
        "tcf_consent": "CPx2XYZABC..."
      },
      "package_ids": ["pkg-A", "pkg-B", "pkg-C"]
    },
    '/schemas/tmp/identity-match-request.json',
    'TMP Identity Match request with consent (context-and-identity walkthrough)'
  );

  // Identity Match request — single-identity minItems:1 boundary (ai-assistant surface)
  await validateExample(
    {
      "type": "identity_match_request",
      "request_id": "id-e5f6g7h8",
      "identities": [
        { "user_token": "tok_session_k2f8", "uid_type": "publisher_first_party" }
      ],
      "package_ids": ["pkg-sneaker-reco", "pkg-fashion-native"]
    },
    '/schemas/tmp/identity-match-request.json',
    'TMP Identity Match request — single identity (ai-assistant walkthrough)'
  );

  // Identity Match request — maxItems:3 upper boundary (4 identities MUST fail)
  await expectInvalid(
    {
      "type": "identity_match_request",
      "request_id": "id-boundary-4",
      "identities": [
        { "user_token": "a", "uid_type": "uid2" },
        { "user_token": "b", "uid_type": "id5" },
        { "user_token": "c", "uid_type": "rampid" },
        { "user_token": "d", "uid_type": "hashed_email" }
      ],
      "package_ids": ["pkg-1"]
    },
    '/schemas/tmp/identity-match-request.json',
    'TMP Identity Match request — 4 identities rejected (maxItems:3 boundary)'
  );

  // get_products refine[] — migration regressions for the `id` → `product_id`/`proposal_id` rename (adcp#2775).
  // These fixtures exercise exactly the payload shape a pre-rename orchestrator would send today, so the test
  // proves the schema rejects it with a migration-diagnosable error.
  await expectInvalid(
    {
      "buying_mode": "refine",
      "refine": [{ "scope": "product", "id": "prod_video_premium", "action": "include" }]
    },
    '/schemas/media-buy/get-products-request.json',
    'refine[] product with old `id` field is rejected and error flags the unknown property',
    ['product_id', /additionalProperties|must NOT have additional propert/i]
  );

  await expectInvalid(
    {
      "buying_mode": "refine",
      "refine": [{ "scope": "proposal", "id": "prop_balanced_v1", "action": "finalize" }]
    },
    '/schemas/media-buy/get-products-request.json',
    'refine[] proposal with old `id` field is rejected and error flags the unknown property',
    ['proposal_id', /additionalProperties|must NOT have additional propert/i]
  );

  // Happy path — optional `action` defaults to include server-side; schema must accept the minimal shape.
  await validateExample(
    {
      "buying_mode": "refine",
      "refine": [
        { "scope": "product",  "product_id":  "prod_video_premium" },
        { "scope": "proposal", "proposal_id": "prop_balanced_v1", "ask": "shift 20% to video" }
      ]
    },
    '/schemas/media-buy/get-products-request.json',
    'refine[] with new prefixed ids and omitted action (defaults to include)'
  );

  // Measurement capability block — locks the discovery shape down
  // (#3612). Two metrics: one with full accreditations[] and
  // methodology_version, one with the minimum required field (metric_id).
  // Buyer-side implementers can reference this as the canonical response shape.
  await validateExample(
    {
      "adcp": {
        "major_versions": [3],
        "supported_versions": ["3.0"],
        "idempotency": { "supported": true, "replay_ttl_seconds": 86400 }
      },
      "supported_protocols": ["measurement"],
      "account": {
        "supported_billing": ["operator"]
      },
      "measurement": {
        "metrics": [
          {
            "metric_id": "attention_units",
            "standard_reference": "https://iabtechlab.com/standards/attention-measurement",
            "accreditations": [
              {
                "accrediting_body": "MRC",
                "certification_id": "MRC-ATT-2026-001",
                "valid_until": "2027-12-31",
                "evidence_url": "https://mediaratingcouncil.org/accreditations/attentionvendor"
              }
            ],
            "unit": "score",
            "description": "Eye-tracking-based attention score (0-100). Computed from a panel of opted-in households.",
            "methodology_url": "https://attentionvendor.example/docs/attention-units",
            "methodology_version": "v2.1"
          },
          {
            "metric_id": "gco2e_per_impression",
            "standard_reference": "https://garmadvertising.com/sustainability-framework",
            "unit": "gCO2e",
            "description": "Carbon emissions per impression, computed via supply-path analysis."
          }
        ]
      }
    },
    '/schemas/protocol/get-adcp-capabilities-response.json',
    'get_adcp_capabilities response with measurement capability block (#3612)'
  );

  // Negative case — duplicate metric_id within one agent's catalog is unambiguously a bug;
  // schema-level uniqueItems on metrics[] catches it.
  await expectInvalid(
    {
      "adcp": {
        "major_versions": [3],
        "supported_versions": ["3.0"],
        "idempotency": { "supported": true, "replay_ttl_seconds": 86400 }
      },
      "supported_protocols": ["measurement"],
      "account": {
        "supported_billing": ["operator"]
      },
      "measurement": {
        "metrics": [
          { "metric_id": "attention_units" },
          { "metric_id": "attention_units" }
        ]
      }
    },
    '/schemas/protocol/get-adcp-capabilities-response.json',
    'measurement.metrics[] rejects duplicate entries (uniqueItems)',
    [/uniqueItems|duplicate/i]
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
