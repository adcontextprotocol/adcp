---
sidebar_position: 4
title: Testing
---

# Testing Your Implementation

Comprehensive testing ensures your ACP implementation works correctly and performs well.

## Testing Framework

### Installation

```bash
npm install --save-dev @adcontextprotocol/test-suite
```

### Basic Setup

```typescript
import { ACPTestSuite } from '@adcontextprotocol/test-suite';

const testSuite = new ACPTestSuite({
  serverUrl: 'http://localhost:3000',
  credentials: {
    type: 'api_key',
    key: 'test_key_123'
  }
});
```

## Validation Tests

### Core Tool Tests

```typescript
describe('ACP Core Tools', () => {
  test('get_audiences should return valid structure', async () => {
    const result = await testSuite.validateGetAudiences({
      prompt: 'high-income sports enthusiasts'
    });
    
    expect(result.valid).toBe(true);
    expect(result.audiences).toHaveLength.greaterThan(0);
    
    // Check required fields
    result.audiences.forEach(audience => {
      expect(audience).toHaveProperty('audience_id');
      expect(audience).toHaveProperty('segment_id');
      expect(audience).toHaveProperty('name');
      expect(audience.relevance_score).toBeGreaterThanOrEqual(0);
      expect(audience.relevance_score).toBeLessThanOrEqual(1);
    });
  });
  
  test('activate_audience should handle valid requests', async () => {
    // First get an audience
    const discovery = await testSuite.getAudiences({
      prompt: 'test audience'
    });
    
    const audience = discovery.audiences[0];
    
    // Then activate it
    const result = await testSuite.validateActivateAudience({
      segment_id: audience.segment_id,
      platform: 'test_platform',
      seat: 'test_seat'
    });
    
    expect(result.valid).toBe(true);
    expect(result.activation.status).toMatch(/^(activating|active)$/);
  });
});
```

### Error Handling Tests

```typescript
describe('Error Handling', () => {
  test('should handle missing required fields', async () => {
    const result = await testSuite.callTool('get_audiences', {});
    
    expect(result.success).toBe(false);
    expect(result.error.code).toMatch(/MISSING_|REQUIRED_/);
  });
  
  test('should handle invalid segment_id', async () => {
    const result = await testSuite.callTool('activate_audience', {
      segment_id: 'invalid_segment_123',
      platform: 'test_platform',
      seat: 'test_seat'
    });
    
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('SEGMENT_NOT_FOUND');
  });
  
  test('should handle unauthorized access', async () => {
    const restrictedSuite = new ACPTestSuite({
      serverUrl: 'http://localhost:3000',
      credentials: { type: 'api_key', key: 'restricted_key' }
    });
    
    const result = await restrictedSuite.callTool('activate_audience', {
      segment_id: 'seg_123',
      platform: 'restricted_platform',
      seat: 'unauthorized_seat'
    });
    
    expect(result.success).toBe(false);
    expect(result.error.code).toMatch(/UNAUTHORIZED|FORBIDDEN/);
  });
});
```

## Performance Tests

### Response Time Tests

```typescript
describe('Performance', () => {
  test('get_audiences should respond within 2 seconds', async () => {
    const startTime = Date.now();
    
    const result = await testSuite.getAudiences({
      prompt: 'performance test audience'
    });
    
    const responseTime = Date.now() - startTime;
    
    expect(result.success).toBe(true);
    expect(responseTime).toBeLessThan(2000);
  });
  
  test('should handle concurrent requests', async () => {
    const requests = Array(10).fill(null).map((_, i) =>
      testSuite.getAudiences({ prompt: `concurrent test ${i}` })
    );
    
    const startTime = Date.now();
    const results = await Promise.all(requests);
    const totalTime = Date.now() - startTime;
    
    // All should succeed
    expect(results.every(r => r.success)).toBe(true);
    
    // Should handle concurrency efficiently
    expect(totalTime).toBeLessThan(5000);
  });
});
```

### Load Testing

```typescript
describe('Load Testing', () => {
  test('should handle sustained load', async () => {
    const duration = 30000; // 30 seconds
    const requestsPerSecond = 5;
    const startTime = Date.now();
    
    const results = [];
    
    while (Date.now() - startTime < duration) {
      const batchPromises = Array(requestsPerSecond).fill(null).map(() =>
        testSuite.getAudiences({ prompt: 'load test audience' })
      );
      
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
      
      // Wait for next second
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const successRate = results.filter(r => r.success).length / results.length;
    
    expect(successRate).toBeGreaterThan(0.95); // 95% success rate
  });
});
```

## Data Quality Tests

### Audience Data Validation

