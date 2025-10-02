---
title: create_media_buy
sidebar_position: 3
---

# create_media_buy

Create a media buy from selected packages. This task handles the complete workflow including validation, approval if needed, and campaign creation.

**Response Time**: Instant to days (returns `completed`, `working` < 120s, or `submitted` for hours/days)

**Format Specification Required**: Each package must specify the creative formats that will be used. This enables placeholder creation in ad servers and ensures both parties have clear expectations for creative asset requirements.


**Request Schema**: [`/schemas/v1/media-buy/create-media-buy-request.json`](/schemas/v1/media-buy/create-media-buy-request.json)  
**Response Schema**: [`/schemas/v1/media-buy/create-media-buy-response.json`](/schemas/v1/media-buy/create-media-buy-response.json)

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `buyer_ref` | string | Yes | Buyer's reference identifier for this media buy |
| `packages` | Package[] | Yes | Array of package configurations (see Package Object below) |
| `promoted_offering` | string | Yes | Description of advertiser and what is being promoted |
| `po_number` | string | No | Purchase order number for tracking |
| `start_time` | string | Yes | Campaign start date/time in ISO 8601 format (UTC unless timezone specified) |
| `end_time` | string | Yes | Campaign end date/time in ISO 8601 format (UTC unless timezone specified) |
| `budget` | Budget | Yes | Budget configuration for the media buy (see Budget Object below) |
| `reporting_webhook` | ReportingWebhook | No | Optional webhook configuration for automated reporting delivery (see Reporting Webhook Object below) |

### Package Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `buyer_ref` | string | Yes | Buyer's reference identifier for this package |
| `product_id` | string | Yes | Product ID for this package |
| `format_ids` | string[] | Yes | Array of format IDs that will be used for this package - must be supported by the product |
| `budget` | Budget | No | Budget configuration for this package (overrides media buy level budget if specified) |
| `targeting_overlay` | TargetingOverlay | No | Additional targeting criteria for this package (see Targeting Overlay Object below) |

### Targeting Overlay Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `geo_country_any_of` | string[] | No | Target specific countries (ISO codes) |
| `geo_region_any_of` | string[] | No | Target specific regions/states |
| `geo_metro_any_of` | string[] | No | Target specific metro areas (DMA codes) |
| `geo_postal_code_any_of` | string[] | No | Target specific postal/ZIP codes |
| `device_type_any_of` | string[] | No | Target specific device types (desktop, mobile, tablet, connected_tv, smart_speaker) |
| `os_any_of` | string[] | No | Target specific operating systems (windows, macos, ios, android, linux, roku, tvos, other) |
| `browser_any_of` | string[] | No | Target specific browsers (chrome, firefox, safari, edge, other) |
| `axe_include_segment` | string | No | AXE segment ID to include for targeting |
| `axe_exclude_segment` | string | No | AXE segment ID to exclude from targeting |
| `signals` | string[] | No | Signal IDs from get_signals |
| `frequency_cap` | FrequencyCap | No | Frequency capping settings (see Frequency Cap Object below) |

### Budget Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `total` | number | Yes | Total budget amount |
| `currency` | string | Yes | ISO 4217 currency code (e.g., "USD", "EUR", "GBP") |
| `pacing` | string | No | Pacing strategy: `"even"` (allocate remaining budget evenly over remaining time), `"asap"` (spend remaining budget as quickly as possible), or `"front_loaded"` (allocate more remaining budget earlier) - default: `"even"` |

### Frequency Cap Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `suppress_minutes` | number | Yes | Minutes to suppress after impression (applied at package level) |

### Reporting Webhook Object

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | Webhook endpoint URL for reporting notifications |
| `auth_type` | string | Yes | Authentication type: `"bearer"`, `"basic"`, or `"none"` |
| `auth_token` | string | No* | Authentication token or credentials (required unless auth_type is "none") |
| `reporting_frequency` | string | Yes | Reporting frequency: `"hourly"`, `"daily"`, or `"monthly"`. Must be supported by all products in the media buy. |
| `requested_metrics` | string[] | No | Optional list of metrics to include in webhook notifications. If omitted, all available metrics are included. Must be subset of product's `available_metrics`. |

