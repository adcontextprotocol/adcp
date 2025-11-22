# Response Validation Guide

## Two Types of Validation

We provide two validators with different purposes:

### 1. `validateResponseShape()` - For Documentation

**Purpose**: Ensure docs match API contract (structure and types only)

**Use when**:
- Writing documentation examples
- Testing against varying data
- Validating response structure hasn't changed

**Example**:
```javascript
const expectedResponse = {
  products: [{
    product_id: "connected_tv_premium",
    name: "Connected TV - Premium Sports",
    delivery_type: "guaranteed",
    pricing_options: [{
      type: "cpm",
      price_micro_usd: 25000000
    }]
  }]
};

// Only validates structure and types, not actual values
validateResponseShape(actualResponse, expectedResponse);
```

**What it checks**:
- ✅ All documented fields present
- ✅ Types match (string, number, boolean, array, object)
- ✅ Nested structure correct
- ❌ NOT actual values (IDs, prices, messages vary)

### 2. `validateResponse()` - For Integration Tests

**Purpose**: Thoroughly validate actual response data

**Use when**:
- Writing integration tests
- Testing specific scenarios
- Validating business logic

**Example**:
```javascript
const constraints = {
  shape: {
    products: [{
      product_id: "string",
      delivery_type: "string",
      pricing_options: [{
        price_micro_usd: 0
      }]
    }]
  },
  enums: {
    'products.0.delivery_type': ['guaranteed', 'non_guaranteed']
  },
  ranges: {
    'products.0.pricing_options.0.price_micro_usd': { min: 0 }
  },
  patterns: {
    'products.0.product_id': /^[a-z_]+$/
  },
  consistency: [
    (actual, path) => {
      const product = actual.products[0];
      if (product.delivery_type === 'guaranteed' && !product.delivery_measurement) {
        throw new Error(`${path}: Guaranteed products must have delivery_measurement`);
      }
    }
  ]
};

validateResponse(actualResponse, constraints);
```

**What it checks**:
- ✅ Everything validateResponseShape checks
- ✅ Enum values are valid
- ✅ Numeric ranges make sense
- ✅ String patterns match
- ✅ Custom consistency rules

## When to Use Which

### Documentation Examples → `validateResponseShape()`

```javascript
// In docs/media-buy/task-reference/get_products.mdx
const result = await testAgent.getProducts({
  brief: 'Premium athletic footwear'
});

// Shows users what response looks like
const expectedResponse = {
  products: [{
    product_id: "connected_tv_premium",
    name: "Connected TV - Premium Sports",
    // ... realistic example data
  }]
};

// Validates structure matches (values can vary)
validateResponseShape(result.data, expectedResponse);
```

### Integration Tests → `validateResponse()`

```javascript
// In tests/integration/get-products.test.js
test('get_products returns valid guaranteed products', async () => {
  const result = await testAgent.getProducts({
    filters: { delivery_type: 'guaranteed' }
  });

  validateResponse(result.data, {
    shape: { products: [{ delivery_type: 'string' }] },
    enums: {
      'products.0.delivery_type': ['guaranteed', 'non_guaranteed']
    },
    consistency: [
      (actual) => {
        // All products must be guaranteed
        actual.products.forEach(p => {
          if (p.delivery_type !== 'guaranteed') {
            throw new Error('Expected only guaranteed products');
          }
        });
      }
    ]
  });
});
```

## Best Practices

### For Documentation
1. Use real, representative example data (not "string", "number")
2. Show complete structures (nested objects, arrays)
3. Use `validateResponseShape()` to catch structural changes
4. Keep validation commented out in docs (runs in tests)

### For Integration Tests
1. Use `validateResponse()` with strict constraints
2. Test enum values match spec
3. Verify numeric ranges make sense
4. Add consistency rules for business logic
5. Test error cases too

## Example: Complete Documentation Pattern

```javascript
// Request
const result = await testAgent.getProducts({
  brief: 'Premium athletic footwear with innovative cushioning',
  brand_manifest: {
    name: 'Nike',
    url: 'https://nike.com'
  }
});

// Expected response (shown to users)
const expectedResponse = {
  products: [{
    product_id: "connected_tv_premium",
    name: "Connected TV - Premium Sports",
    description: "Premium CTV inventory during live sports programming",
    publisher_properties: [{
      publisher_domain: "sports-network.com",
      property_ids: ["live-nfl", "live-nba"]
    }],
    format_ids: ["video_15s_vast", "video_30s_vast"],
    delivery_type: "guaranteed",
    delivery_measurement: {
      metric: "impressions",
      min_exposures: 1000000
    },
    pricing_options: [{
      type: "cpm",
      price_micro_usd: 25000000  // $25.00 CPM
    }],
    brief_relevance: "Premium sports inventory matches your athletic footwear campaign"
  }]
};

// Validation (runs in test suite, not visible in rendered docs)
validateResponseShape(result.data, expectedResponse);
```

This way:
- ✅ Users see real, concrete response data
- ✅ Tests validate structure matches docs
- ✅ Breaking API changes caught automatically
- ✅ Flexible enough to work across test runs
