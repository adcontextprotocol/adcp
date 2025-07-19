---
sidebar_position: 3
title: Best Practices
---

# Implementation Best Practices

## Performance Optimization

### Caching Strategies

Cache frequently accessed data to improve response times:

```typescript
// Audience catalog caching
const audienceCache = new Map();

async function getCachedAudiences(cacheKey: string) {
  if (audienceCache.has(cacheKey)) {
    const cached = audienceCache.get(cacheKey);
    if (Date.now() - cached.timestamp < 300000) { // 5 minute TTL
      return cached.data;
    }
  }
  
  const fresh = await loadAudiencesFromDatabase();
  audienceCache.set(cacheKey, {
    data: fresh,
    timestamp: Date.now()
  });
  
  return fresh;
}
```

### Async Processing

Handle time-consuming operations asynchronously:

```typescript
async function activateAudienceHandler(params: any) {
  // Start activation process
  const activationId = await startActivation(params);
  
  // Return immediately with pending status
  return {
    success: true,
    activation: {
      activation_id: activationId,
      status: 'activating',
      estimated_ready_time: '2025-01-21T10:00:00Z'
    }
  };
}

// Background processing
async function processActivation(activationId: string) {
  try {
    await performActualActivation(activationId);
    await updateActivationStatus(activationId, 'active');
  } catch (error) {
    await updateActivationStatus(activationId, 'failed');
  }
}
```

## Error Handling

### Consistent Error Format

Use a standardized error response format:

```typescript
interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
    retry_after?: number;
  };
}

function createError(code: string, message: string, details?: any): ErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details
    }
  };
}
```

### Graceful Degradation

Handle partial failures gracefully:

```typescript
async function getAudiencesHandler(params: any) {
  const results = [];
  const errors = [];
  
  // Try multiple data sources
  const sources = ['primary', 'secondary', 'cache'];
  
  for (const source of sources) {
    try {
      const audiences = await fetchFromSource(source, params);
      results.push(...audiences);
      break; // Success, no need to try other sources
    } catch (error) {
      errors.push({ source, error: error.message });
    }
  }
  
  if (results.length === 0) {
    return createError('ALL_SOURCES_FAILED', 'Unable to fetch audiences', { errors });
  }
  
  return {
    success: true,
    audiences: results,
    warnings: errors.length > 0 ? { fallback_used: true, errors } : undefined
  };
}
```

## Data Quality

### Input Validation

Validate all inputs thoroughly:

```typescript
function validateGetAudiencesParams(params: any) {
  const errors = [];
  
  // Required fields
  if (!params.prompt || typeof params.prompt !== 'string') {
    errors.push('prompt is required and must be a string');
  }
  
  if (params.prompt && params.prompt.length > 1000) {
    errors.push('prompt must be less than 1000 characters');
  }
  
  // Optional fields
  if (params.max_results && (typeof params.max_results !== 'number' || params.max_results < 1 || params.max_results > 50)) {
    errors.push('max_results must be a number between 1 and 50');
  }
  
  if (params.filters) {
    if (params.filters.max_cpm && (typeof params.filters.max_cpm !== 'number' || params.filters.max_cpm < 0)) {
      errors.push('max_cpm must be a positive number');
    }
  }
  
  if (errors.length > 0) {
    throw new Error(`Validation failed: ${errors.join(', ')}`);
  }
}
```

### Output Sanitization

Ensure consistent output format:

```typescript
function sanitizeAudienceResponse(audience: any) {
  return {
    audience_id: String(audience.id),
    segment_id: String(audience.segment_id),
    name: audience.name?.slice(0, 100) || 'Unnamed Audience',
    description: audience.description?.slice(0, 500) || '',
    audience_type: ['marketplace', 'owned', 'destination'].includes(audience.type) ? audience.type : 'marketplace',
    provider: String(audience.provider || 'Unknown'),
    size: {
      count: Math.max(0, Math.floor(audience.size?.count || 0)),
      unit: ['individuals', 'devices', 'households'].includes(audience.size?.unit) ? audience.size.unit : 'individuals',
      as_of: audience.size?.as_of || new Date().toISOString().split('T')[0]
    },
    relevance_score: Math.max(0, Math.min(1, audience.relevance_score || 0)),
    pricing: {
      cpm: audience.pricing?.cpm > 0 ? Number(audience.pricing.cpm.toFixed(2)) : null,
      rev_share: audience.pricing?.rev_share > 0 ? Number(audience.pricing.rev_share.toFixed(3)) : null,
      currency: audience.pricing?.currency || 'USD'
    }
  };
}
```

## Security

### Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
const rateLimiter = new Map();