**Publisher Commitment**: When a reporting webhook is configured, the publisher commits to sending **(campaign_duration / reporting_frequency) + 1** webhook notifications:
- One notification per frequency period during the campaign
- One final notification when the campaign completes
- If reporting data is delayed beyond the product's `expected_delay_minutes`, a notification with `"delayed"` status will be sent to avoid appearing as a missed notification

**Timezone Considerations**: For daily and monthly frequencies, the publisher's reporting timezone (specified in `reporting_capabilities.timezone`) determines when periods begin/end. Ensure alignment between your systems and the publisher's timezone to avoid confusion about reporting period boundaries.

## Response (Message)

The response includes a human-readable message that:
- Confirms the media buy was created with budget and targeting details
- Explains next steps and deadlines
- Describes any approval requirements
- Provides implementation details and status updates

The message is returned differently in each protocol:
- **MCP**: Returned as a `message` field in the JSON response
- **A2A**: Returned as a text part in the artifact

## Response (Payload)

```json
{
  "media_buy_id": "string",
  "buyer_ref": "string",
  "creative_deadline": "string",
  "packages": [
    {
      "package_id": "string",
      "buyer_ref": "string"
    }
  ]
}
```

### Field Descriptions

- **media_buy_id**: Publisher's unique identifier for the created media buy
- **buyer_ref**: Buyer's reference identifier for this media buy
- **creative_deadline**: ISO 8601 timestamp for creative upload deadline
- **packages**: Array of created packages
  - **package_id**: Publisher's unique identifier for the package
  - **buyer_ref**: Buyer's reference identifier for the package

## Protocol-Specific Examples

The AdCP payload is identical across protocols. Only the request/response wrapper differs.

### MCP Request
```json
{
  "tool": "create_media_buy",
  "arguments": {
    "buyer_ref": "nike_q1_campaign_2024",
    "packages": [
      {
        "buyer_ref": "nike_ctv_sports_package",
        "product_id": "ctv_sports_premium",
        "format_ids": ["video_standard_30s", "video_standard_15s"],
        "budget": {
          "total": 60000,
          "currency": "USD",
          "pacing": "even"
        },
        "targeting_overlay": {
          "geo_country_any_of": ["US"],
          "geo_region_any_of": ["CA", "NY"],
          "axe_include_segment": "x8dj3k"
        }
      },
      {
        "buyer_ref": "nike_audio_drive_package",
        "product_id": "audio_drive_time",
        "format_ids": ["audio_standard_30s"],
        "budget": {
          "total": 40000,
          "currency": "USD",
          "pacing": "front_loaded"
        },
        "targeting_overlay": {
          "geo_country_any_of": ["US"],
          "geo_region_any_of": ["CA"],
          "axe_exclude_segment": "x9m2p"
        }
      }
    ],
    "promoted_offering": "Nike Air Max 2024 - premium running shoes",
    "po_number": "PO-2024-Q1-001",
    "start_time": "2024-02-01T00:00:00Z",
    "end_time": "2024-03-31T23:59:59Z",
    "budget": {
      "total": 100000,
      "currency": "USD",
      "pacing": "even"
    },
    "reporting_webhook": {
      "url": "https://buyer.example.com/webhooks/reporting",
      "auth_type": "bearer",
      "auth_token": "secret_reporting_token_xyz",
      "reporting_frequency": "daily",
      "requested_metrics": ["impressions", "spend", "video_completions", "completion_rate"]
    }
  }
}
```

### MCP Response (Synchronous)
```json
{
  "message": "Successfully created $100,000 media buy. Upload creatives by Jan 30. Campaign will run from Feb 1 to Mar 31.",
  "status": "completed",
  "media_buy_id": "mb_12345",
  "buyer_ref": "nike_q1_campaign_2024",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {
      "package_id": "pkg_12345_001",
      "buyer_ref": "nike_ctv_sports_package"
    },
    {
      "package_id": "pkg_12345_002",
      "buyer_ref": "nike_audio_drive_package"
    }
  ]
}
```

