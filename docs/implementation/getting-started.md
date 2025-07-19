---
sidebar_position: 1
title: Getting Started
---

# Implementation Guide

This guide helps platform providers implement the Ad Context Protocol for their advertising systems.

## Overview

Implementing ACP involves:
1. Setting up MCP server endpoints
2. Implementing the four core tools
3. Handling authentication and authorization
4. Testing with the validation suite

## Prerequisites

- Familiarity with [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- Existing audience/advertising platform APIs
- Understanding of your platform's authentication system

## Quick Start

### 1. Install MCP Server Framework

```bash
npm install @modelcontextprotocol/server
```

### 2. Implement Core Tools

Your MCP server needs to implement these four tools:

```typescript
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer({
  name: "your-platform-acp",
  version: "1.0.0"
});

// Register the four required tools
server.tool("get_audiences", getAudiencesHandler);
server.tool("activate_audience", activateAudienceHandler);
server.tool("check_audience_status", checkAudienceStatusHandler);  
server.tool("report_usage", reportUsageHandler);
```

### 3. Implement get_audiences

This is typically the most complex endpoint:

```typescript
async function getAudiencesHandler(params: any) {
  const { prompt, platform, seat, filters, max_results } = params;
  
  // 1. Parse natural language prompt
  const intent = await parseMarketingIntent(prompt);
  
  // 2. Search your audience catalog
  const matches = await searchAudiences(intent, filters);
  
  // 3. Check deployment status for platform/seat
  const audiences = await Promise.all(
    matches.map(audience => enrichWithDeployment(audience, platform, seat))
  );
  
  // 4. Calculate relevance scores
  return {
    success: true,
    audiences: audiences.slice(0, max_results || 5)
  };
}
```

### 4. Add Authentication

```typescript
server.setAuthHandler(async (credentials) => {
  // Validate credentials and determine account type
  const account = await validateCredentials(credentials);
  
  return {
    accountType: account.type, // 'platform' or 'customer'
    permissions: account.permissions,
    availablePlatforms: account.platforms
  };
});
```

## Implementation Checklist

### Core Requirements

- [ ] Implement all four required tools
- [ ] Handle natural language prompt parsing
- [ ] Support both platform and customer account types
- [ ] Provide accurate relevance scoring
- [ ] Include proper error handling

### Data Requirements

- [ ] Audience size reporting with units
- [ ] Pricing information (CPM/revenue share)
- [ ] Deployment status tracking
- [ ] Real-time activation monitoring

### Testing

- [ ] Unit tests for each tool
- [ ] Integration tests with real data
- [ ] Performance testing with large catalogs
- [ ] Error scenario validation

## Architecture Patterns

### Prompt Processing

Most implementations use a multi-stage approach:

1. **Intent Extraction**: Extract marketing objectives from natural language
2. **Taxonomy Mapping**: Map to your platform's audience categories
3. **Filtering**: Apply size, pricing, and availability filters
4. **Ranking**: Score and rank by relevance

### Deployment Tracking

Track audience deployment across platforms:

```typescript
interface DeploymentStatus {
  segmentId: string;
  platform: string;
  seat: string;
  status: 'deployed' | 'pending' | 'not_deployed';
  deployedAt?: Date;
  estimatedReadyTime?: string;
}
```

### Usage Aggregation

For billing and reporting:

```typescript
interface UsageReport {
  reportingDate: string;
  platform: string;
  seat: string;
  usage: UsageEntry[];
  summary: UsageSummary;
}
```

## Best Practices

### Performance

- **Cache frequently accessed data** (audience catalogs, pricing)
- **Async processing** for time-consuming operations
- **Pagination** for large result sets
- **Rate limiting** to protect backend systems

### Security

- **Validate all inputs** especially natural language prompts
- **Sanitize outputs** to prevent data leakage
- **Audit logging** for all activation and usage events
- **Scope permissions** by account type and platform access

### User Experience

- **Meaningful relevance scores** with explanations
- **Clear error messages** with actionable guidance
- **Consistent response times** (< 2 seconds for discovery)
- **Helpful descriptions** for audiences and pricing

## Testing Your Implementation

### Validation Suite

Run the ACP validation suite against your implementation:

```bash
npm install @adcontextprotocol/validator
npx acp-validate --server your-mcp-server-url
```

### Test Cases

Essential test scenarios:

1. **Natural Language Parsing**
   - "High-income millennials interested in luxury travel"
   - "Small business owners in healthcare industry"
   - "Parents with young children who shop online"

2. **Error Handling**
   - Invalid segment IDs
   - Unauthorized platform access
   - Already activated audiences

3. **Edge Cases**
   - Empty result sets
   - Very large audiences
   - Multiple pricing options

## Platform Integration Examples

### LiveRamp Integration

```typescript
async function searchLiveRampAudiences(intent: MarketingIntent) {
  const response = await liveRampAPI.search({
    demographics: intent.demographics,
    interests: intent.interests,
    behaviors: intent.behaviors
  });
  
  return response.segments.map(segment => ({
    audience_id: segment.id,
    name: segment.name,
    description: segment.description,
    size: {
      count: segment.individualCount,
      unit: 'individuals'
    },
    pricing: {
      cpm: segment.cpm,
      currency: 'USD'
    }
  }));
}
```

### The Trade Desk Integration

```typescript
async function activateOnTTD(segmentId: string, seat: string) {
  const activation = await ttdAPI.createAudience({
    partnerId: segmentId,
    advertiserId: seat,
    name: `ACP_${segmentId}_${seat}`
  });
  
  return {
    success: true,
    activation: {
      segment_id: segmentId,
      platform: 'thetradedesk',
      seat: seat,
      status: 'activating',
      activation_id: activation.id
    }
  };
}
```

## Next Steps

1. [Review Authentication Patterns](./authentication)
2. [Implement Best Practices](./best-practices)  
3. [Set Up Testing](./testing)
4. [Submit for Certification](../reference/certification)

## Getting Help

- **Technical Questions**: GitHub Discussions
- **Implementation Support**: support@adcontextprotocol.org
- **Certification Process**: certification@adcontextprotocol.org