---
sidebar_position: 2
title: MCP Guide
---

# MCP Integration Guide

Everything you need to integrate AdCP using the Model Context Protocol.

## Quick Start

### 1. Configure Your MCP Client

```json
{
  "mcpServers": {
    "adcp": {
      "command": "npx",
      "args": ["adcp-mcp-server"],
      "env": {
        "ADCP_API_KEY": "your-api-key"
      }
    }
  }
}
```

### 2. Make Your First Call

```javascript
// Discover products
const result = await mcp.call('get_products', {
  brief: "Video campaign for pet owners",
  promoted_offering: "Premium dog food"
});

console.log(result.message);
// "Found 12 video products with CPMs from $25-65"
```

### 3. Create a Media Buy

```javascript
const mediaBuy = await mcp.call('create_media_buy', {
  packages: ["pkg_ctv_001", "pkg_audio_002"],
  promoted_offering: "Premium dog food - grain free",
  total_budget: 50000
});

console.log(mediaBuy.media_buy_id);
// "mb_12345"
```

## MCP Response Format

All MCP responses follow this structure:

```json
{
  "message": "Human-readable summary",
  "context_id": "ctx-abc123",
  "data": {
    // Structured response data
  },
  "errors": []  // Non-fatal warnings
}
```

### Key Fields
- **message**: Always present, human-readable summary
- **data**: Structured data for programmatic use
- **context_id**: Maintains conversation state
- **errors**: Non-fatal issues or warnings

## Common Tasks

### Product Discovery

```javascript
// With natural language brief
const result = await mcp.call('get_products', {
  brief: "CTV campaign targeting sports fans, $100K budget",
  promoted_offering: "Sports betting app"
});

// With structured filters
const result = await mcp.call('get_products', {
  promoted_offering: "Sports betting app",
  filters: {
    format_types: ["video"],
    delivery_type: "guaranteed",
    min_spend: 25000
  }
});
```

### Getting Creative Formats

```javascript
const formats = await mcp.call('list_creative_formats');
// Returns supported creative specifications
```

### Creating Media Buys

```javascript
const mediaBuy = await mcp.call('create_media_buy', {
  packages: ["pkg_001"],
  promoted_offering: "Product description",
  total_budget: 50000,
  po_number: "PO-2024-001"
});

// Check status (async operations)
if (mediaBuy.task_id) {
  // Poll for completion
  const status = await mcp.call('get_task_status', {
    task_id: mediaBuy.task_id
  });
}
```

### Adding Creatives

```javascript
const result = await mcp.call('add_creative_assets', {
  media_buy_id: "mb_12345",
  creative_assets: [{
    name: "Hero Video 30s",
    format: "video_16x9_30s",
    url: "https://cdn.example.com/video.mp4"
  }]
});
```

## Handling Responses

### Successful Response
```javascript
const result = await mcp.call('get_products', {...});

if (result.data.products.length > 0) {
  // Process products
  result.data.products.forEach(product => {
    console.log(`${product.name}: $${product.cpm} CPM`);
  });
}
```

### Clarification Response
```javascript
const result = await mcp.call('get_products', {
  brief: "Video ads"  // Minimal brief
});

if (result.data.clarification_needed) {
  console.log(result.message);
  // "Could you share your budget and target audience?"
  
  // Provide more details
  const refined = await mcp.call('get_products', {
    context_id: result.context_id,
    brief: "Video ads, $50K budget, targeting parents"
  });
}
```

### Error Response
```javascript
try {
  const result = await mcp.call('create_media_buy', {...});
} catch (error) {
  if (error.code === 'invalid_parameter') {
    console.error(error.message);
    // Handle validation error
  }
}
```

## Context Management

MCP maintains conversation context automatically:

```javascript
// First call - no context
const result1 = await mcp.call('get_products', {
  brief: "Sports campaign"
});

// Follow-up - include context
const result2 = await mcp.call('get_products', {
  context_id: result1.context_id,
  brief: "Focus on CTV products"
});
// System remembers previous interaction
```

## Async Operations

Some operations take time. MCP handles these with task IDs:

```javascript
const result = await mcp.call('create_media_buy', {...});

if (result.task_id) {
  // Operation is async
  let status;
  do {
    await sleep(2000);  // Wait 2 seconds
    status = await mcp.call('get_task_status', {
      task_id: result.task_id
    });
    console.log(status.progress.message);
  } while (status.status === 'processing');
  
  if (status.status === 'completed') {
    console.log('Media buy created:', status.data.media_buy_id);
  }
}
```

## Best Practices

### 1. Always Handle the Message Field
```javascript
// Good - use message for user feedback
console.log(result.message);

// Also process structured data
if (result.data) {
  processData(result.data);
}
```

### 2. Maintain Context
```javascript
let contextId = null;

async function query(brief) {
  const result = await mcp.call('get_products', {
    context_id: contextId,
    brief
  });
  contextId = result.context_id;  // Save for next call
  return result;
}
```

### 3. Handle Clarifications Gracefully
```javascript
async function getProducts(brief, details = {}) {
  const result = await mcp.call('get_products', {
    brief,
    ...details
  });
  
  if (result.data.clarification_needed) {
    // Prompt for missing information
    const moreDetails = await promptUser(result.message);
    return getProducts(brief, moreDetails);
  }
  
  return result;
}
```

## Complete Example

Here's a full workflow using MCP:

```javascript
async function createCampaign() {
  // 1. Discover products
  const products = await mcp.call('get_products', {
    brief: "Q1 CTV campaign for luxury cars, $200K budget",
    promoted_offering: "BMW Series 5 - The ultimate driving machine"
  });
  
  console.log(products.message);
  
  // 2. Select products and create media buy
  const selectedProducts = products.data.products
    .filter(p => p.cpm <= 50)
    .map(p => p.product_id);
  
  const mediaBuy = await mcp.call('create_media_buy', {
    packages: selectedProducts,
    promoted_offering: "BMW Series 5",
    total_budget: 200000,
    po_number: "BMW-Q1-2024"
  });
  
  // 3. Wait for creation
  if (mediaBuy.task_id) {
    const final = await waitForTask(mediaBuy.task_id);
    console.log(`Created: ${final.data.media_buy_id}`);
    
    // 4. Add creatives
    await mcp.call('add_creative_assets', {
      media_buy_id: final.data.media_buy_id,
      creative_assets: [
        {
          name: "BMW Hero 30s",
          format: "video_16x9_30s",
          url: "https://cdn.bmw.com/hero-30s.mp4"
        }
      ]
    });
  }
}
```

## Troubleshooting

### Common Issues

**"Context not found"**
- Context expires after 1 hour
- Start a new conversation without context_id

**"Invalid parameter"**
- Check required fields in task documentation
- Ensure correct data types

**"Task timeout"**
- Long operations may timeout
- Implement proper polling with backoff

## Next Steps

- Explore available [Media Buy Tasks](../media-buy/tasks/get_products.md)
- Learn about [Signals](../signals/overview.md)
- See [Error Codes](../reference/error-codes.md) reference
- Review [Authentication](../reference/authentication.md) options

## Need More Detail?

Most users only need this guide. For deep technical specifications, see the [Reference](../reference/data-models.md) section.