### MCP Response (Partial Success with Errors)
```json
{
  "message": "Media buy created but some packages had issues. Review targeting for best performance.",
  "adcp_version": "1.0.0",
  "media_buy_id": "mb_12346",
  "buyer_ref": "nike_q1_campaign_2024", 
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {
      "package_id": "pkg_12346_001",
      "buyer_ref": "nike_ctv_sports_package"
    }
  ],
  "errors": [
    {
      "code": "TARGETING_TOO_NARROW",
      "message": "Package targeting yielded 0 available impressions",
      "field": "packages[1].targeting_overlay",
      "suggestion": "Broaden geographic targeting or remove segment exclusions",
      "details": {
        "requested_budget": 40000,
        "available_impressions": 0,
        "affected_package": "nike_audio_drive_package"
      }
    }
  ]
}
```

### MCP Response (Asynchronous)
```json
{
  "task_id": "task_456",
  "status": "working",
  "message": "Creating media buy...",
  "poll_url": "/tasks/task_456"
}
```

### A2A Request

#### Natural Language Invocation
```javascript
await a2a.send({
  message: {
    parts: [{
      kind: "text",
      text: "Create a $100K Nike campaign from Feb 1 to Mar 31. Use the CTV sports and audio drive time products we discussed. Split budget 60/40."
    }]
  }
});
```

#### Explicit Skill Invocation
```javascript
await a2a.send({
  message: {
    parts: [
      {
        kind: "text",
        text: "Creating Nike Q1 campaign"  // Optional context
      },
      {
        kind: "data",
        data: {
          skill: "create_media_buy",  // Must match skill name in Agent Card
          parameters: {
            "buyer_ref": "nike_q1_campaign_2024",
            "packages": [
              {
                "buyer_ref": "nike_ctv_sports_package",
                "product_id": "ctv_sports_premium",
                "format_ids": ["video_standard_30s", "video_standard_15s"],
                "budget": {
                  "total": 60000,
                  "currency": "USD",
                  "pacing": "even"
                },
                "targeting_overlay": {
                  "geo_country_any_of": ["US"],
                  "geo_region_any_of": ["CA", "NY"],
                  "axe_include_segment": "x8dj3k"
                }
              },
              {
                "buyer_ref": "nike_audio_drive_package",
                "product_id": "audio_drive_time",
                "format_ids": ["audio_standard_30s"],
                "budget": {
                  "total": 40000,
                  "currency": "USD",
                  "pacing": "front_loaded"
                },
                "targeting_overlay": {
                  "geo_country_any_of": ["US"],
                  "geo_region_any_of": ["CA"],
                  "axe_exclude_segment": "x9m2p"
                }
              }
            ],
            "promoted_offering": "Nike Air Max 2024 - premium running shoes",
            "po_number": "PO-2024-Q1-001",
            "start_time": "2024-02-01T00:00:00Z",
            "end_time": "2024-03-31T23:59:59Z",
            "budget": {
              "total": 100000,
              "currency": "USD",
              "pacing": "even"
            }
          }
        }
      }
    ]
  }
});
```

### A2A Response (with streaming)
Initial response:
```json
{
  "taskId": "task-mb-001",
  "status": { "state": "working" }
}
```

Then via Server-Sent Events:
```
data: {"message": "Validating packages..."}
data: {"message": "Checking inventory availability..."}
data: {"message": "Creating campaign in ad server..."}
data: {"status": {"state": "completed"}, "artifacts": [{
  "name": "media_buy_confirmation",
  "parts": [
    {"kind": "text", "text": "Successfully created $100,000 media buy. Upload creatives by Jan 30."},
    {"kind": "data", "data": {
      "media_buy_id": "mb_12345",
      "buyer_ref": "nike_q1_campaign_2024",
      "creative_deadline": "2024-01-30T23:59:59Z",
      "packages": [
        {"package_id": "pkg_12345_001", "buyer_ref": "nike_ctv_sports_package"},
        {"package_id": "pkg_12345_002", "buyer_ref": "nike_audio_drive_package"}
      ]
    }}
  ]
}]}
```

### Key Differences
- **MCP**: May return synchronously or asynchronously with updates via:
  - Polling (calling status endpoints)
  - Webhooks (push notifications to callback URLs)
  - Streaming (WebSockets or SSE)
- **A2A**: Always returns task with updates via:
  - Server-Sent Events (SSE) for real-time streaming
  - Webhooks (push notifications) for long-running tasks