function checkRateLimit(accountId: string, tool: string): boolean {
  const key = `${accountId}:${tool}`;
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const maxRequests = 100;
  
  if (!rateLimiter.has(key)) {
    rateLimiter.set(key, { requests: [], windowStart: now });
  }
  
  const bucket = rateLimiter.get(key);
  
  // Remove old requests outside the window
  bucket.requests = bucket.requests.filter((timestamp: number) => now - timestamp < windowMs);
  
  if (bucket.requests.length >= maxRequests) {
    return false; // Rate limit exceeded
  }
  
  bucket.requests.push(now);
  return true;
}
```

### Data Sanitization

Prevent injection attacks:

```typescript
function sanitizePrompt(prompt: string): string {
  // Remove potentially dangerous characters
  return prompt
    .replace(/[<>]/g, '') // Remove angle brackets
    .replace(/['"]/g, '') // Remove quotes
    .replace(/[;]/g, '')  // Remove semicolons
    .slice(0, 1000);      // Limit length
}

function sanitizeFilters(filters: any): any {
  const safe: any = {};
  
  if (filters.max_cpm && typeof filters.max_cpm === 'number' && filters.max_cpm > 0) {
    safe.max_cpm = Math.min(filters.max_cpm, 1000); // Cap at $1000 CPM
  }
  
  if (filters.min_size && typeof filters.min_size === 'number' && filters.min_size > 0) {
    safe.min_size = Math.max(filters.min_size, 1000); // Minimum 1K audience
  }
  
  if (Array.isArray(filters.regions)) {
    safe.regions = filters.regions
      .filter((r: any) => typeof r === 'string' && r.length <= 10)
      .slice(0, 20); // Max 20 regions
  }
  
  return safe;
}
```

## Monitoring and Logging

### Structured Logging

Use structured logging for better observability:

```typescript
interface LogEvent {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  tool: string;
  account_id: string;
  duration_ms?: number;
  success: boolean;
  metadata?: any;
}

function logToolCall(tool: string, accountId: string, success: boolean, durationMs: number, metadata?: any) {
  const event: LogEvent = {
    timestamp: new Date().toISOString(),
    level: success ? 'info' : 'error',
    tool,
    account_id: accountId,
    duration_ms: durationMs,
    success,
    metadata
  };
  
  console.log(JSON.stringify(event));
}
```

### Metrics Collection

Track key performance indicators:

```typescript
class MetricsCollector {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();
  
  increment(metric: string, value = 1) {
    this.counters.set(metric, (this.counters.get(metric) || 0) + value);
  }
  
  timing(metric: string, value: number) {
    if (!this.histograms.has(metric)) {
      this.histograms.set(metric, []);
    }
    this.histograms.get(metric)!.push(value);
  }
  
  // Track key metrics
  trackToolCall(tool: string, success: boolean, durationMs: number) {
    this.increment(`tool.${tool}.calls`);
    this.increment(`tool.${tool}.${success ? 'success' : 'error'}`);
    this.timing(`tool.${tool}.duration`, durationMs);
  }
}
```

## Testing Strategies

### Unit Testing

Test individual components:

```typescript
describe('Input Validation', () => {
  test('should validate required prompt', () => {
    expect(() => validateGetAudiencesParams({}))
      .toThrow('prompt is required');
  });
  
  test('should reject overly long prompts', () => {
    const longPrompt = 'a'.repeat(1001);
    expect(() => validateGetAudiencesParams({ prompt: longPrompt }))
      .toThrow('prompt must be less than 1000 characters');
  });
});
```

### Integration Testing

Test complete workflows:

```typescript
describe('Audience Discovery Flow', () => {
  test('should complete full discovery and activation', async () => {
    // Discover audiences
    const discovery = await getAudiences({
      prompt: 'test audience'
    });
    
    expect(discovery.success).toBe(true);
    expect(discovery.audiences.length).toBeGreaterThan(0);
    
    // Activate first audience
    const activation = await activateAudience({
      segment_id: discovery.audiences[0].segment_id,
      platform: 'test_platform',
      seat: 'test_seat'
    });
    
    expect(activation.success).toBe(true);
    expect(activation.activation.status).toBe('activating');
  });
});
```

### Load Testing

Test performance under load:

```typescript
describe('Performance', () => {
  test('should handle concurrent requests', async () => {
    const requests = Array(100).fill(null).map(() =>
      getAudiences({ prompt: 'test concurrent load' })
    );
    
    const startTime = Date.now();
    const results = await Promise.all(requests);
    const endTime = Date.now();
    
    // All requests should succeed
    expect(results.every(r => r.success)).toBe(true);
    
    // Should complete within reasonable time
    expect(endTime - startTime).toBeLessThan(5000);
  });
});
```

## Deployment

### Health Checks

Implement health check endpoints:

```typescript
server.tool('health_check', async () => {
  const checks = {
    database: await checkDatabase(),
    external_apis: await checkExternalAPIs(),
    cache: await checkCache()
  };
  
  const healthy = Object.values(checks).every(check => check.status === 'ok');
  
  return {
    success: healthy,
    timestamp: new Date().toISOString(),
    checks
  };
});

async function checkDatabase() {
  try {
    await db.query('SELECT 1');
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}
```

### Configuration Management

Use environment-based configuration:

```typescript
interface Config {
  database: {
    host: string;
    port: number;
    database: string;
  };
  external_apis: {
    liveramp: {
      base_url: string;
      timeout_ms: number;
    };
  };
  rate_limits: {
    get_audiences: number;
    activate_audience: number;
  };
}

const config: Config = {
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'acp'
  },
  external_apis: {
    liveramp: {
      base_url: process.env.LIVERAMP_API_URL || 'https://api.liveramp.com',
      timeout_ms: parseInt(process.env.LIVERAMP_TIMEOUT || '30000')
    }
  },
  rate_limits: {
    get_audiences: parseInt(process.env.RATE_LIMIT_GET_AUDIENCES || '100'),
    activate_audience: parseInt(process.env.RATE_LIMIT_ACTIVATE || '10')
  }
};
```

## Next Steps

- [Set Up Testing](./testing)
- [Review Security Guidelines](../reference/security)
- [Submit for Certification](../reference/certification)