```typescript
describe('Data Quality', () => {
  test('audience sizes should be reasonable', async () => {
    const result = await testSuite.getAudiences({
      prompt: 'US adults interested in sports'
    });
    
    result.audiences.forEach(audience => {
      // Size should be positive
      expect(audience.size.count).toBeGreaterThan(0);
      
      // Size should be reasonable (not larger than total population)
      if (audience.size.unit === 'individuals') {
        expect(audience.size.count).toBeLessThan(400000000); // US population
      }
      
      // Size unit should be valid
      expect(['individuals', 'devices', 'households']).toContain(audience.size.unit);
    });
  });
  
  test('pricing should be reasonable', async () => {
    const result = await testSuite.getAudiences({
      prompt: 'premium audience for luxury brands'
    });
    
    result.audiences.forEach(audience => {
      const { cpm, rev_share } = audience.pricing;
      
      // At least one pricing model should be available
      expect(cpm !== null || rev_share !== null).toBe(true);
      
      // CPM should be reasonable if present
      if (cpm !== null) {
        expect(cpm).toBeGreaterThan(0);
        expect(cpm).toBeLessThan(1000); // $1000 CPM is extreme
      }
      
      // Revenue share should be reasonable if present
      if (rev_share !== null) {
        expect(rev_share).toBeGreaterThan(0);
        expect(rev_share).toBeLessThan(1); // 100% is the maximum
      }
    });
  });
});
```

### Relevance Testing

```typescript
describe('Relevance Scoring', () => {
  test('specific prompts should return relevant audiences', async () => {
    const testCases = [
      {
        prompt: 'luxury car buyers in major US cities',
        expectedKeywords: ['luxury', 'automotive', 'premium', 'affluent']
      },
      {
        prompt: 'parents with young children interested in education',
        expectedKeywords: ['parents', 'children', 'education', 'family']
      },
      {
        prompt: 'small business owners in healthcare industry',
        expectedKeywords: ['business', 'healthcare', 'medical', 'professional']
      }
    ];
    
    for (const testCase of testCases) {
      const result = await testSuite.getAudiences({
        prompt: testCase.prompt
      });
      
      expect(result.audiences.length).toBeGreaterThan(0);
      
      // Top result should have high relevance
      expect(result.audiences[0].relevance_score).toBeGreaterThan(0.7);
      
      // Should contain relevant keywords
      const topAudience = result.audiences[0];
      const text = `${topAudience.name} ${topAudience.description}`.toLowerCase();
      
      const hasRelevantKeywords = testCase.expectedKeywords.some(keyword =>
        text.includes(keyword.toLowerCase())
      );
      
      expect(hasRelevantKeywords).toBe(true);
    }
  });
});
```

## Integration Tests

### End-to-End Workflow

```typescript
describe('Complete Workflow', () => {
  test('should complete discovery, activation, and status check', async () => {
    // Step 1: Discovery
    const discovery = await testSuite.getAudiences({
      prompt: 'e2e test audience'
    });
    
    expect(discovery.success).toBe(true);
    expect(discovery.audiences.length).toBeGreaterThan(0);
    
    const audience = discovery.audiences[0];
    
    // Step 2: Activation (if not already live)
    let activationResult;
    if (!audience.deployment.is_live) {
      activationResult = await testSuite.activateAudience({
        segment_id: audience.segment_id,
        platform: 'test_platform',
        seat: 'test_seat'
      });
      
      expect(activationResult.success).toBe(true);
    }
    
    // Step 3: Status Check
    const statusResult = await testSuite.checkAudienceStatus({
      segment_id: audience.segment_id
    });
    
    expect(statusResult.success).toBe(true);
    expect(statusResult.audience.segment_id).toBe(audience.segment_id);
    
    // Step 4: Usage Reporting
    const usageResult = await testSuite.reportUsage({
      reporting_date: '2025-01-20',
      platform: 'test_platform',
      seat: 'test_seat',
      usage: [{
        segment_id: audience.segment_id,
        impressions: 100000,
        data_cost: 250.00
      }],
      summary: {
        total_impressions: 100000,
        total_data_cost: 250.00,
        unique_segments: 1
      }
    });
    
    expect(usageResult.success).toBe(true);
  });
});
```

### Platform Integration Tests

```typescript
describe('Platform Integration', () => {
  test('should work with multiple platforms', async () => {
    const platforms = ['scope3', 'thetradedesk', 'liveramp'];
    
    for (const platform of platforms) {
      const result = await testSuite.getAudiences({
        prompt: 'cross-platform test',
        platform: platform
      });
      
      if (result.success) {
        expect(result.audiences.length).toBeGreaterThan(0);
        
        // Check platform-specific deployment info
        result.audiences.forEach(audience => {
          if (audience.deployment.is_live) {
            expect(audience.deployment.platform).toBe(platform);
          }
        });
      }
    }
  });
});
```