- **Payload**: The `input` field in A2A contains the exact same structure as MCP's `arguments`

## Human-in-the-Loop Examples

### MCP with Manual Approval (Polling Example)

This example shows polling, but MCP implementations may also support webhooks or streaming for real-time updates.

**Initial Request:**
```json
{
  "tool": "create_media_buy",
  "arguments": {
    "buyer_ref": "large_campaign_2024",
    "packages": [...],
    "promoted_offering": "High-value campaign requiring approval",
    "po_number": "PO-2024-LARGE-001",
    "start_time": "2024-02-01T00:00:00Z",
    "end_time": "2024-06-30T23:59:59Z",
    "budget": {
      "total": 500000,
      "currency": "USD"
    }
  }
}
```

**Response (Asynchronous):**
```json
{
  "task_id": "task_456",
  "status": "working",
  "message": "Large budget requires sales team approval. Expected review time: 2-4 hours.",
  "context_id": "ctx-mb-456"
}
```

**Client checks status (via polling in this example):**
```json
{
  "tool": "create_media_buy_status",
  "arguments": {
    "context_id": "ctx-mb-456"
  }
}
```

**Status Response (Still pending):**
```json
{
  "status": "working",
  "message": "Awaiting manual approval. Sales team reviewing. 1 of 2 approvals received.",
  "context_id": "ctx-mb-456",
  "responsible_party": "publisher",
  "estimated_completion": "2024-01-15T16:00:00Z"
}
```

**Status Response (Approved):**
```json
{
  "status": "completed",
  "message": "Media buy approved and created. Upload creatives by Jan 30.",
  "media_buy_id": "mb_789456",
  "buyer_ref": "large_campaign_2024",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [...]
}
```

### A2A with Manual Approval (SSE Example)

A2A can use Server-Sent Events for real-time streaming or webhooks for push notifications.

**Initial Request with SSE:**
```json
{
  "skill": "create_media_buy",
  "input": {
    "buyer_ref": "large_campaign_2024",
    "packages": [...],
    "promoted_offering": "High-value campaign requiring approval",
    "po_number": "PO-2024-LARGE-001",
    "start_time": "2024-02-01T00:00:00Z",
    "end_time": "2024-06-30T23:59:59Z",
    "budget": {
      "total": 500000,
      "currency": "USD"
    }
  }
}
```

**Initial Response:**
```json
{
  "taskId": "task-mb-large-001",
  "contextId": "ctx-conversation-xyz",
  "status": { 
    "state": "working",
    "message": "Large budget requires sales team approval"
  }
}
```

**SSE Updates (Human approval process):**
```
data: {"message": "Validating campaign requirements..."}
data: {"message": "Budget exceeds auto-approval threshold. Routing to sales team..."}
data: {"message": "Sales team notified. Expected review time: 2-4 hours"}
data: {"message": "First approval received from regional manager"}
data: {"message": "Second approval received from finance team"}
data: {"status": {"state": "completed"}, "artifacts": [{
  "artifactId": "artifact-mb-large-xyz",
  "name": "media_buy_confirmation",
  "parts": [
    {"kind": "text", "text": "Media buy approved and created successfully. $500,000 campaign scheduled Feb 1 - Jun 30. Upload creatives by Jan 30."},
    {"kind": "data", "data": {
      "media_buy_id": "mb_789456",
      "buyer_ref": "large_campaign_2024",
      "creative_deadline": "2024-01-30T23:59:59Z",
      "packages": [...]
    }}
  ]
}]}
```

### A2A with Webhooks (Long-Running Task)

**Initial Request with Webhook Configuration:**
```json
{
  "skill": "create_media_buy",
  "input": {
    "buyer_ref": "large_campaign_2024",
    "packages": [...],
    "promoted_offering": "High-value campaign requiring approval",
    "po_number": "PO-2024-LARGE-001",
    "start_time": "2024-02-01T00:00:00Z",
    "end_time": "2024-06-30T23:59:59Z",
    "budget": {
      "total": 500000,
      "currency": "USD"
    }
  },
  "pushNotificationConfig": {
    "url": "https://buyer.example.com/webhooks/adcp",
    "authType": "bearer",
    "authToken": "secret-token-xyz"
  }
}
```

**Initial Response:**
```json
{
  "taskId": "task-mb-webhook-001",
  "contextId": "ctx-conversation-xyz",
  "status": { 
    "state": "working",
    "message": "Task processing. Updates will be sent to webhook."
  }
}
```

**Webhook Notifications (sent to buyer's endpoint):**
```json
// First webhook
{
  "taskId": "task-mb-webhook-001",
  "contextId": "ctx-conversation-xyz",
  "status": {"state": "working"},
  "message": "Budget exceeds threshold. Awaiting sales approval."
}

// Final webhook when complete
{
  "taskId": "task-mb-webhook-001",
  "contextId": "ctx-conversation-xyz",
  "status": {"state": "completed"},
  "artifacts": [{
    "artifactId": "artifact-mb-webhook-xyz",
    "name": "media_buy_confirmation",
    "parts": [
      {"kind": "data", "data": {
        "media_buy_id": "mb_789456",
        "buyer_ref": "large_campaign_2024",
        "creative_deadline": "2024-01-30T23:59:59Z",
        "packages": [...]
      }}
    ]
  }]
}
```

### A2A with Input Required

If the system needs clarification (e.g., ambiguous targeting):

**SSE Update requesting input:**
```
data: {"status": {"state": "input-required", "message": "Multiple interpretations found for 'sports fans'. Please specify: 1) All sports enthusiasts, 2) NFL fans specifically, 3) Live sports event viewers"}}
```

**Client provides clarification:**
```json
{
  "referenceTaskIds": ["task-mb-large-001"],
  "message": "Target all sports enthusiasts including NFL, NBA, and soccer fans"
}
```

**Task resumes with clarification:**
```
data: {"status": {"state": "working", "message": "Applying targeting for all sports enthusiasts..."}}
data: {"status": {"state": "completed"}, "artifacts": [...]}
```

## Scenarios

### Standard Media Buy Request
```json
{
  "buyer_ref": "purina_pet_campaign_q1",
  "packages": [
    {
      "buyer_ref": "purina_ctv_package",
      "product_id": "ctv_prime_time",
      "format_ids": ["video_standard_30s"],
      "budget": {
        "total": 30000,
        "currency": "USD",
        "pacing": "even"
      },
      "targeting_overlay": {
        "geo_country_any_of": ["US"],
        "geo_region_any_of": ["CA", "NY"],
        "axe_include_segment": "x7h4n",
        "signals": ["auto_intenders_q1_2025"],
        "frequency_cap": {
          "suppress_minutes": 30
        }
      }
    },
    {
      "buyer_ref": "purina_audio_package",
      "product_id": "audio_drive_time",
      "format_ids": ["audio_standard_30s"],
      "budget": {
        "total": 20000,
        "currency": "USD"
      },
      "targeting_overlay": {
        "geo_country_any_of": ["US"],
        "geo_region_any_of": ["CA", "NY"]
      }
    }
  ],
  "promoted_offering": "Purina Pro Plan dog food - premium nutrition tailored for dogs' specific needs, promoting the new salmon and rice formula for sensitive skin and stomachs",
  "po_number": "PO-2024-Q1-0123",
  "start_time": "2024-02-01T00:00:00Z",
  "end_time": "2024-02-29T23:59:59Z",
  "budget": {
    "total": 50000,
    "currency": "USD",
    "pacing": "even"
  }
}
```

### Retail Media Buy Request
```json
{
  "buyer_ref": "purina_albertsons_retail_q1",
  "packages": [
    {
      "buyer_ref": "purina_albertsons_conquest",
      "product_id": "albertsons_competitive_conquest",
      "format_ids": ["display_300x250", "display_728x90"],
      "budget": {
        "total": 75000,
        "currency": "USD",
        "pacing": "even"
      },
      "targeting_overlay": {
        "geo_country_any_of": ["US"],
        "geo_region_any_of": ["CA", "AZ", "NV"],
        "axe_include_segment": "x3f9q",
        "axe_exclude_segment": "x2v8r",
        "frequency_cap": {
          "suppress_minutes": 60
        }
      }
    }
  ],
  "promoted_offering": "Purina Pro Plan dog food - premium nutrition tailored for dogs' specific needs",
  "po_number": "PO-2024-RETAIL-0456",
  "start_time": "2024-02-01T00:00:00Z",
  "end_time": "2024-03-31T23:59:59Z",
  "budget": {
    "total": 75000,
    "currency": "USD",
    "pacing": "even"
  }
}
```

### Response - Success
**Message**: "Successfully created your $50,000 media buy targeting pet owners in CA and NY. The campaign will reach 2.5M users through Connected TV and Audio channels. Please upload creative assets by January 30 to activate the campaign. Campaign scheduled to run Feb 1-29."

**Payload**:
```json
{
  "media_buy_id": "gam_1234567890",
  "buyer_ref": "purina_pet_campaign_q1",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {
      "package_id": "gam_pkg_001",
      "buyer_ref": "purina_ctv_package"
    },
    {
      "package_id": "gam_pkg_002",
      "buyer_ref": "purina_audio_package"
    }
  ]
}
```

### Response - Retail Media Success
**Message**: "Successfully created your $75,000 retail media campaign targeting competitive dog food buyers. The campaign will reach 450K Albertsons shoppers with deterministic purchase data. Creative assets must include co-branding and drive to Albertsons.com. Upload by January 30 to activate. Campaign runs Feb 1 - Mar 31."

**Payload**:
```json
{
  "media_buy_id": "albertsons_mb_789012",
  "buyer_ref": "purina_albertsons_retail_q1",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {
      "package_id": "albertsons_pkg_001",
      "buyer_ref": "purina_albertsons_conquest"
    }
  ]
}
```

### Response - Pending Manual Approval
**Message**: "Your $50,000 media buy has been submitted for approval. Due to the campaign size, it requires manual review by our sales team. Expected approval time is 2-4 hours during business hours. You'll receive a notification once approved. Campaign scheduled for Feb 1 - Mar 31."

**Payload**:
```json
{
  "media_buy_id": "mb_789",
  "buyer_ref": "nike_q1_campaign_2024",
  "creative_deadline": null,
  "packages": []
}
```

## Platform Behavior

Different advertising platforms handle media buy creation differently:

- **Google Ad Manager (GAM)**: Creates Order with LineItems, requires approval
- **Kevel**: Creates Campaign with Flights, instant activation
- **Triton**: Creates Campaign for audio delivery

## Status Values

Both protocols use standard task states:

- `working`: Task is in progress (includes waiting for approvals, processing, etc.)
- `input-required`: Needs clarification or additional information from client
- `completed`: Task finished successfully
- `failed`: Task encountered an error
- `cancelled`: Task was cancelled
- `rejected`: Task was rejected (e.g., policy violation)

**Note**: Specific business states (like "awaiting manual approval", "pending creative assets", etc.) are conveyed through the message field, not custom status values. This ensures consistency across protocols.

## Asynchronous Behavior

This operation can be either synchronous or asynchronous depending on the publisher's implementation and the complexity of the request.

### Synchronous Response
When the operation can be completed immediately (rare), the response includes the created media buy details directly.

### Asynchronous Response
When the operation requires processing time, the response returns immediately with:
- A tracking identifier (`context_id` for MCP, `taskId` for A2A)
- Initial status (`"working"` for both MCP and A2A)
- Updates can be received via:
  - **Polling**: Call status endpoints periodically (MCP and A2A)
  - **Webhooks**: Register callback URLs for push notifications (MCP and A2A)
  - **Streaming**: Use SSE or WebSockets for real-time updates (MCP and A2A)

## Status Checking

### MCP Status Checking

#### Option 1: Polling (create_media_buy_status)

For MCP implementations using polling, use this endpoint to check the status of an asynchronous media buy creation.

#### Request
```json
{
  "context_id": "ctx-create-mb-456"  // Required - from create_media_buy response
}
```

#### Response Examples

**Processing:**
```json
{
  "message": "Media buy creation in progress - validating inventory",
  "context_id": "ctx-create-mb-456",
  "status": "working",
  "progress": {
    "current_step": "inventory_validation",
    "completed": 2,
    "total": 5,
    "unit_type": "steps",
    "responsible_party": "system"
  }
}
```

**Completed:**
```json
{
  "message": "Successfully created your $50,000 media buy. Upload creative assets by Jan 30.",
  "context_id": "ctx-create-mb-456",
  "status": "completed",
  "media_buy_id": "gam_1234567890",
  "buyer_ref": "espn_sports_q1_2024",
  "creative_deadline": "2024-01-30T23:59:59Z",
  "packages": [
    {"package_id": "gam_pkg_001", "buyer_ref": "espn_ctv_sports"},
    {"package_id": "gam_pkg_002", "buyer_ref": "espn_audio_sports"}
  ]
}
```

**Pending Manual Approval:**
```json
{
  "message": "Media buy requires manual approval. Sales team reviewing campaign.",
  "context_id": "ctx-create-mb-456",
  "status": "working",
  "responsible_party": "publisher",
  "action_detail": "Sales team reviewing campaign"
}
```

#### Option 2: Webhooks (MCP)

Register a callback URL to receive push notifications:
```json
{
  "tool": "create_media_buy",
  "arguments": {
    "buyer_ref": "campaign_2024",
    "packages": [...],
    "webhook_url": "https://buyer.example.com/mcp/webhooks",
    "webhook_auth_token": "bearer-token-xyz"
  }
}
```

### A2A Status Checking

A2A supports both SSE streaming and webhooks as shown in the examples above. Choose based on your needs:
- **SSE**: Best for real-time updates with persistent connection
- **Webhooks**: Best for long-running tasks or when client may disconnect

### Polling Guidelines (when using polling):
- First 10 seconds: Every 1-2 seconds
- Next minute: Every 5-10 seconds
- After 1 minute: Every 30-60 seconds
- For manual approval (when message indicates approval needed): Every 5 minutes

### Handling Pending States
Orchestrators MUST handle pending states as normal operation flow:

1. Store the context_id for tracking
2. Monitor for updates via configured method (polling, webhooks, or streaming)
3. Handle eventual completion, rejection, or manual approval

### Example Pending Operation Flow

```python
# 1. Create media buy
response = await mcp.call_tool("create_media_buy", {
    "buyer_ref": "espn_sports_q1_2024",
    "packages": [
        {
            "buyer_ref": "espn_ctv_sports",
            "product_id": "sports_ctv_premium",
            "budget": {
                "total": 30000,
                "currency": "USD",
                "pacing": "even"
            },
            "targeting_overlay": {
                "geo_country_any_of": ["US"],
                "geo_region_any_of": ["CA", "NY"],
                "axe_include_segment": "x5j7w"
            }
        },
        {
            "buyer_ref": "espn_audio_sports",
            "product_id": "audio_sports_talk",
            "budget": {
                "total": 20000,
                "currency": "USD"
            },
            "targeting_overlay": {
                "geo_country_any_of": ["US"]
            }
        }
    ],
    "promoted_offering": "ESPN+ streaming service - exclusive UFC fights and soccer leagues, promoting annual subscription",
    "po_number": "PO-2024-001",
    "start_time": "2024-02-01T00:00:00Z",
    "end_time": "2024-03-31T23:59:59Z",
    "budget": {
        "total": 50000,
        "currency": "USD",
        "pacing": "even"
    }
})

# Check if async processing is needed
if response.get("status") == "working":
    context_id = response["context_id"]
    
    # 2. Monitor for completion (polling example shown, but webhooks/streaming may be available)
    while True:
        status_response = await mcp.call_tool("create_media_buy_status", {
            "context_id": context_id
        })
        
        if status_response["status"] == "completed":
            # Operation completed successfully
            media_buy_id = status_response["media_buy_id"]
            break
        elif status_response["status"] == "failed":
            # Operation failed
            handle_error(status_response["error"])
            break
        elif status_response["status"] == "working" and "approval" in status_response.get("message", "").lower():
            # Requires human approval - may take hours/days
            notify_user_of_pending_approval(status_response)
            # Continue polling less frequently
            await sleep(300)  # Check every 5 minutes
        else:
            # Still processing
            await sleep(10)  # Poll every 10 seconds
```

## Platform Mapping

How media buy creation maps to different platforms:

- **Google Ad Manager**: Creates an Order with LineItems
- **Kevel**: Creates a Campaign with Flights
- **Triton Digital**: Creates a Campaign with Flights

## Format Workflow and Placeholder Creatives

### Why Format Specification is Required

When creating a media buy, format specification serves critical purposes:

1. **Placeholder Creation**: Publisher creates placeholder creatives in ad server with correct format specifications
2. **Validation**: System validates that selected products actually support the requested formats  
3. **Clear Expectations**: Both parties know exactly what creative formats are needed
4. **Progress Tracking**: Track which creative assets are missing vs. required
5. **Technical Setup**: Ad server configuration completed before actual creatives arrive

### Workflow Integration

The complete media buy workflow with format awareness:

```
1. list_creative_formats -> Get available format specifications
2. get_products -> Find products (returns format IDs they support)
3. Validate format compatibility -> Ensure products support desired formats  
4. create_media_buy -> Specify formats for each package (REQUIRED)
   └── Publisher creates placeholders in ad server
   └── Both sides have clear creative requirements
5. sync_creatives -> Upload actual files matching the specified formats
6. Campaign activation -> Replace placeholders with real creatives
```

### Format Validation

Publishers MUST validate that:
- All specified formats are supported by the product in each package
- Format specifications match those returned by `list_creative_formats`
- Creative requirements can be fulfilled within campaign timeline

If validation fails, return an error:
```json
{
  "error": {
    "code": "FORMAT_INCOMPATIBLE",
    "message": "Product 'ctv_sports_premium' does not support format 'audio_standard_30s'",
    "field": "packages[0].formats",
    "supported_formats": ["video_standard_30s", "video_standard_15s"]
  }
}
```

## Usage Notes

- A media buy represents a complete advertising campaign with one or more packages
- Each package is based on a single product with specific targeting, budget allocation, and format requirements
- **Format specification is required** for each package - this enables placeholder creation and validation
- Both media buys and packages have `buyer_ref` fields for the buyer's reference tracking
- The `promoted_offering` field is required and must clearly describe the advertiser and what is being promoted (see [Brief Expectations](../product-discovery/brief-expectations) for guidance)
- Publishers will validate the promoted offering against their policies before creating the media buy
- Package-level targeting overlay applies additional criteria on top of product-level targeting
- The total budget is distributed across packages based on their individual `budget` settings (or proportionally if not specified)
- Budget supports multiple currencies via ISO 4217 currency codes
- AXE segments (`axe_include_segment` and `axe_exclude_segment`) enable advanced audience targeting within the targeting overlay
- Creative assets must be uploaded before the deadline for the campaign to activate
- Pending states are normal operational states, not errors
- Orchestrators MUST NOT treat pending states as errors - they are part of normal workflow

## Policy Compliance

The `promoted_offering` is validated during media buy creation. If a policy violation is detected, the API will return an error:

```json
{
  "error": {
    "code": "POLICY_VIOLATION",
    "message": "Offering category not permitted on this publisher",
    "field": "promoted_offering",
    "suggestion": "Contact publisher for category approval process"
  }
}
```

Publishers should ensure that:
- The promoted offering aligns with the selected packages
- Any uploaded creatives match the declared offering
- The campaign complies with all applicable advertising policies

## Implementation Guide

### Generating Helpful Messages

The `message` field should provide a concise summary that includes:
- Total budget and key targeting parameters
- Expected reach or inventory details
- Clear next steps and deadlines
- Approval status and expected timelines

```python
def generate_media_buy_message(media_buy, request):
    if media_buy.status == "completed" and media_buy.creative_deadline:
        return f"Successfully created your ${request.total_budget:,} media buy targeting {format_targeting(request.targeting_overlay)}. The campaign will reach {media_buy.estimated_reach:,} users. Please upload creative assets by {format_date(media_buy.creative_deadline)} to activate the campaign."
    elif media_buy.status == "working" and media_buy.requires_approval:
        return f"Your ${request.total_budget:,} media buy has been submitted for approval. {media_buy.approval_reason}. Expected approval time is {media_buy.estimated_approval_time}. You'll receive a notification once approved."
    elif media_buy.status == "completed" and media_buy.is_live:
        return f"Great news! Your ${request.total_budget:,} campaign is now live and delivering to your target audience. Monitor performance using check_media_buy_status."
    elif media_buy.status == "rejected":
        return f"Media buy was rejected: {media_buy.rejection_reason}. Please review the requirements and resubmit."
```