## Automated Testing Pipeline

### GitHub Actions Example

```yaml
name: ACP Test Suite

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Node.js
      uses: actions/setup-node@v3
      with:
        node-version: '18'
        cache: 'npm'
    
    - name: Install dependencies
      run: npm ci
    
    - name: Start test server
      run: |
        npm run start:test &
        sleep 10  # Wait for server to start
    
    - name: Run ACP validation tests
      run: npm run test:acp
      env:
        ACP_SERVER_URL: http://localhost:3000
        ACP_TEST_CREDENTIALS: ${{ secrets.ACP_TEST_CREDENTIALS }}
    
    - name: Run performance tests
      run: npm run test:performance
    
    - name: Generate test report
      run: npm run test:report
    
    - name: Upload test results
      uses: actions/upload-artifact@v3
      with:
        name: test-results
        path: test-results/
```

### Continuous Monitoring

```typescript
// monitoring/acp-health-check.ts
import { ACPTestSuite } from '@adcontextprotocol/test-suite';

async function runHealthCheck() {
  const testSuite = new ACPTestSuite({
    serverUrl: process.env.ACP_SERVER_URL,
    credentials: JSON.parse(process.env.ACP_CREDENTIALS)
  });
  
  try {
    // Basic functionality test
    const result = await testSuite.getAudiences({
      prompt: 'health check test audience'
    });
    
    if (!result.success) {
      throw new Error(`Health check failed: ${result.error.message}`);
    }
    
    console.log('✅ ACP health check passed');
    
    // Report metrics
    await reportMetrics({
      status: 'healthy',
      response_time: result.response_time,
      audience_count: result.audiences.length
    });
    
  } catch (error) {
    console.error('❌ ACP health check failed:', error.message);
    
    await reportMetrics({
      status: 'unhealthy',
      error: error.message
    });
    
    process.exit(1);
  }
}

// Run every 5 minutes
setInterval(runHealthCheck, 5 * 60 * 1000);
runHealthCheck(); // Run immediately
```

## Test Data Management

### Mock Data Setup

```typescript
// test/setup/mock-data.ts
export const mockAudiences = [
  {
    audience_id: 'test_aud_001',
    segment_id: 'test_seg_001',
    name: 'Test Premium Sports Enthusiasts',
    description: 'Mock audience for testing purposes',
    audience_type: 'marketplace',
    provider: 'Test Provider',
    size: {
      count: 1500000,
      unit: 'individuals',
      as_of: '2025-01-15'
    },
    relevance_score: 0.85,
    relevance_rationale: 'High match for sports-related keywords',
    deployment: {
      is_live: true,
      platform: 'test_platform'
    },
    pricing: {
      cpm: 5.50,
      rev_share: null,
      currency: 'USD'
    }
  }
  // ... more mock data
];
```

### Test Environment Setup

```typescript
// test/setup/test-environment.ts
export async function setupTestEnvironment() {
  // Set up test database
  await setupTestDatabase();
  
  // Load mock data
  await loadMockAudiences();
  
  // Configure test credentials
  await setupTestCredentials();
  
  // Start test server
  return await startTestServer();
}

export async function teardownTestEnvironment() {
  await cleanupTestDatabase();
  await stopTestServer();
}
```

## Reporting

### Test Results

Generate comprehensive test reports:

```typescript
// test/reporting/test-reporter.ts
interface TestResults {
  summary: {
    total_tests: number;
    passed: number;
    failed: number;
    success_rate: number;
  };
  performance: {
    avg_response_time: number;
    max_response_time: number;
    throughput: number;
  };
  coverage: {
    tools_tested: string[];
    error_scenarios_tested: string[];
  };
}

export function generateTestReport(results: TestResults): string {
  return `
# ACP Implementation Test Report

## Summary
- Total Tests: ${results.summary.total_tests}
- Passed: ${results.summary.passed}
- Failed: ${results.summary.failed}
- Success Rate: ${(results.summary.success_rate * 100).toFixed(2)}%

## Performance
- Average Response Time: ${results.performance.avg_response_time}ms
- Maximum Response Time: ${results.performance.max_response_time}ms
- Throughput: ${results.performance.throughput} req/sec

## Coverage
- Tools Tested: ${results.coverage.tools_tested.join(', ')}
- Error Scenarios: ${results.coverage.error_scenarios_tested.join(', ')}
  `;
}
```

## Next Steps

- [Review Security Guidelines](../reference/security)
- [Submit for Certification](../reference/certification)
- [Join the Community](../community/working-group)